import json
import re

from haystack.dataclasses import ChatMessage

from app.config.settings import get_settings
from app.config.llm import openai_tools_compat_kwargs, resolve_llm
from app.conversation.context_manager import ConversationContextManager
from app.haystack.agents.conversational_agent import get_conversational_agent
import tiktoken
from app.haystack.tools.knowledge_tool import set_default_filters, clear_default_filters

counter = tiktoken.encoding_for_model("gpt-4o-mini")

_EMPTY_ANSWER_FALLBACK = (
    "I don’t have enough information to provide an accurate answer."
)
_RETRY_NUDGE = (
    "Your previous reply was empty. Provide a valid, non-empty answer to the "
    "user's question now. Never return an empty response. If you lack "
    "information, reply exactly: "
    f'"{_EMPTY_ANSWER_FALLBACK}"'
)

# Reject LLM hallucinations like frontmatter["policy_number"] or {{policy_number}}.
_INVALID_META_RE = re.compile(
    r"(frontmatter|metadata|payload|locals?|globals?|self|this)\s*[\[\(]"
    r"|^\{\{.*\}\}$"
    r"|^[A-Za-z_][\w.]*\[[\"'].*[\"']\]$"
    r"|^(null|none|undefined|n/?a)$",
    re.IGNORECASE,
)


class ChatService:
    def __init__(self):
        settings = get_settings()

        self.context_manager = ConversationContextManager(
            max_recent_messages=settings.max_recent_messages,
        )

    def chat(
        self,
        message: str,
        recent_messages: list[dict] | None = None,
        summary: str | None = None,
        conversation_id: str | None = None,
        policy_number: str | None = None,
        policy_name: str | None = None,
        company_name: str | None = None,
        insurer_name: str | None = None,
        categories: str | None = None,
    ) -> dict:
        if not message or not message.strip():
            raise ValueError("Message cannot be empty.")
        messages = self.context_manager.build_messages(
            current_message=message,
            recent_messages=recent_messages,
            summary=summary,
        )
        print("========== AGENT INPUT ==========")

        total_tokens = 0
        total_chars = 0

        for index, msg in enumerate(messages, start=1):
            # ChatMessage.content is a list of TextContent objects
            content = ""

            if msg._content:
                for item in msg._content:
                    if hasattr(item, "text"):
                        content += item.text

            token_count = len(counter.encode(content))
            char_count = len(content)

            total_tokens += token_count
            total_chars += char_count

        print(
            f"AGENT INPUT TOTAL "
            f"chars={total_chars} "
            f"tokens={total_tokens}"
        )

        print("=================================")
        agent = get_conversational_agent(categories=categories)
        # Set per-request default filters so retrieval picks up policy/company scoping
        try:
            set_default_filters(
                {
                    "policy_number": policy_number,
                    "policy_name": policy_name,
                    "company_name": company_name,
                    "insurer_name": insurer_name,
                    "conversation_id": conversation_id,
                }
            )
            # gpt-6-luna rejects tools unless reasoning_effort is explicitly none.
            _provider, _model = resolve_llm("chat")
            _gen_kw = (
                openai_tools_compat_kwargs(_model)
                if _provider == "openai"
                else {}
            )
            result = agent.run(
                messages=messages,
                generation_kwargs=_gen_kw or None,
            )
            response = self._build_response(
                result,
                request_policy_number=policy_number,
            )

            # Empty LLM answer → one automatic retry with an explicit nudge.
            if not str(response.get("answer") or "").strip():
                print(
                    "[chat] empty answer from LLM; retrying once with non-empty nudge"
                )
                retry_messages = list(messages) + [
                    ChatMessage.from_user(_RETRY_NUDGE)
                ]
                result = agent.run(
                    messages=retry_messages,
                    generation_kwargs=_gen_kw or None,
                )
                response = self._build_response(
                    result,
                    request_policy_number=policy_number,
                )
                if not str(response.get("answer") or "").strip():
                    print(
                        "[chat] empty answer after retry; using unavailable-information fallback"
                    )
                    response["answer"] = _EMPTY_ANSWER_FALLBACK
        finally:
            clear_default_filters()

        # Compact summary only — do not dump full ChatMessage / system prompt text.
        try:
            msgs = result.get("messages", []) or []
            roles = []
            for m in msgs:
                role = str(getattr(m, "role", "") or "")
                text = getattr(m, "text", "") or ""
                roles.append(f"{role}:{len(text)}")
            print(
                f"AGENT RESULT messages={len(msgs)} "
                f"sizes=[{', '.join(roles)}] "
                f"token_usage={result.get('token_usage')}"
            )
        except Exception:
            print(f"AGENT RESULT keys={list(result.keys()) if isinstance(result, dict) else type(result)}")

        print(
            "CHAT REQUEST FILTERS "
            f"policy_number={policy_number!r} "
            f"policy_name={policy_name!r} "
            f"company_name={company_name!r} "
            f"insurer_name={insurer_name!r} "
            f"conversation_id={conversation_id!r}"
        )
        return response

    @staticmethod
    def _extract_token_usage(result: dict) -> dict:
        usage = result.get("token_usage") or {}
        if not isinstance(usage, dict):
            usage = {}
        prompt = int(
            usage.get("prompt_tokens")
            or usage.get("input_tokens")
            or 0
        )
        completion = int(
            usage.get("completion_tokens")
            or usage.get("output_tokens")
            or 0
        )
        total = int(usage.get("total_tokens") or (prompt + completion))
        return {
            "prompt_tokens": prompt,
            "completion_tokens": completion,
            "total_tokens": total,
        }

    @staticmethod
    def _sanitize_meta_string(value) -> str:
        """Keep only plain string meta values; drop placeholders / code-like junk."""
        if value is None:
            return ""
        if not isinstance(value, str):
            if isinstance(value, (int, float, bool)):
                return str(value)
            return ""
        text = value.strip()
        if not text:
            return ""
        if _INVALID_META_RE.search(text):
            return ""
        # Unquoted / template leftovers
        if any(ch in text for ch in ("{", "}", "[", "]")) and not re.match(
            r"^[\w./\-]+$", text
        ):
            return ""
        return text

    @staticmethod
    def _repair_meta_json_candidate(candidate: str) -> str:
        """
        Repair common LLM meta-JSON mistakes, e.g.
        {"policy_number":frontmatter["policy_number"],"category":"","usedSources":[]}
        """
        fixed = candidate.strip().replace("'", '"')

        # Unquoted code-like values, e.g. frontmatter["policy_number"] → ""
        for key in ("policy_number", "category"):
            fixed = re.sub(
                rf'"{key}"\s*:\s*[A-Za-z_][\w.]*\[[^\]]*\]',
                f'"{key}":""',
                fixed,
            )
            fixed = re.sub(
                rf'"{key}"\s*:\s*(?!null\b|true\b|false\b|"|-?\d)[^,\}}]+',
                f'"{key}":""',
                fixed,
            )

        # usedSources must be an array; coerce junk to []
        fixed = re.sub(
            r'"usedSources"\s*:\s*(?!\[)[^,\}\]]+',
            '"usedSources":[]',
            fixed,
            flags=re.IGNORECASE,
        )
        # Bare tokens inside usedSources → keep numeric indices only
        def _fix_sources(match: re.Match) -> str:
            items = []
            for part in re.split(r",\s*", match.group(2)):
                p = part.strip().strip('"')
                if re.fullmatch(r"-?\d+", p):
                    items.append(p)
            return f"{match.group(1)}[{','.join(items)}]"

        fixed = re.sub(
            r'("usedSources"\s*:\s*)\[\s*([^\]\[]*?)\s*\]',
            _fix_sources,
            fixed,
            flags=re.IGNORECASE,
        )
        return fixed

    @classmethod
    def _extract_trailing_meta(
        cls, raw: str
    ) -> tuple[str, dict | None]:
        """
        Split answer text from trailing meta JSON.
        Always strip a trailing `{...}` meta block from the visible answer,
        even when the JSON is invalid / unrepaired.
        """
        text = raw or ""
        parsed: dict | None = None

        # Whole reply as JSON
        try:
            whole = json.loads(text.strip())
            if isinstance(whole, dict) and (
                "policy_number" in whole
                or "usedSources" in whole
                or "category" in whole
            ):
                answer = str(whole.get("answer") or "").strip()
                return answer or "", whole
        except Exception:
            pass

        # Fenced ```json ... ```
        fenced_m = re.search(
            r"```(?:json)?\s*([\s\S]*?)\s*```", text, flags=re.IGNORECASE
        )
        if fenced_m:
            candidate = fenced_m.group(1).strip()
            idx = candidate.find("{")
            if idx != -1:
                candidate = candidate[idx:]
            for attempt in (candidate, cls._repair_meta_json_candidate(candidate)):
                try:
                    obj = json.loads(attempt)
                    if isinstance(obj, dict):
                        answer = text[: fenced_m.start()].strip()
                        return answer, obj
                except Exception:
                    continue
            # Still strip the fence from the answer
            text = text[: fenced_m.start()].strip()

        # Trailing / last JSON object
        braces = [m.start() for m in re.finditer(r"\{", text)]
        for start in reversed(braces):
            candidate = text[start:].strip()
            if "policy_number" not in candidate and "usedSources" not in candidate:
                continue
            for attempt in (candidate, cls._repair_meta_json_candidate(candidate)):
                try:
                    obj = json.loads(attempt)
                    if isinstance(obj, dict):
                        answer = text[:start].strip()
                        answer = re.sub(r"```(?:json)?\s*$", "", answer).strip()
                        return answer, obj
                except Exception:
                    continue
            # Invalid meta JSON — still remove it from the user-visible answer
            answer = text[:start].strip()
            answer = re.sub(r"```(?:json)?\s*$", "", answer).strip()
            return answer, None

        return text.strip(), parsed

    @classmethod
    def _build_response(
        cls,
        result: dict,
        request_policy_number: str | None = None,
    ) -> dict:
        messages = result.get("messages", [])
        token_usage = cls._extract_token_usage(result)

        if not messages:
            return {
                "policy_number": request_policy_number or "",
                "category": "",
                "answer": "",
                "sources": [],
                "usedSources": [],
                "token_usage": token_usage,
            }

        final_message = messages[-1]
        raw = final_message.text or ""
        answer_text, parsed_full = cls._extract_trailing_meta(raw)

        policy_number_val = ""
        category_val = ""
        used_sources_list: list[dict] = []

        if isinstance(parsed_full, dict):
            policy_number_val = cls._sanitize_meta_string(
                parsed_full.get("policy_number", "")
            )
            category_val = cls._sanitize_meta_string(
                parsed_full.get("category", "")
            )
            answer_field = parsed_full.get("answer", "") or ""
            used_indices = (
                parsed_full.get("usedSources")
                or parsed_full.get("usedsources")
                or []
            )
            if not isinstance(used_indices, list):
                used_indices = []

            if isinstance(answer_field, str):
                try:
                    inner = json.loads(answer_field)
                    if isinstance(inner, dict) and "answer" in inner:
                        answer_field = inner.get("answer", "")
                except Exception:
                    pass

            if answer_field and str(answer_field).strip():
                answer_text = str(answer_field).strip()

            try:
                from app.haystack.tools.knowledge_tool import search_knowledge

                docs = getattr(search_knowledge, "_last_documents", []) or []
            except Exception:
                docs = []

            for idx in used_indices:
                try:
                    i = int(idx) - 1
                    if 0 <= i < len(docs):
                        doc = docs[i]
                        meta = getattr(doc, "meta", {}) or {}
                        content = (
                            getattr(doc, "content", None)
                            or meta.get("text", "")
                            or ""
                        )
                        snippet = content[:100] if content else ""
                        snippet = (
                            snippet.replace("\n", " ").replace("\r", "").strip()
                            + "..."
                        )
                        # Qdrant points store the PDF name under meta.document.*
                        # Do not use meta.source — that is "admin"/"customer".
                        nested_doc = meta.get("document") or {}
                        if not isinstance(nested_doc, dict):
                            nested_doc = {}
                        document_name = (
                            nested_doc.get("filename")
                            or nested_doc.get("file_name")
                            or meta.get("filename")
                            or meta.get("file_name")
                            or meta.get("document_name")
                            or meta.get("documentName")
                            or ""
                        )
                        used_sources_list.append(
                            {
                                "index": idx,
                                "documentId": meta.get("documentId")
                                or meta.get("document_id"),
                                "documentName": document_name or None,
                                "chunkId": meta.get("chunkId")
                                or meta.get("chunk_id"),
                                "pageNumber": meta.get("pageNumber")
                                or meta.get("page_number"),
                                "score": getattr(doc, "score", None)
                                or meta.get("score"),
                                "snippet": snippet,
                            }
                        )
                except Exception:
                    continue

        if not policy_number_val and request_policy_number:
            policy_number_val = str(request_policy_number).strip()

        # No retrieval evidence → empty sources (small talk / self-answered)
        if not used_sources_list:
            used_sources_list = []

        if not str(answer_text or "").strip():
            answer_text = raw.strip() or _EMPTY_ANSWER_FALLBACK

        return {
            "policy_number": policy_number_val,
            "category": category_val,
            "answer": answer_text,
            "sources": [],
            "usedSources": used_sources_list,
            "token_usage": token_usage,
        }

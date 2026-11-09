import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

os.environ["FAQ_Ai_API_KEY"] = "test-key"

import numpy as np
import pytest
from docx import Document
from fastapi.testclient import TestClient

from app.ingestion.sectioner import make_sections, make_titles_unique
from app.main import app
from app.services import dedupe, faq_generator, summarizer


# ------------------------------------------------------------ fake LLM / embed
def fake_llm(prompt, opts):
    """Prompt la summary kekkudha FAQ kekkudha nu paathu JSON kudukkum."""
    if '"summary"' in prompt and "faqs" not in prompt:
        body = {"summary": "The excess is 500 and the policy covers accidental damage to the car."}
    else:
        body = {
            "faqs": [
                {
                    "question": "How much is the excess?",
                    "answer": "The excess you pay on each claim is 500 as written in the policy.",
                    "scope": "specific",
                    "category": "",
                },
                {
                    "question": "Can I cancel my policy?",
                    "answer": "You may cancel the policy at any time by writing to the company.",
                    "scope": "global",
                    "category": "not-in-list",
                },
            ]
        }
    return {"message": {"content": json.dumps(body)}}


def fake_embed(texts):
    texts = list(texts)
    rng = np.random.default_rng(0)
    return rng.normal(size=(len(texts), 8)).astype(np.float32)


@pytest.fixture(autouse=True)
def patch_llm(monkeypatch):
    monkeypatch.setattr(faq_generator, "call_llm", fake_llm)
    monkeypatch.setattr(summarizer, "call_llm", fake_llm)
    monkeypatch.setattr(dedupe, "embed", lambda t: _unit(fake_embed(t)))


def _unit(v):
    return v / np.linalg.norm(v, axis=1, keepdims=True)


# ------------------------------------------------------------------ sectioner
def test_titles_unique_even_when_heading_repeats():
    secs = [{"title": "Overview"}, {"title": "overview "}, {"title": "Overview"}]
    titles = [s["title"] for s in make_titles_unique(secs)]
    assert titles == ["Overview", "overview (2)", "Overview (3)"]
    assert len({t.lower().strip() for t in titles}) == 3


def test_flat_text_is_chunked_within_limits():
    para = "Clause text that goes on for a while and ends properly. "
    blocks = [
        {"text": f"{i}.1 {para * 3}", "page": 1 + i // 20, "is_heading": False}
        for i in range(120)
    ]
    sections, method = make_sections(blocks)
    assert method == "size_based"
    assert len(sections) > 1
    assert all(len(s["text"]) >= 900 for s in sections)
    assert max(len(s["text"]) for s in sections) < 4500
    assert len({s["title"] for s in sections}) == len(sections)


# ------------------------------------------------------------------- generator
def test_generator_trims_category_and_adds_metadata():
    section = {
        "title": "Excess and premium",
        "text": "The excess you pay on each claim is 500. You may cancel the policy at any time by writing to the company.",
        "pages": [2, 3],
    }
    faqs, dropped, ok = faq_generator.generate_faqs(section, section_id="doc-s1")
    assert ok
    by_scope = {f["scope"]: f for f in faqs}
    assert by_scope["specific"]["category"] == "Other"  # category "" -> Other
    assert by_scope["global"]["category"] == "Other"
    assert by_scope["specific"]["section_type"] == "pricing"
    assert by_scope["specific"]["page_refs"] == [2, 3]
    assert by_scope["specific"]["prompt_version"].endswith(":pricing")


def test_generator_uses_user_categories():
    section = {
        "title": "Excess and premium",
        "text": "The excess you pay on each claim is 500. You may cancel the policy at any time by writing to the company.",
        "pages": [2, 3],
    }
    # fake_llm returns not-in-list / "" → map to Other when taxonomy is provided
    faqs, _, ok = faq_generator.generate_faqs(
        section, section_id="doc-s1", categories=["Claims", "Payments", "Other"]
    )
    assert ok and all(f["category"] == "Other" for f in faqs)


def test_clean_category_matches_user_list_case_insensitively():
    cats = ["Claims", "Payment Methods", "Other"]
    assert faq_generator.clean_category(" payment methods ", cats) == "Payment Methods"
    assert faq_generator.clean_category("claims", cats) == "Claims"
    assert faq_generator.clean_category("other", cats) == "Other"
    assert faq_generator.clean_category("", cats) == "Other"
    assert faq_generator.clean_category("Invented", cats) == "Other"


def test_prompt_lists_only_user_categories():
    prompt = faq_generator.build_prompt("T", "text", "general", ["Claims", "Payments"])
    assert '"Claims", "Payments"' in prompt and "pricing" not in prompt
    assert '"category": "..."' in prompt


def test_prompt_always_asks_for_category():
    prompt = faq_generator.build_prompt("T", "text", "general", None)
    assert '"category": "..."' in prompt
    assert "Other" in prompt


def test_parse_categories():
    from app.api.routes import parse_categories

    assert parse_categories(["[\"Claims\", \" claims \", \"Payments\"]"]) == [
        "Claims",
        "Payments",
    ]
    assert parse_categories(["Claims", "Payments"]) == ["Claims", "Payments"]
    assert parse_categories([]) is None and parse_categories(None) is None


def test_summary_has_page_range_and_rejects_invented_numbers(monkeypatch):
    section = {
        "title": "Excess",
        "text": "The excess is 500. The policy covers accidental damage to the car.",
        "pages": [4, 5, 6],
    }
    s = summarizer.summarize_section(section, "doc-s1")
    assert (s["page_start"], s["page_end"]) == (4, 6)

    bad = {"message": {"content": json.dumps({"summary": "The excess is 9999 for every single claim made."})}}
    monkeypatch.setattr(summarizer, "call_llm", lambda p, o: bad)
    assert summarizer.summarize_section(section, "doc-s1") is None


# ------------------------------------------------------------------------ API
def make_docx(path):
    doc = Document()
    doc.add_heading("Overview", 1)
    body = (
        "The excess you pay on each claim is 500. "
        "You may cancel the policy at any time by writing to the company. "
        "The policy covers accidental damage to the car. "
    )
    doc.add_paragraph(body * 10)
    doc.add_heading("Excess", 1)
    doc.add_paragraph(body * 10)
    doc.save(path)


HEADERS = {"x-api-key": "test-key"}


def submit(client, path, route="/generate-faqs", document_id="doc-123"):
    data = {"document_id": document_id} if document_id else {}
    with open(path, "rb") as f:
        return client.post(route, files={"file": ("p.docx", f)}, data=data, headers=HEADERS)


def wait_done(client, job_id, timeout=15):
    end = time.time() + timeout
    while time.time() < end:
        job = client.get(f"/jobs/{job_id}", headers=HEADERS).json()
        if job["status"] in ("completed", "failed"):
            return job
        time.sleep(0.05)
    raise AssertionError("job did not finish")


@pytest.fixture
def docx_path(tmp_path):
    path = tmp_path / "p.docx"
    make_docx(path)
    return path


def test_api_needs_key(docx_path):
    client = TestClient(app)
    for route in ("/generate-faqs", "/regenerate-faqs"):
        with open(docx_path, "rb") as f:  # key illa
            r = client.post(route, files={"file": ("p.docx", f)}, data={"document_id": "x"})
        assert r.status_code == 401 and "missing" in r.json()["detail"]
        with open(docx_path, "rb") as f:  # key thappu
            r = client.post(
                route,
                files={"file": ("p.docx", f)},
                data={"document_id": "x"},
                headers={"x-api-key": "wrong-key"},
            )
        assert r.status_code == 401 and r.json()["detail"] == "Invalid API key"
    assert client.get("/jobs/whatever").status_code == 401
    assert client.get("/jobs/whatever", headers={"x-api-key": "wrong"}).status_code == 401
    assert client.get("/health").status_code == 200  # health ku key vendaam
    assert client.get("/jobs/whatever", headers=HEADERS).status_code == 404


def test_generate_job_flow_and_separate_lists(docx_path):
    client = TestClient(app)
    r = submit(client, docx_path)
    assert r.status_code == 202
    first = r.json()
    assert first["status"] in ("queued", "parsing", "generating", "completed")
    assert first["document_id"] == "doc-123" and first["duplicate"] is False

    job = wait_done(client, first["job_id"])
    assert job["status"] == "completed"
    assert job["progress"]["sections_done"] == job["progress"]["sections_total"] > 0

    body = job["result"]
    # /generate-faqs is FAQs-only; summaries come from /generate-summary (customer).
    assert set(body) == {
        "document_id", "file_name", "general_faqs", "specific_faqs",
        "skipped_sections", "stats",
    }
    assert "section_summaries" not in body
    assert body["stats"].get("summaries", 0) == 0
    for g in body["general_faqs"]:
        assert g["document_id"] == "doc-123" and g["category"]
    for sp in body["specific_faqs"]:
        assert sp["document_id"] == "doc-123" and sp["section_id"].startswith("doc-123-s")


def test_same_file_same_document_is_duplicate(docx_path):
    client = TestClient(app)
    a = submit(client, docx_path, document_id="dup-1").json()
    wait_done(client, a["job_id"])

    b = submit(client, docx_path, document_id="dup-1").json()  # same file + same id
    assert b["job_id"] == a["job_id"] and b["duplicate"] is True

    c = submit(client, docx_path, document_id="dup-2").json()  # vera document id
    assert c["job_id"] != a["job_id"] and c["duplicate"] is False
    wait_done(client, c["job_id"])


def test_regenerate_runs_again_with_faqs_only(docx_path):
    client = TestClient(app)
    a = submit(client, docx_path, document_id="reg-1").json()
    wait_done(client, a["job_id"])

    # document_id illa na reject
    with open(docx_path, "rb") as f:
        r = client.post("/regenerate-faqs", files={"file": ("p.docx", f)}, headers=HEADERS)
    assert r.status_code == 422

    b = submit(client, docx_path, route="/regenerate-faqs", document_id="reg-1").json()
    assert b["job_id"] != a["job_id"] and b["duplicate"] is False  # mudinja job irundhaalum puthusa
    job = wait_done(client, b["job_id"])
    assert job["mode"] == "regenerate"
    assert "section_summaries" not in job["result"]
    assert job["result"]["stats"]["summaries"] == 0


def test_failed_job_reports_error_and_can_retry(tmp_path):
    client = TestClient(app)
    bad = tmp_path / "bad.docx"
    bad.write_bytes(b"this is not a real docx")
    a = submit(client, bad, document_id="bad-1").json()
    job = wait_done(client, a["job_id"])
    assert job["status"] == "failed" and job["error"]
    assert "result" not in job

    b = submit(client, bad, document_id="bad-1").json()  # failed job reuse aagaadhu
    assert b["job_id"] != a["job_id"]
    wait_done(client, b["job_id"])


# ------------------------------------------------------------------- callback
@pytest.fixture
def receiver():
    """App-api maari oru chinna server, vandha callbacks ah save pannum."""
    received = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = self.rfile.read(int(self.headers["Content-Length"]))
            received.append(
                {
                    "headers": {k.lower(): v for k, v in self.headers.items()},
                    "body": json.loads(body),
                }
            )
            self.send_response(200)
            self.end_headers()

        def log_message(self, *args):
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield received, f"http://127.0.0.1:{server.server_port}/faq/callback"
    server.shutdown()


def wait_callback(client, job_id, wanted, timeout=15):
    end = time.time() + timeout
    while time.time() < end:
        job = client.get(f"/jobs/{job_id}", headers=HEADERS).json()
        if job["callback"]["status"] == wanted:
            return job
        time.sleep(0.05)
    raise AssertionError(f"callback never became {wanted}")


def test_callback_sends_result_when_job_completes(monkeypatch, receiver, docx_path):
    import app.jobs as jobs

    received, url = receiver
    monkeypatch.setattr(jobs, "CALLBACK_URL", url)
    monkeypatch.setattr(jobs, "CALLBACK_API_KEY", "app-api-key")

    client = TestClient(app)
    job_id = submit(client, docx_path, document_id="cb-1").json()["job_id"]
    wait_callback(client, job_id, "sent")

    assert len(received) == 1
    msg = received[0]
    assert msg["headers"]["x-api-key"] == "app-api-key"
    assert msg["headers"]["x-callback-secret"] == "app-api-key"
    assert msg["body"]["event"] == "job.completed"
    assert msg["body"]["job_id"] == job_id and msg["body"]["document_id"] == "cb-1"
    assert msg["body"]["result"]["specific_faqs"] or msg["body"]["result"]["general_faqs"]
    assert "section_summaries" not in msg["body"]["result"]

    # same file thirumba kuduthaa: job reuse + callback thirumba varum
    again = submit(client, docx_path, document_id="cb-1").json()
    assert again["duplicate"] is True
    end = time.time() + 10
    while len(received) < 2 and time.time() < end:
        time.sleep(0.05)
    assert len(received) == 2


def test_callback_failure_is_reported_after_retries(monkeypatch, docx_path):
    import app.jobs as jobs

    monkeypatch.setattr(jobs, "CALLBACK_URL", "http://127.0.0.1:9/nothing-here")
    monkeypatch.setattr(jobs, "CALLBACK_ATTEMPTS", 2)
    monkeypatch.setattr(jobs, "CALLBACK_RETRY_SECONDS", 0)

    client = TestClient(app)
    job_id = submit(client, docx_path, document_id="cb-2").json()["job_id"]
    job = wait_callback(client, job_id, "failed")
    assert job["status"] == "completed"  # callback fail aanaalum job result polling la kedaikum
    assert job["callback"]["attempts"] == 2 and job["callback"]["error"]


def test_failed_job_sends_failed_event(monkeypatch, receiver, tmp_path):
    import app.jobs as jobs

    received, url = receiver
    monkeypatch.setattr(jobs, "CALLBACK_URL", url)
    bad = tmp_path / "bad.docx"
    bad.write_bytes(b"not a docx")

    client = TestClient(app)
    job_id = submit(client, bad, document_id="cb-3").json()["job_id"]
    wait_callback(client, job_id, "sent")
    assert received[0]["body"]["event"] == "job.failed"
    assert received[0]["body"]["error"] and "result" not in received[0]["body"]
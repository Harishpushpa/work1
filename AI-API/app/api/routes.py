import hashlib
import json
import os
import secrets
import shutil
import tempfile
import time
import uuid
from typing import List, Optional

from fastapi import APIRouter, File, Form, Header, HTTPException, Request, UploadFile

from app.core.config import API_KEY, MAX_UPLOAD_MB
from app.jobs import job_manager

ALLOWED_EXT = {".pdf", ".docx"}

router = APIRouter()


def _log(msg: str) -> None:
    print(f"[faq-api] {msg}", flush=True)


def verify_api_key(provided: Optional[str]):
    if not API_KEY:  
        raise HTTPException(status_code=500, detail="Server API key is not configured")
    if not provided:
        raise HTTPException(status_code=401, detail="API key missing. Send it in the x-api-key header")
    if not secrets.compare_digest(provided.encode(), API_KEY.encode()):
        raise HTTPException(status_code=401, detail="Invalid API key")


def save_upload(file: UploadFile):
    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in ALLOWED_EXT:
        raise HTTPException(status_code=400, detail="Only PDF or DOCX files are allowed")

    tmp_dir = tempfile.mkdtemp()
    path = os.path.join(tmp_dir, "upload" + ext)
    digest = hashlib.sha256()
    try:
        size, limit = 0, MAX_UPLOAD_MB * 1024 * 1024
        with open(path, "wb") as out:
            while chunk := file.file.read(1024 * 1024):
                size += len(chunk)
                if size > limit:
                    raise HTTPException(
                        status_code=413, detail=f"File larger than {MAX_UPLOAD_MB} MB"
                    )
                digest.update(chunk)
                out.write(chunk)
    except Exception:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        raise
    return tmp_dir, path, digest.hexdigest()


def parse_categories(raw):
    
    if not raw:
        return None
    items = []
    for entry in raw:
        entry = (entry or "").strip()
        if entry.startswith("["):
            try:
                data = json.loads(entry)
            except ValueError:
                raise HTTPException(status_code=400, detail="categories must be a list of names")
            if not isinstance(data, list):
                raise HTTPException(status_code=400, detail="categories must be a list of names")
            items.extend(data)
        else:
            items.append(entry)
    seen, names = set(), []
    for item in items:
        name = str(item).strip()[:150]
        if name and name.lower() not in seen:
            seen.add(name.lower())
            names.append(name)
    return names[:100] or None


def parse_elements(raw: Optional[str]):
    """JSON array of extraction elements from the pipeline (document_pages)."""
    if raw is None or not str(raw).strip():
        return None
    try:
        data = json.loads(raw)
    except ValueError as exc:
        raise HTTPException(
            status_code=400, detail="elements must be a JSON array"
        ) from exc
    if not isinstance(data, list) or not data:
        raise HTTPException(
            status_code=400, detail="elements must be a non-empty JSON array"
        )
    return data


def _parse_bool(raw: Optional[str], default: bool = False) -> bool:
    if raw is None or str(raw).strip() == "":
        return default
    return str(raw).strip().lower() in ("1", "true", "yes", "on")


def queue_upload(
    file: Optional[UploadFile],
    document_id,
    kind,
    force,
    categories=None,
    elements=None,
    skip_dedupe=False,
):
    t0 = time.perf_counter()
    doc_id = document_id or str(uuid.uuid4())
    if isinstance(elements, str):
        elements = parse_elements(elements)

    _log(
        f"accept kind={kind} force={force} skip_dedupe={skip_dedupe} "
        f"file={(file.filename if file else None)!r} "
        f"document_id={doc_id} elements={len(elements) if elements else 0}"
    )
    if (not file or not file.filename) and not elements:
        raise HTTPException(
            status_code=400,
            detail="Provide file and/or elements (extraction JSON)",
        )

    categories = parse_categories(categories)
    if categories:
        _log(f"categories n={len(categories)} sample={categories[:5]}")
    else:
        _log("categories=none (LLM will use free-form / Other)")

    tmp_dir = None
    path = None
    file_name = None
    if file and file.filename:
        tmp_dir, path, file_hash = save_upload(file)
        file_name = file.filename
        save_ms = int((time.perf_counter() - t0) * 1000)
        try:
            size = os.path.getsize(path)
        except OSError:
            size = -1
        _log(
            f"upload saved path={path} size={size}B hash={file_hash[:12]}… "
            f"elapsedMs={save_ms}"
        )
    else:
        # Prefer extraction payload — hash elements for dedupe identity.
        payload = json.dumps(elements, sort_keys=True, ensure_ascii=False).encode(
            "utf-8"
        )
        file_hash = hashlib.sha256(payload).hexdigest()
        file_name = f"{doc_id}.extraction.json"
        _log(
            f"elements-only submit n={len(elements)} hash={file_hash[:12]}…"
        )

    job, duplicate = job_manager.submit(
        path=path,
        tmp_dir=tmp_dir,
        file_name=file_name,
        document_id=doc_id,
        file_hash=file_hash,
        kind=kind,
        force=force,
        categories=categories,
        elements=elements,
        skip_dedupe=skip_dedupe,
    )
    total_ms = int((time.perf_counter() - t0) * 1000)
    _log(
        f"queued job_id={job['job_id']} document_id={job['document_id']} "
        f"status={job['status']} duplicate={duplicate} "
        f"elements={len(elements) if elements else 0} elapsedMs={total_ms}"
    )
    return {
        "job_id": job["job_id"],
        "document_id": job["document_id"],
        "status": job["status"],
        "duplicate": duplicate,
        "used_extraction": bool(elements),
    }


@router.get("/health")
def health():
    return {"status": "ok"}


@router.post("/generate-faqs", status_code=202)
def generate_faqs_route(
    file: Optional[UploadFile] = File(default=None),
    document_id: Optional[str] = Form(default=None),
    categories: Optional[List[str]] = Form(default=None),
    elements: Optional[str] = Form(default=None),
    skip_dedupe: Optional[str] = Form(default=None),
    x_api_key: Optional[str] = Header(default=None),
):
    verify_api_key(x_api_key)
    return queue_upload(
        file,
        document_id,
        kind="faq",
        force=False,
        categories=categories,
        elements=parse_elements(elements),
        skip_dedupe=_parse_bool(skip_dedupe, False),
    )


@router.post("/dedupe-faqs", status_code=202)
async def dedupe_faqs_route(
    request: Request,
    x_api_key: Optional[str] = Header(default=None),
):
    """
    Embed-dedupe only (no LLM). JSON body: FAQ generate result
    (general_faqs / specific_faqs). Separate pipeline step so retries after
    dedupe timeout do not re-run section LLM calls.
    """
    verify_api_key(x_api_key)
    try:
        payload = await request.json()
    except Exception as exc:
        raise HTTPException(status_code=400, detail="JSON body required") from exc
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="JSON object required")

    doc_id = str(payload.get("document_id") or uuid.uuid4())
    blob = json.dumps(payload, sort_keys=True, ensure_ascii=False).encode("utf-8")
    file_hash = hashlib.sha256(blob).hexdigest()
    job, duplicate = job_manager.submit(
        path=None,
        tmp_dir=None,
        file_name=str(payload.get("file_name") or f"{doc_id}.faqs.json"),
        document_id=doc_id,
        file_hash=file_hash,
        kind="faq_dedupe",
        force=True,
        dedupe_payload=payload,
    )
    return {
        "job_id": job["job_id"],
        "document_id": job["document_id"],
        "status": job["status"],
        "duplicate": duplicate,
    }


@router.post("/generate-summary", status_code=202)
def generate_summary_route(
    file: Optional[UploadFile] = File(default=None),
    document_id: Optional[str] = Form(default=None),
    elements: Optional[str] = Form(default=None),
    x_api_key: Optional[str] = Header(default=None),
):
    verify_api_key(x_api_key)
    return queue_upload(
        file,
        document_id,
        kind="summary",
        force=False,
        elements=parse_elements(elements),
    )


@router.post("/regenerate-faqs", status_code=202)
def regenerate_faqs_route(
    file: Optional[UploadFile] = File(default=None),
    document_id: str = Form(...),
    categories: Optional[List[str]] = Form(default=None),
    elements: Optional[str] = Form(default=None),
    x_api_key: Optional[str] = Header(default=None),
):
    verify_api_key(x_api_key)
    return queue_upload(
        file,
        document_id,
        kind="faq",
        force=True,
        categories=categories,
        elements=parse_elements(elements),
    )


@router.get("/jobs/{job_id}")
def job_status_route(job_id: str, x_api_key: Optional[str] = Header(default=None)):
    verify_api_key(x_api_key)
    job = job_manager.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job
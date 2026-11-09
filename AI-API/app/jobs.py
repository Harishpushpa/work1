import json
import queue
import shutil
import threading
import time
import urllib.request
import uuid
from datetime import datetime, timezone

from app.core.config import (
    CALLBACK_API_KEY,
    CALLBACK_ATTEMPTS,
    CALLBACK_RETRY_SECONDS,
    CALLBACK_URL,
    FAQ_CALLBACK_URL,
    JOBS_KEEP,
    SUMMARY_CALLBACK_URL,
)
from app.pipeline.pipeline import (
    dedupe_faq_result,
    process_faqs,
    process_summaries,
)


def callback_url_for(kind):
    """Resolve callback URL for app-api (/api/faqs/internal/callback) or shared CALLBACK_URL."""
    if kind == "summary":
        return SUMMARY_CALLBACK_URL or CALLBACK_URL
    return FAQ_CALLBACK_URL or CALLBACK_URL


QUEUED, PARSING, GENERATING, COMPLETED, FAILED = (
    "queued",
    "parsing",
    "generating",
    "completed",
    "failed",
)
ACTIVE = {QUEUED, PARSING, GENERATING}


def _now():
    return datetime.now(timezone.utc).isoformat()


def _log(msg: str) -> None:
    print(f"[faq-job] {msg}", flush=True)


class JobManager:

    def __init__(self):
        self._jobs = {}
        self._queue = queue.Queue()
        self._lock = threading.Lock()
        self._worker = None

    # ---------------------------------------------------------------- submit
    def submit(
        self,
        path,
        tmp_dir,
        file_name,
        document_id,
        file_hash,
        kind,
        force,
        categories=None,
        elements=None,
        skip_dedupe=False,
        dedupe_payload=None,
    ):
        with self._lock:
            # Dedupe-only jobs are never content-hash duplicates of generate.
            if kind != "faq_dedupe":
                existing = self._find_duplicate(document_id, file_hash, kind, force)
                if existing:
                    if tmp_dir:
                        shutil.rmtree(tmp_dir, ignore_errors=True)  # puthu upload vendaam
                    _log(
                        f"duplicate hit job_id={existing['job_id']} "
                        f"document_id={document_id} status={existing['status']} kind={kind}"
                    )
                    if existing["status"] == COMPLETED:  # app-api callback ku wait pannum, so thirumba anuppu
                        self._notify(existing)
                    return self._view(existing), True

            if kind == "faq_dedupe":
                mode = "dedupe"
            elif kind == "summary":
                mode = "summary"
            else:
                mode = "regenerate" if force else "generate"

            job = {
                "job_id": str(uuid.uuid4()),
                "document_id": document_id,
                "file_name": file_name,
                "file_hash": file_hash,
                "mode": mode,
                "status": QUEUED,
                "progress": {"sections_done": 0, "sections_total": None, "current_section": None},
                "error": None,
                "callback": {
                    "status": "pending" if callback_url_for(kind) else "not_configured",
                    "attempts": 0,
                    "error": None,
                },
                "result": None,
                "created_at": _now(),
                "finished_at": None,
                "_path": path,
                "_tmp_dir": tmp_dir,
                "_kind": kind,  # "faq", "faq_dedupe", or "summary"
                "_categories": categories or None,
                "_elements": elements or None,
                "_skip_dedupe": bool(skip_dedupe),
                "_dedupe_payload": dedupe_payload,
            }
            self._jobs[job["job_id"]] = job
            qsize = self._queue.qsize() + 1
            self._queue.put(job["job_id"])
            self._start_worker()
            self._evict()
            _log(
                f"enqueued job_id={job['job_id']} document_id={document_id} "
                f"kind={kind} mode={job['mode']} queue_depth≈{qsize}"
            )
            return self._view(job), False

    def _find_duplicate(self, document_id, file_hash, kind, force):
        same = [
            j
            for j in self._jobs.values()
            if j["document_id"] == document_id
            and j["file_hash"] == file_hash
            and j["_kind"] == kind
        ]
        if not same:
            return None
        latest = max(same, key=lambda j: j["created_at"])
        if latest["status"] in ACTIVE:  # already process aagudhu
            return latest
        if latest["status"] == COMPLETED and not force:  
            return latest
        return None  

    # ------------------------------------------------------------------- read
    def get(self, job_id):
        with self._lock:
            job = self._jobs.get(job_id)
            return self._view(job) if job else None

    def _view(self, job):
        view = {k: v for k, v in job.items() if not k.startswith("_")}
        view["callback"] = dict(job["callback"])
        if job["status"] != COMPLETED:
            view.pop("result")  # result mudinja apram mattum
        return view

    # ----------------------------------------------------------------- worker
    def _start_worker(self):
        if self._worker is None or not self._worker.is_alive():
            self._worker = threading.Thread(target=self._run_forever, daemon=True)
            self._worker.start()

    def _run_forever(self):
        while True:
            job_id = self._queue.get()
            with self._lock:
                job = self._jobs.get(job_id)
            if job:
                self._run(job)

    def _update(self, job, **fields):
        with self._lock:
            job.update(fields)

    def _run(self, job):
        t0 = time.perf_counter()
        last_stage = {"name": QUEUED, "at": t0}

        def progress(stage, done=None, total=None, title=None):
            now = time.perf_counter()
            stage_ms = int((now - last_stage["at"]) * 1000)
            with self._lock:
                job["status"] = stage
                if total is not None:
                    job["progress"] = {
                        "sections_done": done,
                        "sections_total": total,
                        "current_section": title,
                    }
            section = f" section={title!r}" if title else ""
            counts = (
                f" {done}/{total}"
                if done is not None and total is not None
                else ""
            )
            _log(
                f"job_id={job['job_id']} stage={stage}{counts}{section} "
                f"(+{stage_ms}ms since {last_stage['name']}, "
                f"total={int((now - t0) * 1000)}ms)"
            )
            last_stage["name"] = stage
            last_stage["at"] = now

        elements = job.get("_elements")
        _log(
            f"start job_id={job['job_id']} document_id={job['document_id']} "
            f"kind={job['_kind']} mode={job['mode']} file={job['file_name']!r} "
            f"elements={len(elements) if elements else 0}"
        )
        try:
            if job["_kind"] == "summary":
                result = process_summaries(
                    job["_path"],
                    document_id=job["document_id"],
                    source_name=job["file_name"],
                    progress=progress,
                    elements=elements,
                )
            elif job["_kind"] == "faq_dedupe":
                result = dedupe_faq_result(
                    job.get("_dedupe_payload") or {},
                    progress=progress,
                )
            else:
                # /generate-faqs and /regenerate-faqs: FAQs only.
                # Summaries are a separate customer step via /generate-summary
                # (admin never needs them — avoid paying LLM cost here).
                result = process_faqs(
                    job["_path"],
                    document_id=job["document_id"],
                    source_name=job["file_name"],
                    progress=progress,
                    categories=job["_categories"],
                    elements=elements,
                    skip_dedupe=bool(job.get("_skip_dedupe")),
                )
            elapsed_ms = int((time.perf_counter() - t0) * 1000)
            stats = (result or {}).get("stats") or {}
            _log(
                f"completed job_id={job['job_id']} elapsedMs={elapsed_ms} "
                f"faqs={stats.get('final')} sections={stats.get('sections')} "
                f"summaries={stats.get('summaries')}"
            )
            self._update(job, status=COMPLETED, result=result, finished_at=_now())
        except Exception as e:
            elapsed_ms = int((time.perf_counter() - t0) * 1000)
            _log(
                f"FAILED job_id={job['job_id']} elapsedMs={elapsed_ms} "
                f"{type(e).__name__}: {str(e)[:200]}"
            )
            # #region agent log
            try:
                from app.debug_agent_log import agent_log

                agent_log(
                    "D",
                    "jobs.py:job_failed",
                    "FAQ/summary job failed",
                    {
                        "jobId": job.get("job_id"),
                        "kind": job.get("_kind"),
                        "excType": type(e).__name__,
                        "exc": str(e)[:200],
                        "elapsedMs": elapsed_ms,
                        "progress": job.get("progress"),
                    },
                )
            except Exception:
                pass
            # #endregion
            self._update(
                job,
                status=FAILED,
                error=f"{type(e).__name__}: {str(e)[:200]}",
                finished_at=_now(),
            )
        finally:
            if job.get("_tmp_dir"):
                shutil.rmtree(job["_tmp_dir"], ignore_errors=True)
        self._notify(job)

    # --------------------------------------------------------------- callback
    def _notify(self, job):
        if callback_url_for(job["_kind"]):  # thaniya thread, worker adutha job ku pogalaam
            threading.Thread(
                target=self._send_callback, args=(job["job_id"],), daemon=True
            ).start()

    def _set_callback(self, job_id, **fields):
        with self._lock:
            job = self._jobs.get(job_id)
            if job:
                job["callback"].update(fields)

    def _send_callback(self, job_id):
        """Job mudinja result ah CALLBACK_URL ku POST. Fail aana retry, appavum fail na status la theriyum."""
        with self._lock:
            job = self._jobs.get(job_id)
            if not job:
                return
            job["callback"] = {"status": "pending", "attempts": 0, "error": None}
            callback_url = callback_url_for(job["_kind"])
            # kind = "faq" / "summary", result = full output (completed na mattum)
            payload = {
                "event": f"job.{job['status']}",
                "kind": job["_kind"],
                **self._view(job),
            }
            payload.pop("callback")
        body = json.dumps(payload).encode()

        headers = {"Content-Type": "application/json"}
        if CALLBACK_API_KEY:
            headers["x-api-key"] = CALLBACK_API_KEY
            headers["x-callback-secret"] = CALLBACK_API_KEY

        error = None
        for attempt in range(1, CALLBACK_ATTEMPTS + 1):
            try:
                req = urllib.request.Request(
                    callback_url, data=body, headers=headers, method="POST"
                )
                with urllib.request.urlopen(req, timeout=30) as resp:
                    if 200 <= resp.status < 300:
                        self._set_callback(job_id, status="sent", attempts=attempt, error=None)
                        return
                    error = f"HTTP {resp.status}"
            except Exception as e:  # connection, timeout, non-2xx ellam
                error = f"{type(e).__name__}: {str(e)[:120]}"
            self._set_callback(job_id, attempts=attempt, error=error)
            if attempt < CALLBACK_ATTEMPTS:
                time.sleep(CALLBACK_RETRY_SECONDS)
        self._set_callback(job_id, status="failed")

    def _evict(self):
        extra = len(self._jobs) - JOBS_KEEP
        if extra <= 0:
            return
        finished = sorted(
            (j for j in self._jobs.values() if j["status"] not in ACTIVE),
            key=lambda j: j["created_at"],
        )
        for j in finished[:extra]:
            del self._jobs[j["job_id"]]


job_manager = JobManager()
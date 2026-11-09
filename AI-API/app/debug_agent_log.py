"""Debug-mode NDJSON logger (session 9bd524). Remove after verification."""

from __future__ import annotations

import json
import time
import urllib.request
from pathlib import Path

_SESSION = "9bd524"
_INGEST = "http://127.0.0.1:7280/ingest/7d939726-7d9b-4c08-b7a6-2fc6a2bfa212"
_PATHS = [
    Path(__file__).resolve().parents[1] / "debug-9bd524.log",
    Path("debug-9bd524.log"),
]


def agent_log(
    hypothesis_id: str,
    location: str,
    message: str,
    data: dict | None = None,
    run_id: str = "pre-fix",
) -> None:
    # #region agent log
    payload = {
        "sessionId": _SESSION,
        "runId": run_id,
        "hypothesisId": hypothesis_id,
        "location": location,
        "message": message,
        "data": data or {},
        "timestamp": int(time.time() * 1000),
    }
    line = json.dumps(payload, ensure_ascii=False) + "\n"
    for p in _PATHS:
        try:
            with p.open("a", encoding="utf-8") as f:
                f.write(line)
            break
        except Exception:
            continue
    try:
        req = urllib.request.Request(
            _INGEST,
            data=line.encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "X-Debug-Session-Id": _SESSION,
            },
            method="POST",
        )
        urllib.request.urlopen(req, timeout=1).read()
    except Exception:
        pass
    print(f"[DBG9bd524] {line.strip()}", flush=True)
    # #endregion

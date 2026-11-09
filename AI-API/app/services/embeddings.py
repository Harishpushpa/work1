"""
FAQ / summary embeddings via Haystack shared HTTP API.
Leave model unset so haystack EMBEDDING_* settings apply.
"""

from __future__ import annotations

import time

import numpy as np
import httpx

from app.core.config import EMBED_MODEL, EMBED_TIMEOUT_SECONDS, EMBED_URL

BATCH = 64


def embed(texts):
    texts = list(texts)
    if not texts:
        return np.zeros((0, 0), dtype=np.float32)

    # Empty EMBED_MODEL → haystack uses its EMBEDDING_PROVIDER / EMBEDDING_MODEL.
    model = (EMBED_MODEL or "").strip()
    print(
        f"[EMBED] provider=haystack url={EMBED_URL} "
        f"model={model or '(haystack-config)'} texts={len(texts)}",
        flush=True,
    )
    # #region agent log
    try:
        from app.debug_agent_log import agent_log

        agent_log(
            "B",
            "embeddings.py:embed_start",
            "FAQ embed start",
            {
                "texts": len(texts),
                "timeoutSec": EMBED_TIMEOUT_SECONDS,
                "batch": BATCH,
                "url": EMBED_URL,
            },
        )
    except Exception:
        pass
    # #endregion
    parts = []
    t0 = time.perf_counter()
    try:
        with httpx.Client(timeout=EMBED_TIMEOUT_SECONDS) as client:
            for i in range(0, len(texts), BATCH):
                batch = [str(t) if t is not None else "" for t in texts[i : i + BATCH]]
                body: dict = {"texts": batch}
                if model:
                    body["model"] = model
                bt0 = time.perf_counter()
                resp = client.post(EMBED_URL, json=body)
                if resp.status_code >= 400:
                    raise RuntimeError(
                        f"Haystack embed failed ({resp.status_code}): {resp.text[:400]}"
                    )
                data = resp.json()
                vectors = data.get("embeddings") or []
                if len(vectors) != len(batch):
                    raise RuntimeError(
                        f"Haystack embed count mismatch: got {len(vectors)} expected {len(batch)}"
                    )
                parts.append(np.array(vectors, dtype=np.float32))
                # #region agent log
                try:
                    from app.debug_agent_log import agent_log

                    agent_log(
                        "B",
                        "embeddings.py:embed_batch_ok",
                        "FAQ embed batch ok",
                        {
                            "batchSize": len(batch),
                            "batchMs": int((time.perf_counter() - bt0) * 1000),
                            "offset": i,
                        },
                    )
                except Exception:
                    pass
                # #endregion
    except Exception as exc:
        # #region agent log
        try:
            from app.debug_agent_log import agent_log

            agent_log(
                "B",
                "embeddings.py:embed_fail",
                "FAQ embed failed",
                {
                    "excType": type(exc).__name__,
                    "exc": str(exc)[:200],
                    "elapsedMs": int((time.perf_counter() - t0) * 1000),
                    "timeoutSec": EMBED_TIMEOUT_SECONDS,
                    "texts": len(texts),
                },
            )
        except Exception:
            pass
        # #endregion
        raise

    # #region agent log
    try:
        from app.debug_agent_log import agent_log

        agent_log(
            "B",
            "embeddings.py:embed_ok",
            "FAQ embed ok",
            {
                "texts": len(texts),
                "elapsedMs": int((time.perf_counter() - t0) * 1000),
                "timeoutSec": EMBED_TIMEOUT_SECONDS,
            },
        )
    except Exception:
        pass
    # #endregion

    v = np.vstack(parts)
    # Haystack e5-base already normalizes; keep unit-norm for cosine dedupe safety.
    norms = np.linalg.norm(v, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return v / norms

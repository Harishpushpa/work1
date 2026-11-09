from __future__ import annotations

import threading
import time
from collections import deque


class SlidingWindowRateLimiter:
    """Allow at most `rpm` acquires per rolling 60-second window."""

    def __init__(self, rpm: int):
        self.rpm = max(1, int(rpm))
        self._timestamps: deque[float] = deque()
        self._lock = threading.Lock()

    def acquire(self) -> None:
        while True:
            with self._lock:
                now = time.monotonic()
                cutoff = now - 60.0
                while self._timestamps and self._timestamps[0] < cutoff:
                    self._timestamps.popleft()
                if len(self._timestamps) < self.rpm:
                    self._timestamps.append(now)
                    return
                wait_for = self._timestamps[0] + 60.0 - now
            time.sleep(max(wait_for, 0.01))


class ProviderGate:
    """Per-provider concurrency + RPM gate (thread-safe for sync Haystack Agent)."""

    def __init__(self, max_concurrency: int, rpm: int):
        self.semaphore = threading.BoundedSemaphore(max(1, int(max_concurrency)))
        self.rate_limiter = SlidingWindowRateLimiter(rpm)

    def __enter__(self) -> "ProviderGate":
        self.semaphore.acquire()
        try:
            self.rate_limiter.acquire()
        except Exception:
            self.semaphore.release()
            raise
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.semaphore.release()


class ProviderGateRegistry:
    def __init__(self):
        self._gates: dict[str, ProviderGate] = {}
        self._lock = threading.Lock()

    def get(self, provider: str, max_concurrency: int, rpm: int) -> ProviderGate:
        key = provider.strip().lower()
        with self._lock:
            gate = self._gates.get(key)
            if gate is None:
                gate = ProviderGate(max_concurrency, rpm)
                self._gates[key] = gate
            return gate


_registry = ProviderGateRegistry()


def get_provider_gate(provider: str, max_concurrency: int, rpm: int) -> ProviderGate:
    return _registry.get(provider, max_concurrency, rpm)

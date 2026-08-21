"""
Snapshots de métricas por canal en Redis (keys con TTL, no pub/sub).

El pub/sub metrics:{canal} es fire-and-forget: un GET de la API caería
siempre "entre" mensajes. El key metrics:latest:{SCNL} con TTL 60 s da
el último valor conocido; si el canal se muda, la key expira sola y el
endpoint devuelve 404 — mejor que servir un valor viejo como si fuera
actual. Mismo cliente redis.asyncio que event_bus.py.
"""

from __future__ import annotations

import json
from typing import Any, Optional

import redis.asyncio as aioredis

METRICS_KEY_PREFIX = "metrics:latest:"
METRICS_SNAPSHOT_TTL_SECONDS = 60


class MetricsStore:
    def __init__(self, redis_url: str) -> None:
        self._url = redis_url
        self._client: Optional[aioredis.Redis] = None

    async def connect(self) -> None:
        if self._client is None:
            self._client = aioredis.from_url(self._url, decode_responses=True)
            await self._client.ping()

    async def set_snapshot(
        self,
        channel: str,
        metrics: dict[str, Any],
        ttl_s: int = METRICS_SNAPSHOT_TTL_SECONDS,
    ) -> None:
        assert self._client is not None, "connect() primero"
        await self._client.set(
            f"{METRICS_KEY_PREFIX}{channel}", json.dumps(metrics), ex=ttl_s
        )

    async def get_snapshot(self, channel: str) -> Optional[dict[str, Any]]:
        assert self._client is not None, "connect() primero"
        raw = await self._client.get(f"{METRICS_KEY_PREFIX}{channel}")
        return json.loads(raw) if raw else None

    async def get_snapshots(self, channels: list[str]) -> dict[str, dict[str, Any]]:
        assert self._client is not None, "connect() primero"
        if not channels:
            return {}
        raws = await self._client.mget([f"{METRICS_KEY_PREFIX}{c}" for c in channels])
        return {c: json.loads(r) for c, r in zip(channels, raws) if r}

    async def close(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

"""MetricsStore contra Redis real (testcontainers) — la política del
proyecto: los mocks son ciegos a TTLs y a la semántica de MGET."""

import asyncio

from src.services.metrics_store import METRICS_KEY_PREFIX, MetricsStore

SAMPLE = {
    "channel": "IU.MAJO.00.BHZ",
    "endtime": "2026-08-21T14:32:10.000000Z",
    "rsam": 123.4,
    "freq_hz": 2.4,
    "fi": -0.12,
    "peak_db": 87.3,
    "events_hour": 3,
}


async def test_snapshot_roundtrip(redis_url):
    store = MetricsStore(redis_url)
    await store.connect()
    try:
        await store.set_snapshot("IU.MAJO.00.BHZ", SAMPLE)
        assert await store.get_snapshot("IU.MAJO.00.BHZ") == SAMPLE
    finally:
        await store.close()


async def test_snapshot_ausente_devuelve_none(redis_url):
    store = MetricsStore(redis_url)
    await store.connect()
    try:
        assert await store.get_snapshot("XX.NADA..HHZ") is None
    finally:
        await store.close()


async def test_get_snapshots_omite_canales_sin_datos(redis_url):
    store = MetricsStore(redis_url)
    await store.connect()
    try:
        await store.set_snapshot("IU.MAJO.00.BHZ", SAMPLE)
        result = await store.get_snapshots(["IU.MAJO.00.BHZ", "XX.NADA..HHZ"])
        assert result == {"IU.MAJO.00.BHZ": SAMPLE}
        assert await store.get_snapshots([]) == {}
    finally:
        await store.close()


async def test_el_snapshot_expira_por_ttl(redis_url, redis_client):
    store = MetricsStore(redis_url)
    await store.connect()
    try:
        await store.set_snapshot("IU.MAJO.00.BHZ", SAMPLE, ttl_s=1)
        ttl = await redis_client.ttl(f"{METRICS_KEY_PREFIX}IU.MAJO.00.BHZ")
        assert 0 < ttl <= 1
        await asyncio.sleep(1.2)
        assert await store.get_snapshot("IU.MAJO.00.BHZ") is None
    finally:
        await store.close()

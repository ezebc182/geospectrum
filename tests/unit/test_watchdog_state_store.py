"""Tests de WatchdogStateStore (Fase 3 del change).

Mismo patrón que MetricsStore (src/services/metrics_store.py), con la
diferencia deliberada de que acá NO hay TTL: el registro de un incidente debe
sobrevivir mientras dure la caída, aunque sean días (ver design.md, Decision
"Esquema de Redis"). Ambos métodos degradan a None/no-op ante cualquier fallo
de Redis — nunca propagan (ver design.md, Decision "Redis caído → notificar
igual, degradando SIN estado").
"""

import pytest

from src.services.watchdog import WatchdogStateStore

pytestmark = pytest.mark.asyncio


class _FakeRedisClient:
    """Stub manual de redis.asyncio.Redis: get/set en un dict en memoria."""

    def __init__(self) -> None:
        self._data: dict[str, str] = {}

    async def get(self, key: str):
        return self._data.get(key)

    async def set(self, key: str, value: str, **kwargs) -> None:
        self._data[key] = value


class _FailingRedisClient:
    """Stub que lanza en cualquier operación — simula Redis inalcanzable."""

    async def get(self, key: str):
        raise ConnectionError("redis no disponible")

    async def set(self, key: str, value: str, **kwargs) -> None:
        raise ConnectionError("redis no disponible")


async def test_get_state_devuelve_none_si_no_existe_la_key():
    store = WatchdogStateStore(_FakeRedisClient())
    result = await store.get_state("api")
    assert result is None


async def test_set_state_y_get_state_roundtrip():
    store = WatchdogStateStore(_FakeRedisClient())
    await store.set_state("api", status="down", since="2026-08-30T14:05:00+00:00")
    result = await store.get_state("api")
    assert result == {"status": "down", "since": "2026-08-30T14:05:00+00:00"}


async def test_get_state_degradado_si_redis_falla():
    store = WatchdogStateStore(_FailingRedisClient())
    # No debe propagar: Redis caído se degrada a None (sin estado conocido).
    result = await store.get_state("api")
    assert result is None


async def test_set_state_degradado_si_redis_falla():
    store = WatchdogStateStore(_FailingRedisClient())
    # No debe propagar: un fallo al persistir se loguea y no revienta el ciclo.
    await store.set_state("api", status="down", since="2026-08-30T14:05:00+00:00")

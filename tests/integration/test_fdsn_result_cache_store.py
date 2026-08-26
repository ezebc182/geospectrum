"""FdsnResultCache contra Postgres real: roundtrip JSONB, upsert y purga LRU.

La tabla la crea la migración 016 (la aplica `_migrated` por glob). La purga
se verifica acá y no en unit porque el ORDER BY + OFFSET del delete es
exactamente lo que un mock no puede probar: "validar forma no es validar
contenido".
"""

import pytest

from src.services.fdsn_result_cache import FdsnResultCache

pytestmark = pytest.mark.asyncio

PAYLOAD = {
    "channel": "IU.MAJO.00.BHZ",
    "sampling_rate": 20.0,
    "mins": [-1.5, -2.25],
    "maxs": [1.5, 2.25],
}


@pytest.fixture
async def service(db_pool):
    yield FdsnResultCache(db_pool, max_entries=200)
    await db_pool.execute("DELETE FROM fdsn_result_cache")


class TestRoundtrip:
    async def test_get_de_key_inexistente_devuelve_none(self, service):
        assert await service.get("waveform:XX.NADA..BHZ:x") is None

    async def test_set_y_get_devuelven_el_payload_intacto(self, service, db_pool):
        await service.set("k1", PAYLOAD)
        # La lectura de control va por una conexión NUEVA, directa a la base:
        # leer lo que se escribió en la misma sesión pasaría igual con un dict.
        raw = await db_pool.fetchval(
            "SELECT payload FROM fdsn_result_cache WHERE cache_key = 'k1'"
        )
        assert raw is not None
        assert await service.get("k1") == PAYLOAD

    async def test_set_repetido_es_upsert(self, service):
        await service.set("k1", PAYLOAD)
        nuevo = {**PAYLOAD, "sampling_rate": 40.0}
        await service.set("k1", nuevo)
        assert (await service.get("k1"))["sampling_rate"] == 40.0


class TestPurgaLru:
    async def test_el_tope_expulsa_la_menos_accedida(self, db_pool):
        service = FdsnResultCache(db_pool, max_entries=3)
        try:
            for key in ("k1", "k2", "k3"):
                await service.set(key, PAYLOAD)
            # k1 es la más vieja, pero un get la promueve: la víctima pasa a
            # ser k2. Si la purga ignorara last_accessed_at, moriría k1.
            assert await service.get("k1") is not None
            await service.set("k4", PAYLOAD)

            assert await service.get("k2") is None
            assert await service.get("k1") is not None
            assert await service.get("k3") is not None
            assert await service.get("k4") is not None
        finally:
            await db_pool.execute("DELETE FROM fdsn_result_cache")


class TestDegradacion:
    async def test_pool_roto_no_explota(self):
        """El cache jamás produce un 500: sin base, get devuelve None y set
        es un noop con log. La app queda como está hoy (directo a FDSN)."""

        class _PoolRoto:
            def acquire(self):
                raise ConnectionError("base caída")

        service = FdsnResultCache(_PoolRoto(), max_entries=3)
        assert await service.get("k1") is None
        await service.set("k1", PAYLOAD)  # no debe levantar

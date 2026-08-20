"""
Tests de /spectrograms/live-channels: el catálogo estático se filtra por los
canales que REALMENTE tienen columnas frescas en TimescaleDB.

Antes el endpoint devolvía LIVE_CHANNELS_BY_CITY entero, y el frontend
ofrecía el toggle "Vivo" en ciudades que nadie estaba transmitiendo: la
tarjeta quedaba en negro sin explicación.

La parte SQL (fetch_active_channels) se prueba contra un Postgres real
(fixtures de tests/conftest.py): los mocks de asyncpg son ciegos a errores
de SQL. La tabla se crea plana (sin hypertable): la query bajo test no
depende de TimescaleDB y el testcontainer es postgres:16-alpine.
"""

from datetime import datetime, timedelta, timezone

import asyncpg
import pytest

from src.services.spectrogram_service import resolve_live_catalog
from src.services.timescale_service import TimescaleColumnWriter


# ---------------------------------------------------------------------------
# TimescaleColumnWriter.fetch_active_channels (SQL contra Postgres real)
# ---------------------------------------------------------------------------


@pytest.fixture
async def spectro_writer(postgres_dsn):
    """Writer conectado a un Postgres real con la tabla plana creada y vacía."""
    conn = await asyncpg.connect(postgres_dsn)
    try:
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS spectrogram_columns (
                channel     TEXT        NOT NULL,
                endtime     TIMESTAMPTZ NOT NULL,
                freqs       REAL[]      NOT NULL,
                power_db    REAL[]      NOT NULL,
                PRIMARY KEY (channel, endtime)
            )
            """
        )
        await conn.execute("TRUNCATE spectrogram_columns")
    finally:
        await conn.close()

    writer = TimescaleColumnWriter(postgres_dsn)
    await writer.connect()
    yield writer
    await writer.close()


async def _insert_column(writer: TimescaleColumnWriter, channel: str, endtime: datetime) -> None:
    async with writer._pool.acquire() as conn:
        await conn.execute(
            "INSERT INTO spectrogram_columns (channel, endtime, freqs, power_db) "
            "VALUES ($1, $2, $3, $4)",
            channel,
            endtime,
            [1.0, 2.0],
            [-100.0, -90.0],
        )


async def test_fetch_active_channels_devuelve_solo_los_frescos(spectro_writer):
    now = datetime.now(timezone.utc)
    await _insert_column(spectro_writer, "IU.TATO.00.BHZ", now - timedelta(seconds=30))
    await _insert_column(spectro_writer, "UW.LON..HHZ", now - timedelta(minutes=2))
    await _insert_column(spectro_writer, "JP.JYT..BHZ", now - timedelta(minutes=45))

    active = await spectro_writer.fetch_active_channels(minutes=10)

    assert sorted(active) == ["IU.TATO.00.BHZ", "UW.LON..HHZ"]


async def test_fetch_active_channels_sin_filas_devuelve_vacio(spectro_writer):
    assert await spectro_writer.fetch_active_channels(minutes=10) == []


async def test_fetch_active_channels_no_duplica_canales(spectro_writer):
    now = datetime.now(timezone.utc)
    await _insert_column(spectro_writer, "IU.TATO.00.BHZ", now - timedelta(seconds=10))
    await _insert_column(spectro_writer, "IU.TATO.00.BHZ", now - timedelta(seconds=20))

    active = await spectro_writer.fetch_active_channels(minutes=10)

    assert active == ["IU.TATO.00.BHZ"]


# ---------------------------------------------------------------------------
# resolve_live_catalog: catálogo multi-candidata (primaria + respaldos).
# Perseguir a la estación "viva de hoy" editando el catálogo es un juego
# perdido (CI.BAR transmitía el 19/8 y estaba muda el 20/8): por ciudad se
# listan candidatas verificadas y gana la primera con columnas frescas.
# ---------------------------------------------------------------------------

CANDIDATES = {
    "sandiego": ["CI.BAR..BHZ", "CI.PLM..BHZ", "CI.MUR..BHZ"],
    "seattle": ["UW.LON..HHZ", "UW.SP2..HHZ"],
    "taipei": ["IU.TATO.00.BHZ"],
}


def test_resolve_sin_senal_de_actividad_devuelve_la_primaria_de_cada_ciudad():
    result = resolve_live_catalog(CANDIDATES, None)
    assert result == [
        {"city_id": "sandiego", "channel": "CI.BAR..BHZ"},
        {"city_id": "seattle", "channel": "UW.LON..HHZ"},
        {"city_id": "taipei", "channel": "IU.TATO.00.BHZ"},
    ]


def test_resolve_primaria_muda_cae_al_primer_respaldo_vivo():
    activos = {"CI.MUR..BHZ", "UW.LON..HHZ", "IU.TATO.00.BHZ"}
    result = resolve_live_catalog(CANDIDATES, activos)
    assert {"city_id": "sandiego", "channel": "CI.MUR..BHZ"} in result
    assert {"city_id": "seattle", "channel": "UW.LON..HHZ"} in result


def test_resolve_respeta_el_orden_de_preferencia_no_el_del_set():
    """Si la primaria y un respaldo están vivos, gana la primaria."""
    activos = {"CI.PLM..BHZ", "CI.BAR..BHZ"}
    result = resolve_live_catalog({"sandiego": CANDIDATES["sandiego"]}, activos)
    assert result == [{"city_id": "sandiego", "channel": "CI.BAR..BHZ"}]


def test_resolve_ciudad_sin_ninguna_candidata_viva_no_aparece():
    result = resolve_live_catalog(CANDIDATES, {"IU.TATO.00.BHZ"})
    assert result == [{"city_id": "taipei", "channel": "IU.TATO.00.BHZ"}]


def test_resolve_conjunto_activo_vacio_devuelve_lista_vacia():
    assert resolve_live_catalog(CANDIDATES, set()) == []


def test_resolve_dos_ciudades_que_comparten_canal_activo_aparecen_ambas():
    candidates = {"a": ["IU.TATO.00.BHZ"], "b": ["IU.TATO.00.BHZ"]}
    result = resolve_live_catalog(candidates, {"IU.TATO.00.BHZ"})
    assert result == [
        {"city_id": "a", "channel": "IU.TATO.00.BHZ"},
        {"city_id": "b", "channel": "IU.TATO.00.BHZ"},
    ]

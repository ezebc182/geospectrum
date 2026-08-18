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

from src.services.spectrogram_service import filter_live_catalog
from src.services.timescale_service import TimescaleColumnWriter


# ---------------------------------------------------------------------------
# filter_live_catalog (lógica pura del endpoint)
# ---------------------------------------------------------------------------


CATALOG = {
    "tokyo": "JP.JYT..BHZ",
    "lima": "II.NNA.00.BHZ",
    "taipei": "IU.TATO.00.BHZ",
}


def test_sin_senal_de_actividad_devuelve_el_catalogo_completo():
    """active=None significa "no pude consultar la base" (no configurada o
    caída): mejor ofrecer todo que esconder canales que sí transmiten."""
    result = filter_live_catalog(CATALOG, None)
    assert result == [
        {"city_id": "tokyo", "channel": "JP.JYT..BHZ"},
        {"city_id": "lima", "channel": "II.NNA.00.BHZ"},
        {"city_id": "taipei", "channel": "IU.TATO.00.BHZ"},
    ]


def test_filtra_las_ciudades_sin_columnas_frescas():
    result = filter_live_catalog(CATALOG, {"IU.TATO.00.BHZ"})
    assert result == [{"city_id": "taipei", "channel": "IU.TATO.00.BHZ"}]


def test_conjunto_activo_vacio_devuelve_lista_vacia():
    """Ingestor caído (cero canales frescos) → ninguna ciudad ofrece Vivo.
    Distinto de None: acá la base respondió y la respuesta es "nada"."""
    assert filter_live_catalog(CATALOG, set()) == []


def test_dos_ciudades_que_comparten_canal_activo_aparecen_ambas():
    catalog = {"a": "IU.TATO.00.BHZ", "b": "IU.TATO.00.BHZ"}
    result = filter_live_catalog(catalog, {"IU.TATO.00.BHZ"})
    assert result == [
        {"city_id": "a", "channel": "IU.TATO.00.BHZ"},
        {"city_id": "b", "channel": "IU.TATO.00.BHZ"},
    ]


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

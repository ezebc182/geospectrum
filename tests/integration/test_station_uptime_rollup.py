"""`rollup_once` contra Postgres REAL (testcontainer, fixture `_migrated`).

Por qué `spectrogram_columns` se crea A MANO acá: la tabla real es una
hypertable de Timescale (`db/migrations/001`), y `tests/conftest.py`
aplica SOLO `deploy/sql/migrations/` sobre `postgres:16-alpine` sin la
extensión. El rollup lee solo `channel` y `endtime`, pero la tabla se
crea con el esquema COMPLETO de la real (`freqs`, `power_db`, misma PK)
porque `tests/unit/test_live_channels.py` crea la misma tabla con
`CREATE TABLE IF NOT EXISTS` en el mismo testcontainer: el primero que
corre fija el esquema para el otro, y una réplica parcial rompía sus
INSERT en la suite completa (2 fallos que no aparecían aislados).

Todo lo que se afirma sobre una fila se afirma con SELECT posterior
(convención del change: verificar contra la base, no con mocks). Las
horas se siembran RELATIVAS a `now()` porque el SQL del rollup usa
`now()` para el tope de 7 días.
"""

from datetime import datetime, timedelta, timezone

import asyncpg
import pytest

from src.services.station_uptime import rollup_once

pytestmark = pytest.mark.asyncio

CHANNEL = "GE.KBU..BHZ"
OTHER_CHANNEL = "IU.MAJO.00.BHZ"

_CREATE_RAW = """
CREATE TABLE IF NOT EXISTS spectrogram_columns (
    channel     TEXT        NOT NULL,
    endtime     TIMESTAMPTZ NOT NULL,
    freqs       REAL[]      NOT NULL,
    power_db    REAL[]      NOT NULL,
    PRIMARY KEY (channel, endtime)
)
"""

# Misma cadencia que el ingestor: una fila cada 4 s desde el inicio de la
# hora. `offset` permite agregar filas a una hora ya sembrada sin chocar
# con la PK (caso "hora parcial que crece").
_SEED_RAW = """
INSERT INTO spectrogram_columns (channel, endtime, freqs, power_db)
SELECT $1, $2::timestamptz + (g * interval '4 seconds'), ARRAY[1.0]::real[], ARRAY[-100.0]::real[]
FROM generate_series($3::int, $3::int + $4::int - 1) AS g
"""


def _hour_floor(moment: datetime) -> datetime:
    return moment.replace(minute=0, second=0, microsecond=0)


@pytest.fixture
async def uptime_db(_migrated):
    """Pool propio con las dos tablas vacías al entrar y al salir."""
    pool = await asyncpg.create_pool(_migrated, min_size=1, max_size=4)
    try:
        async with pool.acquire() as conn:
            await conn.execute(_CREATE_RAW)
            await conn.execute("DELETE FROM spectrogram_columns")
            await conn.execute("DELETE FROM station_uptime_hourly")
        yield pool
    finally:
        async with pool.acquire() as conn:
            await conn.execute("DELETE FROM spectrogram_columns")
            await conn.execute("DELETE FROM station_uptime_hourly")
        await pool.close()


async def _seed_raw(pool, channel: str, hour: datetime, count: int, offset: int = 0) -> None:
    async with pool.acquire() as conn:
        await conn.execute(_SEED_RAW, channel, hour, offset, count)


async def _seed_rollup_row(pool, channel: str, hour: datetime, count: int) -> None:
    async with pool.acquire() as conn:
        await conn.execute(
            "INSERT INTO station_uptime_hourly (channel, bucket_start, columns_count) "
            "VALUES ($1, $2, $3)",
            channel,
            hour,
            count,
        )


async def _rollup_rows(pool) -> list[tuple[str, datetime, int]]:
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT channel, bucket_start, columns_count FROM station_uptime_hourly "
            "ORDER BY channel, bucket_start"
        )
    return [(r["channel"], r["bucket_start"], r["columns_count"]) for r in rows]


# --- (a) una hora completa queda como 900 y una parcial como su conteo -------


async def test_hora_completa_y_parcial_quedan_con_su_conteo(uptime_db):
    h = _hour_floor(datetime.now(timezone.utc)) - timedelta(hours=3)
    await _seed_raw(uptime_db, CHANNEL, h, 900)
    await _seed_raw(uptime_db, CHANNEL, h + timedelta(hours=1), 450)

    upserted = await rollup_once(uptime_db)

    assert upserted == 2
    assert await _rollup_rows(uptime_db) == [
        (CHANNEL, h, 900),
        (CHANNEL, h + timedelta(hours=1), 450),
    ]


# --- (b) segunda corrida sin cambios es idempotente ---------------------------


async def test_segunda_corrida_sin_cambios_deja_lo_mismo(uptime_db):
    h = _hour_floor(datetime.now(timezone.utc)) - timedelta(hours=3)
    await _seed_raw(uptime_db, CHANNEL, h, 900)
    await _seed_raw(uptime_db, CHANNEL, h + timedelta(hours=1), 450)
    await rollup_once(uptime_db)
    before = await _rollup_rows(uptime_db)

    upserted = await rollup_once(uptime_db)

    # Invariante del design: la segunda corrida NO relee más atrás del último
    # bucket escrito (H+1), así que reescribe SOLO esa hora (1 fila, mismo
    # conteo) — la hora H no se toca y no aparece ninguna fila nueva.
    assert upserted == 1
    assert await _rollup_rows(uptime_db) == before
    assert len(before) == 2


# --- (c) la hora parcial se REESCRIBE con el conteo actual, no se acumula ----


async def test_la_hora_parcial_se_reescribe_no_se_acumula(uptime_db):
    h = _hour_floor(datetime.now(timezone.utc)) - timedelta(hours=3)
    h1 = h + timedelta(hours=1)
    await _seed_raw(uptime_db, CHANNEL, h, 900)
    await _seed_raw(uptime_db, CHANNEL, h1, 450)
    await rollup_once(uptime_db)

    await _seed_raw(uptime_db, CHANNEL, h1, 100, offset=450)
    await rollup_once(uptime_db)

    rows = await _rollup_rows(uptime_db)
    # 550: ni 1000 (acumuló) ni 450 (DO NOTHING). Mutación M5.
    assert rows == [(CHANNEL, h, 900), (CHANNEL, h1, 550)]


# --- (d) un hueco de horas se rellena solo ------------------------------------


async def test_un_hueco_de_cinco_horas_se_rellena_solo(uptime_db):
    """Último bucket escrito hace 5 h (el api estuvo caído) y raw en las 5
    horas siguientes: una corrida las materializa todas. Mutación M6:
    con `now() - 2 hours` como piso, las primeras quedan sin fila."""
    now_hour = _hour_floor(datetime.now(timezone.utc))
    last_written = now_hour - timedelta(hours=5)
    await _seed_rollup_row(uptime_db, CHANNEL, last_written, 900)
    gap_hours = [now_hour - timedelta(hours=k) for k in (4, 3, 2, 1, 0)]
    for hour in gap_hours:
        await _seed_raw(uptime_db, CHANNEL, hour, 10)

    await rollup_once(uptime_db)

    rows = await _rollup_rows(uptime_db)
    assert rows == [(CHANNEL, last_written, 900)] + [(CHANNEL, hour, 10) for hour in gap_hours]


# --- (e) raw de hace 8 días NO produce fila (tope de 7 días) ------------------


async def test_raw_de_hace_ocho_dias_no_entra(uptime_db):
    now_hour = _hour_floor(datetime.now(timezone.utc))
    stale = now_hour - timedelta(days=8)
    recent = now_hour - timedelta(hours=2)
    await _seed_raw(uptime_db, CHANNEL, stale, 900)
    await _seed_raw(uptime_db, CHANNEL, recent, 900)

    upserted = await rollup_once(uptime_db)

    # La corrida SÍ corrió (la hora reciente entró); la vieja no.
    assert upserted == 1
    assert await _rollup_rows(uptime_db) == [(CHANNEL, recent, 900)]


# --- (f) dos canales en la misma hora ⇒ dos filas ----------------------------


async def test_dos_canales_en_la_misma_hora_dan_dos_filas(uptime_db):
    h = _hour_floor(datetime.now(timezone.utc)) - timedelta(hours=2)
    await _seed_raw(uptime_db, CHANNEL, h, 900)
    await _seed_raw(uptime_db, OTHER_CHANNEL, h, 300)

    upserted = await rollup_once(uptime_db)

    assert upserted == 2
    assert await _rollup_rows(uptime_db) == [
        (CHANNEL, h, 900),
        (OTHER_CHANNEL, h, 300),
    ]

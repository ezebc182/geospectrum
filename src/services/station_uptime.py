"""Rollup horario de disponibilidad por canal (analytics-professional-panels).

El dolor que resuelve: `spectrogram_columns` (Timescale, `db/migrations/001`)
tiene UNA fila por canal cada `COLUMN_INTERVAL_SECONDS` — es la evidencia
real de "canal vivo", la misma que lee `check_seedlink` del watchdog — pero
con retención de 7 días. Para un panel de uptime que mire hacia atrás más
de una semana hace falta consolidar esa evidencia en algo que NO caduque:
`station_uptime_hourly` (`deploy/sql/migrations/021`), una tabla plana con
`(channel, bucket_start, columns_count)` y sin retención.

Definición: `uptime(canal, hora) = min(1, columns_count / EXPECTED_COLUMNS_PER_HOUR)`.
El denominador se DERIVA de la cadencia del ingestor (import), nunca de un
`900` literal: si un día la cadencia cambia, el denominador cambia con ella.

Corre DENTRO del proceso del api, mismo molde que `disk_alert.py`: un
asyncio.Task con `stop_event` esperado (no un sleep pelado) para no demorar
el shutdown, y un try/except que envuelve TODO el ciclo — un loop que
lance al arrancar tumbaría el `api` entero (lección del ingestor que salía
con exit 0 por un hilo sin try/except). Opt-in por `UPTIME_ROLLUP_ENABLED`,
encendido SOLO en el servicio `api` de Railway.

`build_uptime_series` / `fetch_uptime` (lectura) llegan en fases
posteriores del change; acá vive únicamente la escritura.
"""

import asyncio
import logging
import time

import asyncpg

from src.services.seedlink_ingestor import COLUMN_INTERVAL_SECONDS

logger = logging.getLogger(__name__)

# 900 con la cadencia actual de 4 s. Derivada, no redeclarada (Decision 2).
EXPECTED_COLUMNS_PER_HOUR: int = 3600 // COLUMN_INTERVAL_SECONDS

# Un solo upsert por corrida. La ventana de lectura es
# `GREATEST(now() - 7 días, último bucket ya escrito)`:
#   * tabla vacía (primer deploy) ⇒ '-infinity' pierde contra now() - 7 d y
#     se materializa toda la raw retenida de una;
#   * corrida normal ⇒ se relee desde el último bucket (que suele ser la
#     hora en curso, parcial) — unas pocas horas, no 7 días;
#   * caída del api de N horas ⇒ el hueco se rellena solo en la primera
#     corrida siguiente, sin cron ni intervención.
# `DO UPDATE` (no `DO NOTHING`): la hora parcial se REESCRIBE con su conteo
# actual en cada corrida hasta cerrarse — se sobreescribe, no se acumula.
_ROLLUP_SQL = """
INSERT INTO station_uptime_hourly (channel, bucket_start, columns_count)
SELECT channel, date_trunc('hour', endtime), count(*)
FROM spectrogram_columns
WHERE endtime >= GREATEST(
    now() - interval '7 days',
    COALESCE((SELECT max(bucket_start) FROM station_uptime_hourly), '-infinity'::timestamptz)
)
GROUP BY 1, 2
ON CONFLICT (channel, bucket_start) DO UPDATE SET columns_count = EXCLUDED.columns_count
"""


def _rows_from_command_tag(tag: str) -> int:
    """asyncpg devuelve el command tag de Postgres ("INSERT 0 <n>"); `n` cuenta
    insertadas Y actualizadas por el `ON CONFLICT DO UPDATE`."""
    try:
        return int(tag.rsplit(" ", 1)[-1])
    except ValueError:
        return 0


async def rollup_once(pool: asyncpg.Pool) -> int:
    """Una corrida del rollup. Devuelve la cantidad de filas upserteadas.

    El `info` con filas y milisegundos es la medición de la primera corrida
    en prod (backfill de 7 días de raw): si esa cifra asusta, se baja la
    cadencia — no se adivina."""
    started = time.perf_counter()
    async with pool.acquire() as conn:
        tag = await conn.execute(_ROLLUP_SQL)
    rows = _rows_from_command_tag(tag)
    logger.info(
        "station_uptime: rollup de %d filas en %.0f ms",
        rows,
        (time.perf_counter() - started) * 1000,
    )
    return rows


async def run_uptime_rollup_loop(
    pool: asyncpg.Pool,
    interval_seconds: float,
    stop_event: asyncio.Event,
) -> None:
    """Corre `rollup_once` cada `interval_seconds` hasta que el lifespan setee el stop.

    Un ciclo que falla (Postgres caído, tabla ausente) NO puede matar el
    loop ni propagar al lifespan: se loguea `warning` y el próximo ciclo
    reintenta solo."""
    while not stop_event.is_set():
        try:
            await rollup_once(pool)
        except Exception:
            logger.warning(
                "station_uptime: rollup fallido, se reintenta en el próximo ciclo",
                exc_info=True,
            )
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=interval_seconds)
        except asyncio.TimeoutError:
            pass

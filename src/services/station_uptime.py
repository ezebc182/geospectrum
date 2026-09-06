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

Lectura: `build_uptime_series` (pura, regla [R12] del design) convierte las
filas de la tabla en buckets por canal distinguiendo `null` ("nadie miró")
de `0.0` ("se miró y el canal estaba mudo"). `fetch_uptime` (el SELECT que
la alimenta) llega con el router de `/analytics`.
"""

import asyncio
import logging
import time
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Literal, Optional

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


# --- Lectura: serie de disponibilidad por buckets (pura) ---------------------

UptimeBucketKind = Literal["hour", "day"]

# Fila de `station_uptime_hourly` tal como la devuelve el SELECT: (channel, bucket_start, count).
UptimeRow = tuple[str, datetime, int]


@dataclass(frozen=True)
class UptimeBucketData:
    """Un bucket de un canal. Mismos campos que `UptimeBucket` del contrato."""

    bucket_start: datetime
    columns_count: int  # 0 si el canal no tiene fila en el bucket
    observed_hours: int  # horas del bucket con fila de ALGÚN canal (0 o 1 en bucket=hour)
    expected: int  # EXPECTED_COLUMNS_PER_HOUR × observed_hours
    ratio: Optional[float]  # min(1, count/expected); None si nadie observó o el canal no está
    in_progress: bool  # el bucket contiene `now`


@dataclass(frozen=True)
class UptimeSeriesData:
    """Salida de `build_uptime_series`. Mismos campos que `StationUptimeResponse`."""

    bucket: UptimeBucketKind
    window_start: datetime
    window_end: datetime
    expected_columns_per_hour: int
    stations: dict[str, list[UptimeBucketData]]
    overall: dict[str, Optional[float]]


def _truncate(ts: datetime, bucket: UptimeBucketKind) -> datetime:
    """`date_trunc('hour' | 'day', ts)`, conservando la zona horaria."""
    if bucket == "day":
        return ts.replace(hour=0, minute=0, second=0, microsecond=0)
    return ts.replace(minute=0, second=0, microsecond=0)


def _step(bucket: UptimeBucketKind) -> timedelta:
    return timedelta(days=1) if bucket == "day" else timedelta(hours=1)


def _ratio(columns: int, observed_hours: int, channel_present: bool) -> Optional[float]:
    """[R12]: `None` si nadie observó (o el canal no aparece en la ventana), si no el
    ratio contra las horas OBSERVADAS, clampeado a 1.0 (una hora puede traer >900
    columnas si el ingestor reconectó y reemitió)."""
    if not channel_present or observed_hours == 0:
        return None
    return min(1.0, columns / (EXPECTED_COLUMNS_PER_HOUR * observed_hours))


def build_uptime_series(
    rows: Sequence[UptimeRow],
    start: datetime,
    end: datetime,
    bucket: UptimeBucketKind,
    channels: Optional[Sequence[str]],
    now: datetime,
) -> UptimeSeriesData:
    """Serie de disponibilidad por canal a partir de las filas del rollup. PURA.

    Reglas ([R12] del design; Decisiones 4 y 5 de la spec de `signal-analysis`):
      * la lista cubre TODOS los buckets de la ventana, alineados al
        `date_trunc` de `start`, sin saltear los vacíos;
      * una hora es OBSERVADA si tiene fila de CUALQUIER canal (el pipeline
        estaba vivo); en una hora no observada el ratio es `None`;
      * un canal presente en la ventana sin fila en una hora observada suma
        `0` columnas ahí ⇒ `0.0` (mudo, no "no se sabe");
      * un canal pedido sin ninguna fila en la ventana ⇒ `None` en todos sus
        buckets y en `overall` (no se lo miró; no se lo acusa);
      * `bucket=day`: `sum(count) / (EXPECTED × horas observadas del día)`;
      * `overall[channel]` aplica la misma regla sobre toda la ventana;
      * `channels=None` ⇒ los canales presentes en `rows`.
    """
    first_bucket = _truncate(start, bucket)
    step = _step(bucket)

    in_window = [(ch, ts, n) for ch, ts, n in rows if first_bucket <= ts < end]
    observed_hours = {ts for _, ts, _ in in_window}
    counts: dict[tuple[str, datetime], int] = {}
    for ch, ts, n in in_window:
        counts[(ch, ts)] = counts.get((ch, ts), 0) + n
    present = {ch for ch, _, _ in in_window}
    requested = list(channels) if channels is not None else sorted(present)

    bucket_starts: list[datetime] = []
    cursor = first_bucket
    while cursor < end:
        bucket_starts.append(cursor)
        cursor += step
    hours_by_bucket: dict[datetime, list[datetime]] = {b: [] for b in bucket_starts}
    for hour in observed_hours:
        hours_by_bucket[_truncate(hour, bucket)].append(hour)

    stations: dict[str, list[UptimeBucketData]] = {}
    overall: dict[str, Optional[float]] = {}
    for ch in requested:
        channel_present = ch in present
        buckets: list[UptimeBucketData] = []
        total_columns = 0
        for bucket_start in bucket_starts:
            hours = hours_by_bucket[bucket_start]
            columns = sum(counts.get((ch, hour), 0) for hour in hours)
            total_columns += columns
            buckets.append(
                UptimeBucketData(
                    bucket_start=bucket_start,
                    columns_count=columns,
                    observed_hours=len(hours),
                    expected=EXPECTED_COLUMNS_PER_HOUR * len(hours),
                    ratio=_ratio(columns, len(hours), channel_present),
                    in_progress=bucket_start <= now < bucket_start + step,
                )
            )
        stations[ch] = buckets
        overall[ch] = _ratio(total_columns, len(observed_hours), channel_present)

    return UptimeSeriesData(
        bucket=bucket,
        window_start=start,
        window_end=end,
        expected_columns_per_hour=EXPECTED_COLUMNS_PER_HOUR,
        stations=stations,
        overall=overall,
    )

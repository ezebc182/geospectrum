"""Cache SIN vencimiento de resultados FDSN de ventana absoluta.

Una ventana histórica es inmutable: los datos de un evento de 2019 no van a
cambiar. Pagarle ~60 s a EarthScope cada vez que el TTL de 900 s expira es
tirar el trabajo a la basura. Este módulo persiste esos resultados en
TimescaleDB para que sobrevivan redeploys (el cache en memoria muere con el
proceso, y en este proyecto se despliega a diario).

La elegibilidad es la mitad honesta del diseño: solo se congela un resultado
cuyo trace CUBRE la ventana pedida. Un parcial (gap al final, estación que
entró tarde) se cachea con el TTL normal — congelarlo serviría datos
incompletos para siempre aun cuando FDSN complete la ventana después.
"""

import json
import logging
from datetime import datetime
from typing import Any, Optional

logger = logging.getLogger(__name__)

# FDSN alinea los bordes al sample y suele recortar segundos en las puntas;
# 5 s de falta no convierten la ventana en "otra" ventana.
DEFAULT_TOLERANCE_SECONDS = 5.0


def covers_window(
    trace_start: datetime,
    trace_end: datetime,
    start: datetime,
    end: datetime,
    tolerance_seconds: float = DEFAULT_TOLERANCE_SECONDS,
) -> bool:
    """True si el trace cubre [start, end] con la tolerancia dada POR PUNTA."""
    start_shortfall = (trace_start - start).total_seconds()
    end_shortfall = (end - trace_end).total_seconds()
    return start_shortfall <= tolerance_seconds and end_shortfall <= tolerance_seconds


def trace_covers_window(trace: Any, start: datetime, end: datetime) -> bool:
    """`covers_window` sobre un Trace de ObsPy.

    UTCDateTime.datetime devuelve un naive que ES UTC por contrato de ObsPy;
    acá se le pone la etiqueta. En este repo un naive sin etiquetar ya rotuló
    las 02:10 como "5:10 UTC" — la conversión vive en UN solo lugar a propósito.
    """
    from datetime import timezone

    trace_start = trace.stats.starttime.datetime.replace(tzinfo=timezone.utc)
    trace_end = trace.stats.endtime.datetime.replace(tzinfo=timezone.utc)
    return covers_window(trace_start, trace_end, start, end)


class FdsnResultCache:
    """Resultados FDSN persistidos en Postgres. El pool es prestado (lifespan).

    Toda falla de base degrada a "no hay cache": get devuelve None, set es un
    noop con log. La app sigue funcionando exactamente como hoy (directo a
    FDSN) — el cache jamás produce un 500.
    """

    def __init__(self, pool: Any, max_entries: int = 200) -> None:
        self._pool = pool
        self._max_entries = max_entries

    async def get(self, key: str) -> Optional[dict]:
        try:
            async with self._pool.acquire() as conn:
                # El UPDATE del last_accessed_at viaja en el mismo roundtrip:
                # es lo que convierte la purga por tope en LRU y no en FIFO.
                raw = await conn.fetchval(
                    """
                    UPDATE fdsn_result_cache
                       SET last_accessed_at = clock_timestamp()
                     WHERE cache_key = $1
                    RETURNING payload
                    """,
                    key,
                )
        except Exception:
            logger.warning("fdsn_result_cache: get(%s) falló, se sigue sin cache", key, exc_info=True)
            return None
        if raw is None:
            return None
        # asyncpg entrega JSONB como str salvo codec custom; decodificar acá
        # mantiene al servicio sin estado de conexión.
        return json.loads(raw) if isinstance(raw, str) else raw

    async def set(self, key: str, payload: dict) -> None:
        try:
            async with self._pool.acquire() as conn:
                await conn.execute(
                    """
                    INSERT INTO fdsn_result_cache (cache_key, payload)
                    VALUES ($1, $2::jsonb)
                    ON CONFLICT (cache_key) DO UPDATE
                       SET payload = EXCLUDED.payload,
                           last_accessed_at = clock_timestamp()
                    """,
                    key,
                    json.dumps(payload),
                )
                # Purga por tope, no por tiempo: sobreviven las max_entries de
                # acceso más reciente. OFFSET sobre el ORDER BY descendente ES
                # la definición de LRU.
                await conn.execute(
                    """
                    DELETE FROM fdsn_result_cache
                     WHERE cache_key IN (
                        SELECT cache_key
                          FROM fdsn_result_cache
                         ORDER BY last_accessed_at DESC
                        OFFSET $1
                     )
                    """,
                    self._max_entries,
                )
        except Exception:
            logger.warning("fdsn_result_cache: set(%s) falló, se sigue sin cache", key, exc_info=True)

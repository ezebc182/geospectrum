"""
Persistencia de eventos sísmicos (PR-W4, tabla seismic_events).

Por qué existe: el worker publica a Redis Pub/Sub, que es fire-and-forget —un
subscriber atrasado pierde mensajes—. Esta tabla es la fuente de verdad: el
snapshot que /ws/events manda al conectar sale de acá, así un cliente que
reconecta recupera lo que se perdió mientras estaba desconectado.

El dedupe entre fuentes NO vive acá (está en event_dedup.py, con tests
propios). Este módulo hace la parte que necesita la base: traer la ventana
espacio-temporal de candidatos y escribir la fila.

Mismo patrón de pool que TimescaleColumnWriter (timescale_service.py:29):
`_pool` opcional, `connect()` idempotente, y el pool DEBE nacer en el loop que
lo va a usar — la lección de seedlink_ingestor.py:423-426.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import asyncpg

from src.models.event import SeismicEvent
from src.services.event_dedup import (
    MATCH_WINDOW_SECONDS,
    find_duplicate,
    has_changes,
    merge_into,
)
from src.utils.geo import parse_datetime_utc

logger = logging.getLogger(__name__)


# Ventana de candidatos que se trae para deduplicar un evento entrante. Es la
# del criterio (±120 s) con un margen: un evento cuyo timestamp difiere 119 s
# tiene que entrar, y traer de más es barato (el índice
# seismic_events_hora_mag_idx cubre la consulta).
DEDUP_LOOKUP_MARGIN_SECONDS = MATCH_WINDOW_SECONDS + 60.0

# Columnas en el orden en que las devuelven las queries. Una sola definición
# para que _row_to_event no se desincronice de los SELECT.
_COLUMNS = (
    "id, fuentes, hora_utc, lat, lon, prof_km, mag, mag_tipo, lugar, sentido, revisado"
)


def _row_to_event(row: asyncpg.Record) -> SeismicEvent:
    """
    Fila → SeismicEvent.

    `hora_utc` vuelve como datetime de asyncpg y el modelo la quiere como str
    ISO8601 (models/event.py:14). La conversión se hace acá, en el borde, y no
    en los llamadores: es el único lugar donde el formato de la base y el del
    modelo se tocan.
    """
    return SeismicEvent(
        id=row["id"],
        fuentes=list(row["fuentes"] or []),
        hora_utc=_to_iso_z(row["hora_utc"]),
        lat=row["lat"],
        lon=row["lon"],
        prof_km=row["prof_km"],
        mag=row["mag"],
        mag_tipo=row["mag_tipo"],
        lugar=row["lugar"],
        sentido=row["sentido"],
        revisado=row["revisado"],
    )


def _to_iso_z(value: datetime) -> str:
    """
    datetime → "2026-08-21T12:00:00Z".

    Con sufijo Z y no "+00:00" porque es el formato que ya usan las fuentes y
    el frontend (`new Date(hora_utc)` los parsea igual, pero el histórico de la
    app viene con Z y mezclar dos formatos en la misma lista es ruido).
    """
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


class EventStore:
    """Lecturas y escrituras de la tabla seismic_events."""

    def __init__(self, dsn: str) -> None:
        self._dsn = dsn
        self._pool: Optional[asyncpg.Pool] = None

    async def connect(self) -> None:
        if self._pool is not None:
            return  # idempotente, igual que TimescaleColumnWriter
        self._pool = await asyncpg.create_pool(self._dsn, min_size=1, max_size=5)

    async def close(self) -> None:
        if self._pool is not None:
            await self._pool.close()
            self._pool = None

    @property
    def pool(self) -> asyncpg.Pool:
        if self._pool is None:
            raise RuntimeError("EventStore no conectado. Llamá connect() primero.")
        return self._pool

    async def candidates_around(self, event: SeismicEvent) -> list[SeismicEvent]:
        """
        Eventos ya persistidos dentro de la ventana temporal de `event`.

        Se filtra por tiempo en la base y por distancia en Python: sin PostGIS
        (verificado, no está disponible en este stack) una consulta geográfica
        exacta en SQL sería un cálculo de haversine a mano por fila. La ventana
        temporal ya recorta a un puñado de filas, así que el filtro de
        distancia sobre ese puñado es gratis.
        """
        hora = parse_datetime_utc(event.hora_utc)
        margen = timedelta(seconds=DEDUP_LOOKUP_MARGIN_SECONDS)
        rows = await self.pool.fetch(
            f"SELECT {_COLUMNS} FROM seismic_events "
            "WHERE hora_utc BETWEEN $1 AND $2 ORDER BY hora_utc DESC",
            hora - margen,
            hora + margen,
        )
        return [_row_to_event(r) for r in rows]

    async def upsert(self, incoming: SeismicEvent) -> tuple[SeismicEvent, bool]:
        """
        Persiste `incoming`, fusionándolo si ya conocíamos ese sismo.

        Devuelve `(evento_resultante, hubo_novedad)`. El bool es lo que decide
        si el worker publica a Redis: un reenvío idéntico de EMSC no debe
        despertar a todos los clientes conectados.

        Casos:
        - sismo nuevo         → INSERT,  (evento, True)
        - reporte con cambios → UPDATE,  (fusionado, True)
        - reenvío idéntico    → no toca, (existente, False)
        """
        existing = find_duplicate(incoming, await self.candidates_around(incoming))

        if existing is None:
            await self._insert(incoming)
            return incoming, True

        fused = merge_into(existing, incoming)
        if not has_changes(existing, fused):
            return existing, False

        await self._update(fused)
        return fused, True

    async def _insert(self, event: SeismicEvent) -> None:
        """
        INSERT con ON CONFLICT DO NOTHING.

        El conflicto por PK es posible aunque `candidates_around` no lo haya
        visto: dos fuentes pueden reportar el mismo id en paralelo. Que no
        explote es más importante que registrar la carrera — el siguiente
        reporte lo va a fusionar igual.
        """
        await self.pool.execute(
            "INSERT INTO seismic_events "
            "(id, fuentes, hora_utc, lat, lon, prof_km, mag, mag_tipo, lugar, sentido, revisado) "
            "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) "
            "ON CONFLICT (id) DO NOTHING",
            event.id,
            event.fuentes,
            parse_datetime_utc(event.hora_utc),
            event.lat,
            event.lon,
            event.prof_km,
            event.mag,
            event.mag_tipo,
            event.lugar,
            event.sentido,
            event.revisado,
        )

    async def _update(self, event: SeismicEvent) -> None:
        await self.pool.execute(
            "UPDATE seismic_events SET "
            "fuentes = $2, hora_utc = $3, lat = $4, lon = $5, prof_km = $6, "
            "mag = $7, mag_tipo = $8, lugar = $9, sentido = $10, revisado = $11, "
            "updated_at = now() "
            "WHERE id = $1",
            event.id,
            event.fuentes,
            parse_datetime_utc(event.hora_utc),
            event.lat,
            event.lon,
            event.prof_km,
            event.mag,
            event.mag_tipo,
            event.lugar,
            event.sentido,
            event.revisado,
        )

    async def recent(
        self,
        hours: int = 24,
        min_magnitude: Optional[float] = None,
        limit: int = 2000,
    ) -> list[SeismicEvent]:
        """
        Eventos recientes, más nuevo primero. Es el snapshot de /ws/events y la
        fuente de GET /events/recent.

        El corte es por `hora_utc` (cuándo ocurrió el sismo), no por
        `created_at` (cuándo lo ingestamos): al usuario le importa la ventana
        sísmica, no cuándo se enteró nuestro worker.
        """
        desde = datetime.now(timezone.utc) - timedelta(hours=hours)
        if min_magnitude is None:
            rows = await self.pool.fetch(
                f"SELECT {_COLUMNS} FROM seismic_events "
                "WHERE hora_utc >= $1 ORDER BY hora_utc DESC LIMIT $2",
                desde,
                limit,
            )
        else:
            rows = await self.pool.fetch(
                f"SELECT {_COLUMNS} FROM seismic_events "
                "WHERE hora_utc >= $1 AND mag >= $2 ORDER BY hora_utc DESC LIMIT $3",
                desde,
                min_magnitude,
                limit,
            )
        return [_row_to_event(r) for r in rows]

    async def get(self, event_id: str) -> Optional[SeismicEvent]:
        row = await self.pool.fetchrow(
            f"SELECT {_COLUMNS} FROM seismic_events WHERE id = $1", event_id
        )
        return _row_to_event(row) if row else None

    async def stats(self) -> dict[str, Any]:
        """Conteo y evento más reciente — para el healthcheck del worker."""
        row = await self.pool.fetchrow(
            "SELECT count(*) AS total, max(hora_utc) AS ultimo FROM seismic_events"
        )
        return {
            "total": row["total"],
            "ultimo_evento_utc": _to_iso_z(row["ultimo"]) if row["ultimo"] else None,
        }

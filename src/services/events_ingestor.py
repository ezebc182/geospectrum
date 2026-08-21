"""
Worker de ingesta de eventos sísmicos (PR-W4, T6).

Corre como PROCESO SEPARADO del API — mismo patrón que
`src.services.seedlink_ingestor` (ver __main__ al final).

Qué hace: escucha el WebSocket de EMSC (push real, segundos) y pollea USGS
cada 60 s (red de seguridad). Cada evento que llega pasa por:

    dedupe contra la tabla  →  INSERT/UPDATE  →  PUBLISH events:new

Sólo publica si hubo NOVEDAD. EMSC reenvía el mismo evento sin cambios y sin
ese filtro cada reenvío despertaría a todos los clientes conectados para
mostrarles exactamente lo mismo.

Por qué persiste ANTES de publicar: Redis Pub/Sub es fire-and-forget. Si el
proceso publicara primero y muriera antes de escribir, el evento quedaría en
las pantallas de quienes estaban conectados y desaparecería del histórico —
peor que no haberlo mostrado. La tabla es la fuente de verdad; el pub/sub es
la entrega rápida.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Optional

from src.config.settings import settings
from src.ingestors.emsc_listener import EMSCListener
from src.ingestors.usgs_poller import USGSPoller
from src.models.event import SeismicEvent
from src.services.event_bus import EventBus, RedisPubSubBus
from src.services.event_store import EventStore

logger = logging.getLogger(__name__)


# Canal de Redis donde se publican los eventos con novedad. Namespace propio,
# no colisiona con spec:{SCNL} ni metrics:{SCNL} (las otras dos convenciones
# vivas del proyecto).
EVENTS_CHANNEL = "events:new"


class EventsIngestor:
    """
    Orquesta EMSC + USGS contra el store y el bus.

    Los ingestores no saben de dedupe ni de Redis: sólo producen eventos y los
    entregan por callback. Toda la política vive acá.
    """

    def __init__(
        self,
        bus: EventBus,
        store: EventStore,
        min_magnitude: Optional[float] = None,
    ) -> None:
        self._bus = bus
        self._store = store
        self.emsc = EMSCListener(on_event=self.handle_event)
        self.usgs = USGSPoller(on_event=self.handle_event, min_magnitude=min_magnitude)
        # Igual que SeedLinkIngestor.failure (:104): por qué murió, para que el
        # proceso salga con código distinto de 0 en vez de un SUCCESS mudo.
        self.failure: Optional[BaseException] = None
        # Contadores para el log de salud; no son métricas Prometheus (eso
        # quedó fuera de alcance del PR).
        self.persisted_count = 0
        self.published_count = 0
        self.duplicate_count = 0

    async def handle_event(self, event: SeismicEvent) -> None:
        """
        Un evento que llegó de cualquier fuente.

        El orden importa: primero la base, después el bus. Ver el docstring del
        módulo.
        """
        resultado, novedad = await self._store.upsert(event)

        if not novedad:
            self.duplicate_count += 1
            logger.debug("Evento sin novedad, no se publica: %s", event.id)
            return

        self.persisted_count += 1

        try:
            await self._bus.publish(EVENTS_CHANNEL, resultado.model_dump())
            self.published_count += 1
        except Exception:
            # Que falle la publicación NO es fatal: el evento ya está
            # persistido y el próximo cliente que conecte lo va a ver en el
            # snapshot. Mismo criterio que las métricas del seedlink
            # (:141-147): un fallo de entrega jamás debe frenar la ingesta.
            logger.warning(
                "No se pudo publicar el evento %s en Redis (ya quedó persistido)",
                resultado.id,
                exc_info=True,
            )

    async def run(self) -> None:
        """
        Corre las dos fuentes en paralelo. Vuelve sólo si ambas terminaron, y
        eso siempre es un fallo (ver el `raise` del __main__).
        """
        logger.info("events_ingestor: arrancando EMSC (WS) + USGS (poll 60 s)")
        try:
            await asyncio.gather(self.emsc.run(), self.usgs.run())
        except asyncio.CancelledError:
            raise
        except BaseException as exc:
            # Se guarda para que el __main__ lo encadene al RuntimeError: sin
            # esto el traceback real se pierde y el log sólo dice "terminó".
            self.failure = exc
            logger.exception("events_ingestor: la ingesta murió")
            raise

    def stop(self) -> None:
        self.emsc.stop()
        self.usgs.stop()


if __name__ == "__main__":
    """
    Proceso independiente. Uso:
        python -m src.services.events_ingestor

    Requiere Redis (settings.redis_url) y Postgres (settings.timescaledb_dsn).
    No se levanta con el API principal (uvicorn src.main:app) — es un proceso
    aparte, igual que src/services/seedlink_ingestor.py.
    """
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )

    async def _main() -> None:
        if settings.timescaledb_dsn is None:
            # Fail-fast y no degradación: sin base este worker no tiene dónde
            # persistir, y publicar sin persistir es justo lo que el diseño
            # evita (los eventos se perderían al reconectar un cliente).
            raise RuntimeError(
                "events_ingestor: falta la config de Postgres "
                "(TIMESCALEDB_HOST/USER/PASSWORD) — sin base no hay dónde persistir"
            )

        bus = RedisPubSubBus(settings.redis_url)
        await bus.connect()
        logger.info("events_ingestor: conectado a Redis en %s", settings.redis_url)

        # El pool nace acá, dentro del loop que lo va a usar: la lección de
        # seedlink_ingestor.py:423-426.
        store = EventStore(settings.timescaledb_dsn)
        await store.connect()
        stats = await store.stats()
        logger.info(
            "events_ingestor: base conectada — %d eventos, último %s",
            stats["total"],
            stats["ultimo_evento_utc"] or "ninguno",
        )

        ingestor = EventsIngestor(bus, store, min_magnitude=settings.source_min_magnitude)

        try:
            await ingestor.run()
        finally:
            logger.info(
                "events_ingestor: cerrando — %d persistidos, %d publicados, %d duplicados",
                ingestor.persisted_count,
                ingestor.published_count,
                ingestor.duplicate_count,
            )
            await store.close()
            await bus.close()

        # run() no vuelve mientras todo va bien: que hayamos llegado acá
        # significa que las dos fuentes terminaron, y eso siempre es un fallo.
        # Sin este raise el proceso saldría con 0 y Railway marcaría el deploy
        # como SUCCESS sobre un worker que no ingesta nada — exactamente el
        # incidente del seedlink (seedlink_ingestor.py:467-473).
        raise RuntimeError(
            "events_ingestor: la ingesta terminó — el proceso no puede continuar"
        ) from ingestor.failure

    asyncio.run(_main())

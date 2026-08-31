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
from datetime import datetime, timezone
from typing import Any, Optional

import asyncpg
import redis.asyncio as aioredis

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

# Key de Redis que lee el watchdog (src/services/watchdog.py, check_events).
# Con TTL: su ausencia (expiró o nunca se escribió) es la señal de "proceso
# colgado". Ver openspec/changes/watchdog-servicios-railway/design.md.
HEARTBEAT_KEY = "events_ingestor:heartbeat"


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
        redis_client: Optional[Any] = None,
    ) -> None:
        """
        `redis_client`: cliente `redis.asyncio` YA CONECTADO, usado
        exclusivamente por `_heartbeat_loop` para que el watchdog externo
        (src/services/watchdog.py) pueda detectar un proceso colgado sin
        excepción. Es OPCIONAL (default None) a propósito: en producción el
        `__main__` de este módulo siempre lo pasa conectado, pero un
        `EventsIngestor` sin él sigue siendo válido (p. ej. en tests que no
        les interesa el heartbeat) — si no hay cliente, `_heartbeat_loop` no
        intenta escribir nada, solo lo loguea una vez y sigue vivo sin hacer
        nada más en cada vuelta. Nunca debe interpretarse como "el heartbeat
        se rompió": es un camino explícito y testeado.
        """
        self._bus = bus
        self._store = store
        self._redis_client = redis_client
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

    async def _heartbeat_loop(
        self,
        interval_s: Optional[float] = None,
        ttl_s: Optional[int] = None,
    ) -> None:
        """
        Escribe `HEARTBEAT_KEY` en Redis cada `interval_s` segundos,
        independiente de si hubo sismos nuevos — cubre explícitamente el
        escenario de spec "Heartbeat expirado sin sismos nuevos en el
        período": una calma sísmica real NUNCA debe leerse como proceso
        caído.

        Riesgo que este método existe para neutralizar (ver design.md,
        Decision "Heartbeat como tarea paralela dentro del mismo gather()"):
        esta corrutina corre DENTRO de `asyncio.gather()` junto a EMSC/USGS
        en `run()`. Si propagara cualquier excepción que no sea
        `asyncio.CancelledError`, `gather()` cancelaría las otras dos y
        tumbaría la ingesta real por un simple fallo de Redis — exactamente
        el incidente ya vivido en este proyecto ("el ingestor salía con exit
        0"). Por eso el `try/except` envuelve ÚNICAMENTE la escritura
        individual, nunca el `while` completo: un bug en el manejo del error
        no puede sacar al loop de su ciclo.
        """
        interval = interval_s if interval_s is not None else (
            settings.watchdog_events_heartbeat_interval_seconds
        )
        ttl = ttl_s if ttl_s is not None else settings.watchdog_events_heartbeat_ttl_seconds

        if self._redis_client is None:
            logger.warning(
                "events_ingestor: heartbeat deshabilitado (sin redis_client) — "
                "el watchdog no va a poder detectar si este proceso se cuelga"
            )

        while True:
            if self._redis_client is not None:
                try:
                    await self._redis_client.set(
                        HEARTBEAT_KEY,
                        datetime.now(timezone.utc).isoformat(),
                        ex=ttl,
                    )
                except asyncio.CancelledError:
                    raise
                except Exception:
                    # Un fallo de Redis acá NUNCA debe tumbar EMSC/USGS. Se
                    # loguea y se reintenta en la próxima vuelta — mismo
                    # criterio que el fallo de publish() en handle_event.
                    logger.warning(
                        "events_ingestor: no se pudo escribir el heartbeat en Redis",
                        exc_info=True,
                    )
            await asyncio.sleep(interval)

    async def run(self) -> None:
        """
        Corre las dos fuentes MÁS el heartbeat en paralelo. Vuelve sólo si
        alguna de las tres terminó, y eso siempre es un fallo (ver el `raise`
        del __main__).

        `_heartbeat_loop()` va DENTRO del mismo gather() (no como Task
        suelta): así queda sujeta al mismo ciclo de vida que EMSC/USGS y
        cualquier excepción no atrapada sería visible acá en vez de perderse
        en silencio como unhandled exception de una Task sin await. Pero
        `_heartbeat_loop()` está diseñada para jamás propagar salvo
        CancelledError — ver su docstring — así que en la práctica esto
        NUNCA debería ser lo que tumbe el gather(). NO se envuelve esta línea
        en ningún try/except adicional: el try/except de abajo sigue siendo
        el único punto de captura para un fallo REAL de ingesta.
        """
        logger.info("events_ingestor: arrancando EMSC (WS) + USGS (poll 60 s) + heartbeat")
        try:
            await asyncio.gather(self.emsc.run(), self.usgs.run(), self._heartbeat_loop())
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

        # Cliente Redis PROPIO para el heartbeat, no el del bus: RedisPubSubBus
        # expone `.client` recién después de connect(), pero acoplar el
        # heartbeat a esa instancia mezclaría el ciclo de vida del pub/sub
        # (cierre, reconexión de subscribers) con el de una simple escritura
        # SET con TTL. Mismo patrón que MetricsStore (src/services/metrics_store.py):
        # una conexión redis.asyncio dedicada y liviana.
        heartbeat_redis = aioredis.from_url(settings.redis_url, decode_responses=True)
        await heartbeat_redis.ping()

        # El pool nace acá, dentro del loop que lo va a usar: la lección de
        # seedlink_ingestor.py:423-426.
        store = EventStore(settings.timescaledb_dsn)
        await store.connect()

        # Chequeo de arranque: si falta la tabla, el primer evento que llegue
        # moriría con un UndefinedTableError de asyncpg y 30 líneas de
        # traceback que no le dicen al operador qué hacer. Verificado a mano:
        # es exactamente lo que pasaba con la base local sin migrar.
        try:
            stats = await store.stats()
        except asyncpg.UndefinedTableError as exc:
            raise RuntimeError(
                "events_ingestor: falta la tabla seismic_events. Corré las "
                "migraciones antes de arrancar el worker: "
                "python -m scripts.apply_migrations"
            ) from exc

        logger.info(
            "events_ingestor: base conectada — %d eventos, último %s",
            stats["total"],
            stats["ultimo_evento_utc"] or "ninguno",
        )

        ingestor = EventsIngestor(
            bus,
            store,
            min_magnitude=settings.source_min_magnitude,
            redis_client=heartbeat_redis,
        )

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
            await heartbeat_redis.aclose()

        # run() no vuelve mientras todo va bien: que hayamos llegado acá
        # significa que las dos fuentes terminaron, y eso siempre es un fallo.
        # Sin este raise el proceso saldría con 0 y Railway marcaría el deploy
        # como SUCCESS sobre un worker que no ingesta nada — exactamente el
        # incidente del seedlink (seedlink_ingestor.py:467-473).
        raise RuntimeError(
            "events_ingestor: la ingesta terminó — el proceso no puede continuar"
        ) from ingestor.failure

    asyncio.run(_main())

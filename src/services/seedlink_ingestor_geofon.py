"""Ingestor SeedLink del SEGUNDO servidor: geofon.gfz-potsdam.de (GFZ Potsdam).

Proceso independiente, hermano de seedlink_ingestor.py. Mismo molde que ya
usan watchdog.py / events_ingestor.py: un archivo propio con su __main__ y su
Dockerfile, no una rama condicional dentro de otro proceso.

Por qué un proceso aparte y no una env var en seedlink_ingestor.py: apagar
este servicio NO debe afectar al de rtserve.earthscope.org. Con un solo módulo
parametrizado, cualquier cambio hecho "solo para GEOFON" se despliega también
al proceso de rtserve en el próximo build, aunque nunca se dispare — el
aislamiento de fallos que se buscaba se diluye.

La clase SeedLinkIngestor y channels_from_catalog se IMPORTAN tal cual: acá no
se redefine ni una línea de la lógica de ingesta. Lo único distinto es el
servidor, el catálogo y el prefijo de los logs.

Diferencias deliberadas con el __main__ de seedlink_ingestor.py:
  - server="geofon.gfz-potsdam.de" explícito (el default de la clase es rtserve)
  - catálogo LIVE_CANDIDATES_GEOFON_BY_CITY en vez de LIVE_CANDIDATES_BY_CITY
  - SIN ephemeral_redis: la suscripción efímera es una feature de exploración
    ad-hoc del catálogo principal. Sumarla acá exige decidir antes cómo elegiría
    el usuario "efímero contra qué servidor", pregunta que no está resuelta.
  - prefijo de logs "seedlink_ingestor_geofon:" para poder distinguir en Railway
    cuál de los dos procesos escribió cada línea.
"""

import asyncio
import logging
import threading
from typing import Optional

from src.config.settings import settings
from src.services.event_bus import RedisPubSubBus
from src.services.metrics_store import MetricsStore
from src.services.seedlink_ingestor import SeedLinkIngestor, channels_from_catalog
from src.services.spectrogram_service import LIVE_CANDIDATES_GEOFON_BY_CITY
from src.services.timescale_service import TimescaleColumnWriter

logger = logging.getLogger(__name__)

# Servidor SeedLink de GEOFON (GFZ Potsdam). geofon.gfz.de es un alias del
# mismo servidor, no un catálogo distinto (verificado 2026-08-31).
GEOFON_SERVER = "geofon.gfz-potsdam.de"

DEFAULT_CHANNELS_GEOFON = channels_from_catalog(LIVE_CANDIDATES_GEOFON_BY_CITY)


if __name__ == "__main__":
    """
    Proceso independiente. Uso:
        python -m src.services.seedlink_ingestor_geofon

    Requiere Redis corriendo (settings.redis_url). Corre en paralelo al
    ingestor de rtserve, sin compartir proceso con él.
    """
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )

    async def _main() -> None:
        bus = RedisPubSubBus(settings.redis_url)
        await bus.connect()
        logger.info(
            "seedlink_ingestor_geofon: conectado a Redis en %s", settings.redis_url
        )

        column_writer: Optional[TimescaleColumnWriter] = None
        if settings.timescaledb_dsn is not None:
            # No conectar acá: el pool de asyncpg debe nacer en el loop del
            # ingestor (ver SeedLinkIngestor.run), no en este. Solo se
            # instancia para pasarle el DSN.
            column_writer = TimescaleColumnWriter(settings.timescaledb_dsn)
            logger.info(
                "seedlink_ingestor_geofon: TimescaleDB configurado en %s",
                settings.timescaledb_host,
            )
        else:
            logger.warning(
                "seedlink_ingestor_geofon: TimescaleDB no configurado "
                "(TIMESCALEDB_HOST vacío) — sin persistencia de historial, "
                "solo streaming en vivo por Redis"
            )

        # No conectar acá, por la misma razón que el column_writer: el cliente
        # de Redis se conecta dentro de run(), en el loop del ingestor.
        metrics_store = MetricsStore(settings.redis_url)

        ingestor = SeedLinkIngestor(
            bus,
            server=GEOFON_SERVER,
            column_writer=column_writer,
            metrics_store=metrics_store,
        )
        logger.info(
            "seedlink_ingestor_geofon: %d canales a suscribir contra %s",
            len(DEFAULT_CHANNELS_GEOFON),
            GEOFON_SERVER,
        )
        # run() es bloqueante y no-async: se corre en un hilo separado del
        # loop principal, que se queda vivo solo para mantener el proceso.
        thread = threading.Thread(
            target=ingestor.run, args=(DEFAULT_CHANNELS_GEOFON,), daemon=True
        )
        thread.start()

        try:
            while thread.is_alive():
                await asyncio.sleep(1)
        finally:
            if column_writer is not None and ingestor._loop is not None:
                # close() debe correr en el mismo loop donde vive el pool.
                asyncio.run_coroutine_threadsafe(
                    column_writer.close(), ingestor._loop
                ).result()
            # ingestor.metrics_store puede haber quedado en None si Redis no
            # estaba al arrancar: cerrar lo que no se conectó no aporta nada.
            if ingestor.metrics_store is not None and ingestor._loop is not None:
                try:
                    asyncio.run_coroutine_threadsafe(
                        ingestor.metrics_store.close(), ingestor._loop
                    ).result()
                except Exception:
                    logger.warning(
                        "seedlink_ingestor_geofon: fallo cerrando el MetricsStore",
                        exc_info=True,
                    )

        # El hilo es daemon y `run()` bloquea para siempre mientras todo va
        # bien: que hayamos salido del while significa que terminó, y eso
        # siempre es un fallo. Sin este raise el proceso salía con 0 y Railway
        # marcaba el deploy como SUCCESS sobre un ingestor que no ingesta nada.
        raise RuntimeError(
            "seedlink_ingestor_geofon: el hilo de ingesta terminó — "
            "el proceso no puede continuar"
        ) from ingestor.failure

    asyncio.run(_main())

"""
USGSPoller: red de seguridad del push (PR-W4, T5).

EMSC empuja en segundos, pero cubre mejor Europa y el Mediterráneo. USGS es la
referencia global y actualiza su feed cada ~60 s. Pollear USGS en paralelo
cubre dos huecos:

1. Sismos que EMSC no reporta o reporta tarde.
2. Los minutos en que el WebSocket de EMSC está caído y reconectando.

No reimplementa el fetch: usa `fetch_usgs_events` (usgs_service.py:17), que ya
es global sin bbox, ya mide latencia con Prometheus y ya normaliza a
SeismicEvent. Lo único que agrega es el loop y el manejo de errores.

Como el worker deduplica contra la tabla, que USGS reporte el mismo sismo que
ya trajo EMSC no duplica nada: cae en el `upsert` y a lo sumo suma "USGS" a las
fuentes de la fila existente.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Awaitable, Callable, Optional

from src.models.event import SeismicEvent
from src.services.usgs_service import fetch_usgs_events

logger = logging.getLogger(__name__)


# Cada 60 s: es la cadencia de actualización del feed de USGS, pollear más
# seguido sólo gasta llamadas para recibir lo mismo.
POLL_INTERVAL_SECONDS = 60.0

# Ventana que se pide en cada poll. Deliberadamente MUCHO más ancha que el
# intervalo (15 min contra 1): si un poll falla o el proceso se reinicia, el
# siguiente recupera lo perdido en vez de dejar un hueco. Traer de más es
# gratis porque el dedupe descarta lo ya conocido.
POLL_WINDOW_MINUTES = 15


class USGSPoller:
    """Consulta USGS cada `interval_s` y entrega cada evento por callback."""

    def __init__(
        self,
        on_event: Callable[[SeismicEvent], Awaitable[None]],
        interval_s: float = POLL_INTERVAL_SECONDS,
        window_minutes: int = POLL_WINDOW_MINUTES,
        min_magnitude: Optional[float] = None,
    ) -> None:
        self._on_event = on_event
        self._interval_s = interval_s
        self._window_minutes = window_minutes
        self._min_magnitude = min_magnitude
        self._running = False
        self.last_error: Optional[str] = None
        self.last_poll_count: int = 0

    def stop(self) -> None:
        self._running = False

    async def poll_once(self) -> int:
        """
        Un ciclo: consulta USGS y entrega lo que vino. Devuelve cuántos eventos
        se entregaron.

        Público a propósito: permite testear el ciclo sin arrancar el loop
        infinito ni manipular timers.
        """
        eventos, error = await fetch_usgs_events(
            window_minutes=self._window_minutes, min_magnitude=self._min_magnitude
        )
        self.last_error = error

        if error:
            # `fetch_usgs_events` ya devuelve lista vacía + error en vez de
            # levantar: USGS caído no debe matar al worker, EMSC sigue vivo.
            logger.warning("USGS: el poll falló (%s)", error)

        entregados = 0
        for evento in eventos:
            try:
                await self._on_event(evento)
                entregados += 1
            except asyncio.CancelledError:
                raise
            except Exception:
                # Igual que en EMSC: un evento que falla no corta el ciclo.
                logger.exception("USGS: fallo procesando el evento %s", evento.id)

        self.last_poll_count = entregados
        return entregados

    async def run(self) -> None:
        """Loop de polling. Vuelve sólo si se llamó a `stop()`."""
        self._running = True
        logger.info(
            "USGS: polling cada %.0f s con ventana de %d min",
            self._interval_s,
            self._window_minutes,
        )

        while self._running:
            try:
                await self.poll_once()
            except asyncio.CancelledError:
                raise
            except Exception:
                # Red de seguridad: cualquier cosa inesperada se registra y el
                # loop sigue. Este poller es el fallback del WS; si se muere en
                # silencio nos quedamos sin la red de seguridad justo cuando
                # más falta hace.
                logger.exception("USGS: error inesperado en el ciclo de polling")

            # Dormir en tramos cortos para que stop() no tarde un minuto
            # entero en surtir efecto.
            dormido = 0.0
            while self._running and dormido < self._interval_s:
                paso = min(1.0, self._interval_s - dormido)
                await asyncio.sleep(paso)
                dormido += paso

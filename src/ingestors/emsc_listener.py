"""
EMSCListener: WebSocket persistente contra EMSC SeismicPortal (PR-W4, T4).

URL: wss://www.seismicportal.eu/standing_order/websocket

Es la fuente de PUSH real del sistema: EMSC empuja el evento a los segundos de
ocurrido, contra los ~60 s del feed de USGS. Es lo que baja la latencia de
1-2 min a segundos.

Diseño:
- `parse_frame` es una función PURA: frame crudo → SeismicEvent | None. Se
  testea con dicts, sin red ni servidor falso. Es donde vive todo lo que puede
  salir mal con el formato de EMSC.
- `EMSCListener` sólo se ocupa de la conexión: reconexión con backoff
  exponencial + jitter y watchdog de silencio. No deduplica ni persiste — le
  pasa cada evento al callback y se olvida.

Diferencia deliberada con el plan de 2026-04-29 (que nunca se implementó):
aquel descartaba todo frame que no fuera `action == "create"`. Los frames
`update` son justamente las revisiones de magnitud que EMSC manda minutos
después, y ahora que hay dedupe + upsert (event_store.py) procesarlos
actualiza la fila en vez de duplicarla. Descartarlos era perder la corrección
de un M4.5 que resultó ser M5.2.
"""

from __future__ import annotations

import asyncio
import json
import logging
import random
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Optional

import websockets

from src.models.event import SeismicEvent

logger = logging.getLogger(__name__)


EMSC_WEBSOCKET_URL = "wss://www.seismicportal.eu/standing_order/websocket"

# Backoff exponencial con tope. Arranca en 1 s para que un corte de red breve
# se recupere rápido, y llega a 60 s para no martillar a EMSC si está caído.
INITIAL_BACKOFF_SECONDS = 1.0
MAX_BACKOFF_SECONDS = 60.0
BACKOFF_FACTOR = 2.0

# ±20 % de jitter: si el servicio se cae y vuelve, todos los clientes del mundo
# reconectarían al mismo segundo sin esto (thundering herd).
BACKOFF_JITTER = 0.2

# EMSC manda un evento cada varios minutos en un día tranquilo, así que el
# silencio NO es señal de conexión muerta por sí solo — por eso el umbral es
# alto. Es la misma clase de problema que el ChannelWatchdog de SeedLink: la
# TCP sigue viva y el cliente no ve ningún error.
SILENCE_TIMEOUT_SECONDS = 900.0
SILENCE_CHECK_INTERVAL_SECONDS = 30.0

# Frames que traen un evento. "create" es un sismo nuevo; "update" es una
# revisión del mismo (magnitud corregida, epicentro relocalizado). Los dos se
# procesan: el dedupe del store decide si inserta o actualiza.
EVENT_ACTIONS = frozenset({"create", "update"})


def parse_frame(raw: str | bytes) -> Optional[SeismicEvent]:
    """
    Frame crudo del WS de EMSC → SeismicEvent, o None si no es un evento.

    Función pura, sin red: todo lo que puede salir mal con el formato de EMSC
    se testea acá con dicts.

    Formato del frame (GeoJSON envuelto en un sobre con `action`):

        {"action": "create",
         "data": {"properties": {"time": "...", "mag": 4.0, "magtype": "mb",
                                 "flynn_region": "...", "unid": "..."},
                  "geometry": {"coordinates": [lon, lat, prof_km]}}}

    Devuelve None —sin levantar— ante cualquier frame que no podamos usar: un
    listener que explota por un frame raro se desconecta y deja de recibir los
    buenos. Perder un frame es barato; perder la conexión no.
    """
    try:
        msg = json.loads(raw)
    except (json.JSONDecodeError, TypeError, ValueError):
        logger.warning("EMSC: frame que no es JSON, descartado", exc_info=True)
        return None

    if not isinstance(msg, dict):
        return None
    if msg.get("action") not in EVENT_ACTIONS:
        return None

    data = msg.get("data")
    if not isinstance(data, dict):
        return None

    props = data.get("properties") or {}
    coords = (data.get("geometry") or {}).get("coordinates") or []

    # lon, lat en ese orden: es GeoJSON, no "lat, lon".
    if len(coords) < 2 or coords[0] is None or coords[1] is None:
        logger.warning("EMSC: frame sin coordenadas utilizables, descartado")
        return None

    hora = props.get("time")
    if not hora:
        logger.warning("EMSC: frame sin `time`, descartado")
        return None

    mag = props.get("mag")
    if mag is None:
        # Un evento sin magnitud no se puede pintar en el globo (el radio y el
        # color salen de ahí) ni filtrar por min_magnitude.
        logger.warning("EMSC: frame sin magnitud, descartado")
        return None

    unid = props.get("unid") or props.get("source_id")
    if not unid:
        logger.warning("EMSC: frame sin identificador, descartado")
        return None

    try:
        return SeismicEvent(
            # Prefijo de fuente en el id, igual que el resto del proyecto
            # (main.py:2310-2312 hace lo mismo para /events/{id}/detail).
            id=f"emsc_{unid}",
            fuentes=["EMSC"],
            hora_utc=hora if str(hora).endswith("Z") else f"{hora}Z",
            lat=float(coords[1]),
            lon=float(coords[0]),
            prof_km=float(coords[2]) if len(coords) > 2 and coords[2] is not None else None,
            mag=float(mag),
            mag_tipo=props.get("magtype"),
            lugar=props.get("flynn_region") or props.get("region") or props.get("place"),
            # EMSC no reporta si el sismo fue sentido en este feed.
            sentido=False,
            revisado=props.get("evtype") == "ke" or props.get("status") in ("reviewed", "manual"),
        )
    except (TypeError, ValueError):
        logger.warning("EMSC: frame con valores no numéricos, descartado", exc_info=True)
        return None


def backoff_delay(attempt: int) -> float:
    """
    Espera antes del intento número `attempt` (0-based), con jitter.

    Función aparte y determinista salvo por el jitter para poder testear la
    progresión 1 → 2 → 4 … → 60 sin esperar un minuto real.
    """
    base = min(INITIAL_BACKOFF_SECONDS * (BACKOFF_FACTOR**attempt), MAX_BACKOFF_SECONDS)
    jitter = base * BACKOFF_JITTER
    return max(0.0, base + random.uniform(-jitter, jitter))


class EMSCListener:
    """
    Mantiene la conexión al WS de EMSC y entrega cada evento por callback.

    No deduplica, no persiste, no publica: eso es del worker, que tiene el
    store y el bus. Acá sólo vive la conexión.
    """

    def __init__(
        self,
        on_event: Callable[[SeismicEvent], Awaitable[None]],
        url: str = EMSC_WEBSOCKET_URL,
        silence_timeout_s: float = SILENCE_TIMEOUT_SECONDS,
    ) -> None:
        self._on_event = on_event
        self._url = url
        self._silence_timeout_s = silence_timeout_s
        self._running = False
        self._last_message_at: Optional[datetime] = None
        self._connected = False
        # Igual que SeedLinkIngestor.failure (:104): guarda por qué murió, para
        # que el proceso pueda salir con código distinto de 0. Un worker que
        # muere en silencio con exit 0 hace que Railway marque SUCCESS sobre un
        # servicio que no ingesta nada.
        self.failure: Optional[BaseException] = None

    @property
    def connected(self) -> bool:
        return self._connected

    @property
    def seconds_since_last_message(self) -> Optional[float]:
        if self._last_message_at is None:
            return None
        return (datetime.now(timezone.utc) - self._last_message_at).total_seconds()

    def is_silent(self, now: Optional[datetime] = None) -> bool:
        """
        True si hace demasiado que no llega nada.

        Cuenta desde la última CONEXIÓN si todavía no llegó ningún mensaje: sin
        eso, un listener recién arrancado se declararía mudo al instante.
        """
        if self._last_message_at is None:
            return False
        now = now or datetime.now(timezone.utc)
        return (now - self._last_message_at).total_seconds() > self._silence_timeout_s

    def stop(self) -> None:
        self._running = False

    async def run(self) -> None:
        """
        Loop de conexión. Vuelve sólo si se llamó a `stop()`.

        Que salga por cualquier otro motivo es un fallo, y el worker lo trata
        como tal (ver el `raise` del __main__ de events_ingestor).
        """
        self._running = True
        attempt = 0

        while self._running:
            try:
                async with websockets.connect(self._url) as ws:
                    self._connected = True
                    self._last_message_at = datetime.now(timezone.utc)
                    attempt = 0  # reconexión exitosa: el backoff vuelve a cero
                    logger.info("EMSC: conectado a %s", self._url)
                    await self._consume(ws)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                # Cualquier error de red vuelve al backoff. NO se guarda en
                # `failure`: desconectarse es normal y esperado, lo anormal es
                # salir del while, que sólo pasa con stop().
                logger.warning(
                    "EMSC: conexión caída (%s), reintento en breve", exc, exc_info=True
                )
            finally:
                self._connected = False

            if not self._running:
                break

            delay = backoff_delay(attempt)
            attempt += 1
            logger.info("EMSC: reconectando en %.1f s (intento %d)", delay, attempt)
            await asyncio.sleep(delay)

    async def _consume(self, ws: Any) -> None:
        """Lee frames hasta que la conexión se cae o se llama a stop()."""
        async for raw in ws:
            self._last_message_at = datetime.now(timezone.utc)

            event = parse_frame(raw)
            if event is None:
                continue

            try:
                await self._on_event(event)
            except asyncio.CancelledError:
                raise
            except Exception:
                # Un fallo procesando UN evento no puede tirar la conexión: el
                # siguiente sismo tiene que llegar igual.
                logger.exception("EMSC: fallo procesando el evento %s", event.id)

            if not self._running:
                break

"""
Watchdog de canales del ingestor SeedLink.

Los streams SeedLink se caen de a uno: la estación deja de emitir pero la
conexión TCP sigue viva, así que el cliente no ve ningún error. La única
cura conocida es re-suscribir todo (lo que hasta ahora exigía un redeploy).

Esta clase contiene SOLO la decisión: qué canales están mudos y cuándo
conviene forzar una reconexión. No sabe de threads ni de sockets — el
cableado con el cliente vive en seedlink_ingestor.py. Así la lógica se
testea con timestamps, sin servidores falsos.

Cuarentena: una estación que sigue muda tras varias reconexiones (caso
CI.BAR el 20/8: conecta pero no entrega) no debe provocar reconexiones
infinitas. Tras `max_strikes` reconexiones sin revivir queda en cuarentena
y deja de gatillar; si algún día vuelve a mandar datos, sale sola.

Cuarentena REAL (caso IU.MAJO/IU.GUMO/IU.SNZO el 31/8: el servidor ya no
sirve esas 3 estaciones): la cuarentena de arriba solo evita que ESE canal
sea el que DISPARE la próxima reconexión, pero seedlink_ingestor.py seguía
re-suscribiendo TODO el catálogo (incluidos los cuarentenados) en CADA
reconexión, sin importar el motivo. `quarantined_channels()` expone la
lista para que el ingestor los excluya de `active_channels` de verdad.
Reversibilidad: cada `RELEASE_EVERY` reconexiones (ver `note_reconnect`) se
les da a TODOS los cuarentenados una chance más — se los libera y sus
strikes vuelven a 0, así si el servidor los revive vuelven a fluir, y si
siguen mudos vuelven a acumular strikes y quedan en cuarentena de nuevo. Es
el mismo ciclo de "revive solo con datos", pero con un timeout explícito en
vez de depender de que alguien note_data() a mano.
"""

from __future__ import annotations

import logging
import threading
from datetime import datetime

logger = logging.getLogger(__name__)


class ChannelWatchdog:
    """Decide cuándo reconectar según el silencio por canal.

    Thread-safe: `note_data` corre en el hilo de `client.run()` mientras
    `stale_channels`/`note_reconnect` corren en el hilo watchdog y en el de
    supervisión. El lock evita leer los dicts a mitad de una mutación
    compuesta (p. ej. dar un strike mientras `note_data` estaba sacando al
    canal de cuarentena).
    """

    # Cada cuántas reconexiones "reales" (note_reconnect) se libera a TODOS
    # los cuarentenados para darles una chance más. A stale_after_s=300 y con
    # el patrón real de reconexión (una cada ~5-6 min por otro canal mudo),
    # 12 reconexiones son ~1h — ni tan seguido como para no reducir nunca el
    # catálogo, ni tan raro como para tardar días en notar que el servidor
    # volvió a servir la estación.
    RELEASE_EVERY = 12

    def __init__(self, stale_after_s: float = 300, max_strikes: int = 3):
        self.stale_after_s = stale_after_s
        self.max_strikes = max_strikes
        self._lock = threading.Lock()
        # Último dato visto por canal; al (re)conectar arranca en `now` para
        # que un canal que nunca emitió también tenga punto de referencia.
        self._last_seen: dict[str, datetime] = {}
        self._strikes: dict[str, int] = {}
        # Cuenta reconexiones reales para saber cuándo toca liberar cuarentena.
        self._reconnect_count = 0

    def note_connected(self, channel_keys: list[str], now: datetime) -> None:
        """Registra la (re)conexión: baseline nuevo para todos los canales."""
        with self._lock:
            for key in channel_keys:
                self._last_seen[key] = now

    def note_data(self, channel_key: str, now: datetime) -> None:
        """Un canal emitió: se refresca y sale de cuarentena si estaba."""
        with self._lock:
            self._last_seen[channel_key] = now
            self._strikes.pop(channel_key, None)

    def stale_channels(self, now: datetime) -> list[str]:
        """Canales mudos hace más de `stale_after_s`, sin los cuarentenados."""
        with self._lock:
            return self._stale_locked(now)

    def _stale_locked(self, now: datetime) -> list[str]:
        return [
            key
            for key, last in self._last_seen.items()
            if (now - last).total_seconds() > self.stale_after_s
            and self._strikes.get(key, 0) < self.max_strikes
        ]

    def should_reconnect(self, now: datetime) -> bool:
        return bool(self.stale_channels(now))

    def quarantined_channels(self) -> list[str]:
        """Canales que agotaron `max_strikes`: seedlink_ingestor.py los debe
        excluir de `active_channels` en la próxima re-suscripción — es lo que
        hace real a la cuarentena (antes solo evitaba que ESE canal disparara
        la próxima reconexión, pero se seguía re-suscribiendo igual)."""
        with self._lock:
            return [key for key, strikes in self._strikes.items() if strikes >= self.max_strikes]

    def note_reconnect(self, now: datetime) -> None:
        """La reconexión ocurrió: strike a los mudos y baseline nuevo a todos.

        El baseline nuevo hace que nada sea stale por otro `stale_after_s`:
        el propio umbral funciona de cooldown entre reconexiones.

        Cada `RELEASE_EVERY` reconexiones se liberan TODOS los cuarentenados
        (strikes a 0): vuelven a `active_channels` en el próximo ciclo de
        run(). Si el servidor los revive, `note_data` los saca de cuarentena
        para siempre; si siguen mudos, vuelven a acumular strikes solos.
        """
        with self._lock:
            for key in self._stale_locked(now):
                self._strikes[key] = self._strikes.get(key, 0) + 1
            for key in self._last_seen:
                self._last_seen[key] = now
            self._reconnect_count += 1
            if self._reconnect_count % self.RELEASE_EVERY == 0:
                liberados = [k for k, s in self._strikes.items() if s >= self.max_strikes]
                if liberados:
                    for key in liberados:
                        self._strikes[key] = 0
                    logger.info(
                        "channel_watchdog: liberando %d canal(es) de cuarentena "
                        "para darles otra chance: %s",
                        len(liberados),
                        ", ".join(liberados),
                    )

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
"""

from __future__ import annotations

from datetime import datetime


class ChannelWatchdog:
    """Decide cuándo reconectar según el silencio por canal."""

    def __init__(self, stale_after_s: float = 300, max_strikes: int = 3):
        self.stale_after_s = stale_after_s
        self.max_strikes = max_strikes
        # Último dato visto por canal; al (re)conectar arranca en `now` para
        # que un canal que nunca emitió también tenga punto de referencia.
        self._last_seen: dict[str, datetime] = {}
        self._strikes: dict[str, int] = {}

    def note_connected(self, channel_keys: list[str], now: datetime) -> None:
        """Registra la (re)conexión: baseline nuevo para todos los canales."""
        for key in channel_keys:
            self._last_seen[key] = now

    def note_data(self, channel_key: str, now: datetime) -> None:
        """Un canal emitió: se refresca y sale de cuarentena si estaba."""
        self._last_seen[channel_key] = now
        self._strikes.pop(channel_key, None)

    def stale_channels(self, now: datetime) -> list[str]:
        """Canales mudos hace más de `stale_after_s`, sin los cuarentenados."""
        return [
            key
            for key, last in self._last_seen.items()
            if (now - last).total_seconds() > self.stale_after_s
            and self._strikes.get(key, 0) < self.max_strikes
        ]

    def should_reconnect(self, now: datetime) -> bool:
        return bool(self.stale_channels(now))

    def note_reconnect(self, now: datetime) -> None:
        """Se decidió reconectar: strike a los mudos y baseline nuevo a todos.

        El baseline nuevo hace que nada sea stale por otro `stale_after_s`:
        el propio umbral funciona de cooldown entre reconexiones.
        """
        for key in self.stale_channels(now):
            self._strikes[key] = self._strikes.get(key, 0) + 1
        self.note_connected(list(self._last_seen), now)

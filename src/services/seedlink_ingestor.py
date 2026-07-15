"""
Ingestor SeedLink: consume forma de onda continua en tiempo real (push, no
polling) y publica columnas de espectrograma al EventBus para que el API
las reenvíe a los clientes vía WebSocket.

Corre como PROCESO SEPARADO del API principal (ver __main__ al final).
client.run() de ObsPy es bloqueante y síncrono — nunca debe correr dentro
de una corrutina de FastAPI, igual que el bug de matplotlib bloqueando el
event loop que se corrigió en spectrogram_service.py.

Arquitectura (ver memoria del proyecto "architecture-seismic-spectrograms-live"):
    SeedLink (rtserve.earthscope.org:18000)
      -> buffer rodante por canal (obspy Stream)
      -> scipy.signal.spectrogram sobre la ventana reciente -> columna en dB
      -> EventBus.publish("spec:<NET.STA.LOC.CHA>", columna)
      -> FastAPI WebSocket /ws/spectrogram/{channel} reenvía a los navegadores
"""
from __future__ import annotations

import asyncio
import logging
import threading
from datetime import datetime, timezone
from typing import Optional

import numpy as np
from obspy import Stream, Trace
from obspy.clients.seedlink.easyseedlink import create_client
from scipy.signal import spectrogram as scipy_spectrogram

from src.config.settings import settings
from src.services.event_bus import EventBus, RedisPubSubBus
from src.services.timescale_service import TimescaleColumnWriter

logger = logging.getLogger(__name__)

# Banda de interés para el espectrograma (coincide con el resto del proyecto)
FMIN_HZ = 0.1
FMAX_HZ = 20.0

# Ventana rodante que se mantiene en memoria por canal, en segundos.
# Debe ser >= la ventana de FFT (WINDOW_SECONDS abajo) más margen.
BUFFER_SECONDS = 120

# Cada cuánta señal nueva acumulada se recalcula una columna (evita recomputar
# la FFT en cada paquete diminuto que llega).
COLUMN_INTERVAL_SECONDS = 4


class SeedLinkIngestor:
    """Consume 1+ canales SeedLink y publica columnas de espectrograma al bus."""

    def __init__(
        self,
        bus: EventBus,
        server: str = "rtserve.earthscope.org",
        column_writer: Optional[TimescaleColumnWriter] = None,
    ):
        self.bus = bus
        self.server = server
        self.column_writer = column_writer
        self._buffers: dict[str, Stream] = {}
        self._last_column_emit: dict[str, datetime] = {}
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._client = None

    def _on_data(self, trace: Trace) -> None:
        """Callback de ObsPy — corre en el hilo bloqueante de client.run()."""
        channel_id = trace.id  # ej. "IU.MAJO.00.BHZ"

        stream = self._buffers.setdefault(channel_id, Stream())
        stream += trace
        stream.merge(method=1, fill_value="interpolate")
        stream.trim(starttime=trace.stats.endtime - BUFFER_SECONDS)
        self._buffers[channel_id] = stream

        now = datetime.now(timezone.utc)
        last_emit = self._last_column_emit.get(channel_id)
        if last_emit and (now - last_emit).total_seconds() < COLUMN_INTERVAL_SECONDS:
            return

        column = self._compute_column(stream[0], channel_id)
        if column is None:
            return

        self._last_column_emit[channel_id] = now

        if self._loop is not None:
            asyncio.run_coroutine_threadsafe(
                self.bus.publish(f"spec:{channel_id}", column), self._loop
            )
            if self.column_writer is not None:
                asyncio.run_coroutine_threadsafe(
                    self.column_writer.add_column(column), self._loop
                )

    def _compute_column(self, trace: Trace, channel_id: str) -> Optional[dict]:
        """Calcula la última columna del espectrograma (instante más reciente)."""
        try:
            tr = trace.copy()
            tr.detrend("linear")
            tr.filter("bandpass", freqmin=FMIN_HZ, freqmax=FMAX_HZ, corners=4, zerophase=True)

            fs = tr.stats.sampling_rate
            if tr.stats.npts < int(fs * 4):
                return None  # todavía no hay suficiente señal para una ventana de FFT

            f, _t, sxx = scipy_spectrogram(
                tr.data, fs=fs, nperseg=int(fs * 4), noverlap=int(fs * 3)
            )
            mask = (f >= FMIN_HZ) & (f <= FMAX_HZ)
            power_db = 10 * np.log10(sxx[mask, -1] + 1e-12)

            return {
                "channel": channel_id,
                "endtime": str(tr.stats.endtime),
                "freqs": f[mask].round(2).tolist(),
                "power_db": power_db.round(1).tolist(),
            }
        except Exception:
            logger.warning("seedlink_ingestor: fallo calculando columna de %s", channel_id, exc_info=True)
            return None

    def run(self, channels: list[tuple[str, str, str]]) -> None:
        """
        Bloqueante. channels: lista de (network, station, channel), ej.
        [("IU", "MAJO", "BHZ"), ("II", "ERM", "BHZ")].
        Debe llamarse desde un hilo dedicado (ver __main__).
        """
        self._loop = asyncio.new_event_loop()
        threading.Thread(target=self._loop.run_forever, daemon=True).start()

        self._client = create_client(self.server, on_data=self._on_data)
        for net, sta, cha in channels:
            self._client.select_stream(net, sta, cha)
            logger.info("seedlink_ingestor: suscripto a %s.%s.%s", net, sta, cha)

        logger.info("seedlink_ingestor: conectando a %s ...", self.server)
        self._client.run()  # bloquea para siempre


# Estaciones conocidas con datos verificados (ver KNOWN_STATIONS en
# spectrogram_service.py, misma fuente de verdad para evitar duplicar
# el trabajo de verificación estación por estación).
DEFAULT_CHANNELS = [
    ("IU", "MAJO", "BHZ"),  # Tokyo
    ("II", "ERM", "BHZ"),  # Osaka
    ("UW", "LON", "HHZ"),  # Seattle
]


if __name__ == "__main__":
    """
    Proceso independiente. Uso:
        python -m src.services.seedlink_ingestor

    Requiere Redis corriendo (settings.redis_url). No se levanta con el API
    principal (uvicorn src.main:app) — es un proceso aparte, igual que
    src/adapters/inpres_adapter.py.
    """
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    async def _main() -> None:
        bus = RedisPubSubBus(settings.redis_url)
        await bus.connect()
        logger.info("seedlink_ingestor: conectado a Redis en %s", settings.redis_url)

        column_writer: Optional[TimescaleColumnWriter] = None
        if settings.timescaledb_dsn is not None:
            column_writer = TimescaleColumnWriter(settings.timescaledb_dsn)
            await column_writer.connect()
            logger.info("seedlink_ingestor: conectado a TimescaleDB en %s", settings.timescaledb_host)
        else:
            logger.warning(
                "seedlink_ingestor: TimescaleDB no configurado (TIMESCALEDB_HOST vacío) — "
                "sin persistencia de historial, solo streaming en vivo por Redis"
            )

        ingestor = SeedLinkIngestor(bus, column_writer=column_writer)
        # run() es bloqueante y no-async: se corre en un hilo separado del
        # loop principal, que se queda vivo solo para mantener el proceso.
        thread = threading.Thread(target=ingestor.run, args=(DEFAULT_CHANNELS,), daemon=True)
        thread.start()

        try:
            while thread.is_alive():
                await asyncio.sleep(1)
        finally:
            if column_writer is not None:
                await column_writer.close()

    asyncio.run(_main())

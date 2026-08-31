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
from typing import TYPE_CHECKING, Optional

import numpy as np
from obspy import Stream, Trace
from obspy.clients.seedlink.easyseedlink import create_client

if TYPE_CHECKING:
    import redis

from src.config.settings import settings
from src.services.channel_watchdog import ChannelWatchdog
from src.services.metrics_store import MetricsStore
from src.services.swarm_rsam import RsamAccumulator, rsam_sample
from src.services.swarm_spectra import (
    dominant_frequency_hz,
    frequency_index,
    peak_db,
    swarm_bin_samples,
    swarm_column_db,
)
from src.services.ephemeral_channels import list_requested_channels
from src.services.event_bus import EventBus, RedisPubSubBus
from src.services.spectrogram_service import LIVE_CANDIDATES_BY_CITY
from src.services.timescale_service import TimescaleColumnWriter

logger = logging.getLogger(__name__)

# Ventana rodante que se mantiene en memoria por canal, en segundos.
# Debe ser >= la ventana de FFT (WINDOW_SECONDS abajo) más margen.
BUFFER_SECONDS = 120

# Cada cuánta señal nueva acumulada se recalcula una columna (evita recomputar
# la FFT en cada paquete diminuto que llega).
COLUMN_INTERVAL_SECONDS = 4

# Un canal sin datos durante este tiempo se considera mudo. Alineado con el
# filtro de frescura de live-channels (10 min): reconectar a los 5 le da al
# canal la chance de reaparecer antes de que la UI lo dé de baja.
STALE_AFTER_SECONDS = 300

# Cada cuánto revisa el hilo watchdog si hay canales mudos.
CHECK_INTERVAL_SECONDS = 30

# Si tras reconectar y reconectar no llega UN dato de NINGÚN canal en este
# tiempo, el proceso muere con error: reconectar para siempre en silencio
# sería el viejo "deploy verde y mudo" con otro disfraz.
GIVE_UP_AFTER_SECONDS = 900

# Pausa entre ciclos de conexión.
RECONNECT_DELAY_SECONDS = 5

# Debounce del poll de canales efímeros (ephemeral_channels.py): agrupa
# pedidos que lleguen en esta ventana en UNA sola reconexión, en vez de
# cortar el streaming de los canales YA activos por cada pedido individual.
EPHEMERAL_POLL_INTERVAL_SECONDS = 8


class SeedLinkIngestor:
    """Consume 1+ canales SeedLink y publica columnas de espectrograma al bus."""

    def __init__(
        self,
        bus: EventBus,
        server: str = "rtserve.earthscope.org",
        column_writer: Optional[TimescaleColumnWriter] = None,
        stale_after_s: float = STALE_AFTER_SECONDS,
        check_interval_s: float = CHECK_INTERVAL_SECONDS,
        give_up_after_s: float = GIVE_UP_AFTER_SECONDS,
        reconnect_delay_s: float = RECONNECT_DELAY_SECONDS,
        metrics_store: Optional[MetricsStore] = None,
        ephemeral_redis: Optional["redis.Redis"] = None,
        ephemeral_poll_interval_s: float = EPHEMERAL_POLL_INTERVAL_SECONDS,
    ):
        self.bus = bus
        self.server = server
        self.column_writer = column_writer
        self.metrics_store = metrics_store
        self._rsam: dict[str, RsamAccumulator] = {}
        self.watchdog = ChannelWatchdog(stale_after_s=stale_after_s)
        self.check_interval_s = check_interval_s
        self.give_up_after_s = give_up_after_s
        self.reconnect_delay_s = reconnect_delay_s
        self._buffers: dict[str, Stream] = {}
        self._last_column_emit: dict[str, datetime] = {}
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._client = None
        self._last_any_data: Optional[datetime] = None
        self._stop = threading.Event()
        # Excepción que terminó el hilo de run(), si terminó por error. El
        # proceso principal la consulta para decidir su código de salida.
        self.failure: Optional[BaseException] = None
        # Canales efímeros (ephemeral_channels.py): sin cliente Redis, el
        # ingestor solo sirve el catálogo fijo — degrada solo, mismo criterio
        # que metrics_store cuando Redis no está disponible.
        self._ephemeral_redis = ephemeral_redis
        self._ephemeral_poll_interval_s = ephemeral_poll_interval_s
        self._base_channels: list[tuple[str, str, str]] = []
        self._ephemeral_channels: list[tuple[str, str, str]] = []

    def _on_data(self, trace: Trace) -> None:
        """Callback de ObsPy — corre en el hilo bloqueante de client.run()."""
        channel_id = trace.id  # ej. "IU.MAJO.00.BHZ"

        now_utc = datetime.now(timezone.utc)
        stats = trace.stats
        # El watchdog trabaja con la clave de suscripción (sin location code:
        # es el campo que el servidor resuelve solo y no se puede adivinar).
        self.watchdog.note_data(f"{stats.network}.{stats.station}.{stats.channel}", now_utc)
        self._last_any_data = now_utc

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
                asyncio.run_coroutine_threadsafe(self.column_writer.add_column(column), self._loop)

            # Métricas al final y a prueba de balas: la columna ya salió, así
            # que nada de lo que pase acá puede frenarla.
            metrics = self._compute_metrics(stream[0], channel_id, column, now)
            if metrics is not None:
                asyncio.run_coroutine_threadsafe(
                    self._publish_metrics(channel_id, metrics), self._loop
                )

    def _compute_column(self, trace: Trace, channel_id: str) -> Optional[dict]:
        """Calcula la última columna del espectrograma con paridad SWARM.

        Sin bandpass y con 20*log10 de la FFT cruda (ver swarm_spectra):
        así la escala fija 20-120 dB de SWARM aplica tal cual.
        """
        try:
            fs = trace.stats.sampling_rate
            if trace.stats.npts < swarm_bin_samples(fs):
                return None  # todavía no hay suficiente señal para un bin

            freqs, power_db = swarm_column_db(trace.data, fs)

            return {
                "channel": channel_id,
                "endtime": str(trace.stats.endtime),
                "freqs": freqs.round(2).tolist(),
                "power_db": power_db.round(1).tolist(),
            }
        except Exception:
            logger.warning(
                "seedlink_ingestor: fallo calculando columna de %s", channel_id, exc_info=True
            )
            return None

    def _compute_metrics(
        self, trace: Trace, channel_id: str, column: dict, now: datetime
    ) -> Optional[dict]:
        """Métricas de dominio del tick — SOLO de datos ya en mano (anti-OOM PR #25).

        RSAM muestrea el último tick del buffer; el resto sale de la columna
        recién calculada (mismas listas que ve el frontend).

        Corre en el hilo de ObsPy y DESPUÉS de publicar la columna: por eso
        atrapa todo. Un numpy que reviente acá se llevaría puesto el callback
        entero (y con él la ingesta), no solo las métricas.
        """
        try:
            acc = self._rsam.setdefault(channel_id, RsamAccumulator())
            tick = trace.slice(starttime=trace.stats.endtime - COLUMN_INTERVAL_SECONDS)
            acc.add(rsam_sample(np.asarray(tick.data)), now)

            rsam_value = acc.rsam(now)
            fi_value = frequency_index(column["freqs"], column["power_db"])
            freq_value = dominant_frequency_hz(column["freqs"], column["power_db"])
            return {
                "channel": channel_id,
                "endtime": column["endtime"],
                "rsam": round(rsam_value, 1) if rsam_value is not None else None,
                "freq_hz": round(freq_value, 2) if freq_value is not None else None,
                "fi": round(fi_value, 2) if fi_value is not None else None,
                "peak_db": peak_db(column["power_db"]),
                "events_hour": acc.events_last_hour(now),
            }
        except Exception:
            logger.warning(
                "seedlink_ingestor: fallo calculando métricas de %s",
                channel_id,
                exc_info=True,
            )
            return None

    async def _publish_metrics(self, channel_id: str, metrics: dict) -> None:
        """Best-effort: un fallo acá JAMÁS debe frenar la ingesta de columnas."""
        try:
            await self.bus.publish(f"metrics:{channel_id}", metrics)
            if self.metrics_store is not None:
                await self.metrics_store.set_snapshot(channel_id, metrics)
        except Exception:
            logger.warning(
                "seedlink_ingestor: fallo publicando métricas de %s",
                channel_id,
                exc_info=True,
            )

    def _watchdog_loop(self) -> None:
        """Hilo daemon: fuerza reconexión cuando hay canales mudos.

        `conn.terminate()` es la única vía thread-safe para sacar a `run()`
        de su loop (`close()` NO lo es — lo dice su propio docstring). Pero la
        señal puede PERDERSE: `collect()` resetea terminate_flag al reentrar,
        así que si terminate() cae entre dos collect(), no pega. Por eso acá
        solo se dispara y se reintenta en el próximo chequeo; los strikes se
        queman en el loop de supervisión cuando el ciclo termina DE VERDAD —
        si no, tres terminates perdidos dejarían al canal en cuarentena sin
        haber reconectado ni una vez.
        """
        while not self._stop.wait(self.check_interval_s):
            now = datetime.now(timezone.utc)
            client = self._client
            if client is None:
                continue
            stale = self.watchdog.stale_channels(now)
            if not stale:
                continue
            logger.warning(
                "seedlink_ingestor: canales mudos hace >%.0fs: %s — forzando reconexión",
                self.watchdog.stale_after_s,
                ", ".join(stale),
            )
            try:
                client.conn.terminate()
            except Exception:
                logger.exception("seedlink_ingestor: fallo terminando la conexión")

    def _ephemeral_poll_loop(self) -> None:
        """Hilo daemon: debounce de canales efímeros (ephemeral_channels.py).

        Agrupa pedidos que lleguen dentro de `_ephemeral_poll_interval_s` en
        UNA sola reconexión — sin esto, 5 usuarios abriendo 5 canales
        distintos en 10s serían 5 reconexiones completas del catálogo fijo.
        Mismo mecanismo de terminate() que _watchdog_loop, y misma advertencia:
        la señal puede perderse, pero el próximo poll la reintenta solo.
        """
        while not self._stop.wait(self._ephemeral_poll_interval_s):
            if self._ephemeral_redis is None:
                continue
            try:
                current = sorted(list_requested_channels(self._ephemeral_redis))
            except Exception:
                logger.warning(
                    "seedlink_ingestor: fallo consultando canales efímeros en Redis",
                    exc_info=True,
                )
                continue
            if current == sorted(self._ephemeral_channels):
                continue
            logger.info(
                "seedlink_ingestor: canales efímeros cambiaron (%d -> %d) — forzando reconexión",
                len(self._ephemeral_channels),
                len(current),
            )
            self._ephemeral_channels = current
            client = self._client
            if client is not None:
                try:
                    client.conn.terminate()
                except Exception:
                    logger.exception("seedlink_ingestor: fallo terminando la conexión")

    def stop(self) -> None:
        """Corte ordenado (lo usan los tests; en producción el proceso vive)."""
        self._stop.set()
        client = self._client
        if client is not None:
            try:
                client.conn.terminate()
            except Exception:
                pass

    def run(self, channels: list[tuple[str, str, str]]) -> None:
        """
        Bloqueante. channels: lista de (network, station, channel), ej.
        [("IU", "MAJO", "BHZ"), ("II", "ERM", "BHZ")].
        Debe llamarse desde un hilo dedicado (ver __main__).

        Loop de supervisión: cada ciclo crea el cliente, se suscribe y corre
        hasta que el watchdog (o el servidor) termina la conexión; entonces
        reconecta y re-suscribe todo, que es lo que revive a los streams que
        se caen de a uno. Un fallo en el PRIMER ciclo sin haber recibido nunca
        datos se propaga como antes (arranque roto = exit code visible), igual
        que pasar `give_up_after_s` reconectando sin recibir nada.

        Cualquier excepción fatal se loguea acá y se guarda en `self.failure`
        antes de propagarse: al correr en un hilo, el traceback no llega solo
        al proceso principal y el arranque fallido queda invisible.
        """
        try:
            self._loop = asyncio.new_event_loop()
            threading.Thread(target=self._loop.run_forever, daemon=True).start()

            if self.column_writer is not None:
                # El pool de asyncpg debe nacer en el mismo loop donde después se
                # usa (add_column corre vía run_coroutine_threadsafe en self._loop);
                # conectarlo en el loop de _main() revienta con "attached to a
                # different loop" en cada flush.
                asyncio.run_coroutine_threadsafe(
                    self.column_writer.connect(), self._loop
                ).result()

            if self.metrics_store is not None:
                # Misma regla que el pool de asyncpg: el cliente de Redis nace
                # en el loop donde se usa. Y es best-effort: sin Redis se pierden
                # las métricas, no la ingesta de columnas.
                try:
                    asyncio.run_coroutine_threadsafe(
                        self.metrics_store.connect(), self._loop
                    ).result()
                except Exception:
                    logger.warning(
                        "seedlink_ingestor: MetricsStore no pudo conectar — "
                        "sigo sin snapshots de métricas",
                        exc_info=True,
                    )
                    self.metrics_store = None

            self._base_channels = channels
            threading.Thread(target=self._watchdog_loop, daemon=True).start()
            if self._ephemeral_redis is not None:
                threading.Thread(target=self._ephemeral_poll_loop, daemon=True).start()

            started_at = datetime.now(timezone.utc)
            first_attempt = True
            while not self._stop.is_set():
                now = datetime.now(timezone.utc)
                last_signal = self._last_any_data or started_at
                if (
                    not first_attempt
                    and (now - last_signal).total_seconds() >= self.give_up_after_s
                ):
                    raise RuntimeError(
                        "seedlink_ingestor: sin datos de ningún canal hace "
                        f"{self.give_up_after_s:.0f}s pese a reconectar — me rindo "
                        "para que el fallo sea visible y el proceso se reinicie"
                    )
                # Recalculado en CADA ciclo: un canal efímero pedido después
                # del arranque solo entra en la próxima reconexión, que es
                # justo lo que dispara _ephemeral_poll_loop al detectar el
                # cambio.
                candidate_channels = self._base_channels + self._ephemeral_channels
                # Cuarentena REAL: un canal que agotó max_strikes (ej. el
                # servidor ya no lo sirve — caso IU.MAJO/GUMO/SNZO del 31/8)
                # no vuelve a re-suscribirse hasta que ChannelWatchdog lo
                # libere (ver RELEASE_EVERY). Sin este filtro la cuarentena
                # de ChannelWatchdog solo evitaba que ESE canal disparara la
                # PRÓXIMA reconexión, pero cualquier otro motivo (otro canal
                # mudo, un efímero nuevo) lo volvía a incluir igual.
                quarantined = set(self.watchdog.quarantined_channels())
                active_channels = [
                    (net, sta, cha)
                    for net, sta, cha in candidate_channels
                    if f"{net}.{sta}.{cha}" not in quarantined
                ]
                if quarantined:
                    excluded = quarantined & {
                        f"{net}.{sta}.{cha}" for net, sta, cha in candidate_channels
                    }
                    if excluded:
                        logger.warning(
                            "seedlink_ingestor: excluyendo %d canal(es) en cuarentena "
                            "de la resuscripción: %s",
                            len(excluded),
                            ", ".join(sorted(excluded)),
                        )
                channel_keys = [f"{net}.{sta}.{cha}" for net, sta, cha in active_channels]
                try:
                    client = create_client(self.server, on_data=self._on_data)
                    for net, sta, cha in active_channels:
                        client.select_stream(net, sta, cha)
                        logger.info(
                            "seedlink_ingestor: suscripto a %s.%s.%s", net, sta, cha
                        )
                    self.watchdog.note_connected(channel_keys, datetime.now(timezone.utc))
                    # Publicado recién acá: el watchdog solo debe poder terminar
                    # un cliente ya suscripto, no uno a medio armar.
                    self._client = client
                    logger.info("seedlink_ingestor: conectando a %s ...", self.server)
                    client.run()  # bloquea hasta terminate() o END del server
                    logger.warning(
                        "seedlink_ingestor: streaming terminado — reconectando en %.0fs",
                        self.reconnect_delay_s,
                    )
                except BaseException:
                    if first_attempt and self._last_any_data is None:
                        # Arranque roto de verdad: propagar como siempre.
                        raise
                    logger.exception(
                        "seedlink_ingestor: ciclo de streaming con error — "
                        "reintento en %.0fs",
                        self.reconnect_delay_s,
                    )
                # El ciclo terminó: la reconexión va a ocurrir de verdad. Recién
                # acá se queman strikes de los canales que siguen mudos (ver
                # _watchdog_loop: hacerlo al disparar contaba terminates
                # perdidos como reconexiones).
                self.watchdog.note_reconnect(datetime.now(timezone.utc))
                first_attempt = False
                self._stop.wait(self.reconnect_delay_s)
        except BaseException as exc:
            # `BaseException` y no `Exception`: un KeyboardInterrupt o un
            # SystemExit dentro del hilo también tienen que quedar registrados,
            # o el proceso vuelve a salir con 0 como si todo hubiera ido bien.
            self.failure = exc
            logger.exception("seedlink_ingestor: el ingestor terminó con error")
            raise
        finally:
            self._stop.set()


def channels_from_catalog(
    candidates_by_city: dict[str, list[str]],
) -> list[tuple[str, str, str]]:
    """Canales a suscribir, derivados del catálogo multi-candidata.

    Antes esta lista estaba escrita a mano y en paralelo a la del service, con
    un comentario que decía "misma fuente de verdad" sobre dos listas que había
    que sincronizar de memoria. Al ampliar de 3 a 26 ciudades eso deja de ser
    un detalle: agregar una ciudad en un lado y olvidarla en el otro da un
    canal que el front ofrece como "Vivo" y que nadie está transmitiendo.

    Se suscriben TODAS las candidatas (primaria + respaldos): si el respaldo
    no produce columnas, el failover de resolve_live_catalog es teatro.

    El service publica canales SEED completos ("IU.TATO.00.BHZ") y SeedLink
    se suscribe por (red, estación, canal): el location code se descarta acá
    porque el servidor lo resuelve solo, y es justamente el campo que no se
    puede escribir de memoria.
    """
    canales = []
    for candidates in candidates_by_city.values():
        for seed_id in candidates:
            net, sta, _loc, chan = seed_id.split(".")
            par = (net, sta, chan)
            if par not in canales:  # ciudades pueden compartir estación
                canales.append(par)
    return canales


DEFAULT_CHANNELS = channels_from_catalog(LIVE_CANDIDATES_BY_CITY)


if __name__ == "__main__":
    """
    Proceso independiente. Uso:
        python -m src.services.seedlink_ingestor

    Requiere Redis corriendo (settings.redis_url). No se levanta con el API
    principal (uvicorn src.main:app) — es un proceso aparte.
    """
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )

    async def _main() -> None:
        bus = RedisPubSubBus(settings.redis_url)
        await bus.connect()
        logger.info("seedlink_ingestor: conectado a Redis en %s", settings.redis_url)

        column_writer: Optional[TimescaleColumnWriter] = None
        if settings.timescaledb_dsn is not None:
            # No conectar acá: el pool de asyncpg debe nacer en el loop del
            # ingestor (ver SeedLinkIngestor.run), no en este. Solo se
            # instancia para pasarle el DSN.
            column_writer = TimescaleColumnWriter(settings.timescaledb_dsn)
            logger.info(
                "seedlink_ingestor: TimescaleDB configurado en %s", settings.timescaledb_host
            )
        else:
            logger.warning(
                "seedlink_ingestor: TimescaleDB no configurado (TIMESCALEDB_HOST vacío) — "
                "sin persistencia de historial, solo streaming en vivo por Redis"
            )

        # No conectar acá, por la misma razón que el column_writer: el cliente
        # de Redis se conecta dentro de run(), en el loop del ingestor.
        metrics_store = MetricsStore(settings.redis_url)

        # Cliente Redis SÍNCRONO para el poll de canales efímeros (ver
        # ephemeral_channels.py): corre en un hilo sin loop de asyncio propio,
        # igual que _watchdog_loop. Best-effort: sin Redis, el ingestor sirve
        # solo el catálogo fijo.
        import redis as _redis_sync

        try:
            ephemeral_redis = _redis_sync.Redis.from_url(settings.redis_url)
            ephemeral_redis.ping()
        except Exception:
            logger.warning(
                "seedlink_ingestor: Redis síncrono no disponible — canales "
                "efímeros deshabilitados, solo catálogo fijo",
                exc_info=True,
            )
            ephemeral_redis = None

        ingestor = SeedLinkIngestor(
            bus,
            column_writer=column_writer,
            metrics_store=metrics_store,
            ephemeral_redis=ephemeral_redis,
        )
        # run() es bloqueante y no-async: se corre en un hilo separado del
        # loop principal, que se queda vivo solo para mantener el proceso.
        thread = threading.Thread(target=ingestor.run, args=(DEFAULT_CHANNELS,), daemon=True)
        thread.start()

        try:
            while thread.is_alive():
                await asyncio.sleep(1)
        finally:
            if column_writer is not None and ingestor._loop is not None:
                # close() debe correr en el mismo loop donde vive el pool.
                asyncio.run_coroutine_threadsafe(column_writer.close(), ingestor._loop).result()
            # ingestor.metrics_store puede haber quedado en None si Redis no
            # estaba al arrancar: cerrar lo que no se conectó no aporta nada.
            if ingestor.metrics_store is not None and ingestor._loop is not None:
                try:
                    asyncio.run_coroutine_threadsafe(
                        ingestor.metrics_store.close(), ingestor._loop
                    ).result()
                except Exception:
                    logger.warning(
                        "seedlink_ingestor: fallo cerrando el MetricsStore", exc_info=True
                    )

        # El hilo es daemon y `run()` bloquea para siempre mientras todo va
        # bien: que hayamos salido del while significa que terminó, y eso
        # siempre es un fallo. Sin este raise el proceso salía con 0 y Railway
        # marcaba el deploy como SUCCESS sobre un ingestor que no ingesta nada.
        raise RuntimeError(
            "seedlink_ingestor: el hilo de ingesta terminó — el proceso no puede continuar"
        ) from ingestor.failure

    asyncio.run(_main())

"""
Tests del arranque del ingestor SeedLink.

El bug que motivó estos tests: `run()` corre en un hilo daemon y no tenía
try/except. Si reventaba al conectar, la excepción moría dentro del hilo, el
proceso principal salía del `while thread.is_alive()` y terminaba con código 0.
Railway marcaba el deploy `SUCCESS` sobre un ingestor que no ingestaba nada, y
sin PYTHONUNBUFFERED los logs se perdían en el buffer: silencio total.
"""

import asyncio
import threading
import time
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock

import numpy as np
import pytest
from obspy import Trace, UTCDateTime

from src.services.seedlink_ingestor import SeedLinkIngestor, channels_from_catalog


class _BoomClient:
    """Cliente de SeedLink que revienta al correr, como un servidor caído."""

    def __init__(self, *args, **kwargs):
        pass

    def select_stream(self, *args, **kwargs):
        pass

    def run(self):
        raise ConnectionError("no se pudo conectar al servidor SeedLink")


def test_run_registra_la_excepcion_en_failure(monkeypatch):
    """Un fallo en el hilo tiene que quedar accesible desde afuera."""
    monkeypatch.setattr(
        "src.services.seedlink_ingestor.create_client",
        lambda *a, **kw: _BoomClient(),
    )
    ingestor = SeedLinkIngestor(bus=MagicMock())

    with pytest.raises(ConnectionError):
        ingestor.run([("IU", "MAJO", "BHZ")])

    # Sin esto el proceso principal no tiene forma de distinguir un cierre
    # ordenado de un arranque fallido.
    assert isinstance(ingestor.failure, ConnectionError)


def test_la_excepcion_del_hilo_no_llega_sola_al_proceso_principal(monkeypatch):
    """
    Fija el MECANISMO del bug, no sólo el síntoma: correr `run()` en un hilo
    hace que la excepción no se propague al principal. Es la razón por la que
    `failure` y el exit code explícito son necesarios; si algún día Python
    cambiara esto, el test avisa.
    """
    monkeypatch.setattr(
        "src.services.seedlink_ingestor.create_client",
        lambda *a, **kw: _BoomClient(),
    )
    ingestor = SeedLinkIngestor(bus=MagicMock())

    thread = threading.Thread(
        target=lambda: ingestor.run([("IU", "MAJO", "BHZ")]), daemon=True
    )
    thread.start()
    thread.join(timeout=5)

    assert not thread.is_alive(), "el hilo debería haber terminado por la excepción"
    # El hilo murió sin que nadie afuera se enterara por vía de excepción: la
    # única señal es `failure`.
    assert ingestor.failure is not None


# ---------------------------------------------------------------------------
# Watchdog de reconexión por canal (memoria: los streams se caen de a uno,
# la conexión TCP sigue viva y la única cura era un redeploy).
# ---------------------------------------------------------------------------


class _FakeConn:
    """Imita SeedLinkConnection: terminate() hace salir a run() limpio."""

    def __init__(self, client: "_FakeClient"):
        self._client = client

    def terminate(self):
        self._client.terminated.set()


class _FakeClient:
    """Cliente cuyo run() bloquea hasta que el watchdog llama terminate()."""

    def __init__(self):
        self.terminated = threading.Event()
        self.conn = _FakeConn(self)
        self.selected: list[tuple] = []

    def select_stream(self, net, sta, cha):
        self.selected.append((net, sta, cha))

    def run(self):
        self.terminated.wait(timeout=10)


def _trace(net="UW", sta="LON", cha="HHZ") -> Trace:
    # 2 muestras: no alcanza para una columna (npts < fs*4), así _on_data
    # registra actividad y corta antes de publicar al bus.
    return Trace(
        data=np.zeros(2),
        header={"network": net, "station": sta, "channel": cha, "sampling_rate": 1.0},
    )


def _ingestor_rapido(**kwargs) -> "SeedLinkIngestor":
    defaults = dict(
        stale_after_s=0.15,
        check_interval_s=0.03,
        give_up_after_s=30,
        reconnect_delay_s=0.01,
    )
    defaults.update(kwargs)
    return SeedLinkIngestor(bus=MagicMock(), **defaults)


def test_on_data_registra_actividad_en_el_watchdog():
    # Umbral holgado a propósito: este test verifica el CABLEADO (_on_data →
    # watchdog), no el timing. Con 0.15s el primer _compute_column en frío
    # tardaba más que el umbral y el test flaqueaba bajo coverage.
    ingestor = _ingestor_rapido(stale_after_s=60)
    hace_rato = datetime.now(timezone.utc) - timedelta(seconds=600)
    ingestor.watchdog.note_connected(["UW.LON.HHZ"], now=hace_rato)

    ingestor._on_data(_trace())

    ahora = datetime.now(timezone.utc)
    assert ingestor.watchdog.stale_channels(now=ahora) == []


def test_canal_mudo_fuerza_reconexion_y_resuscribe(monkeypatch):
    """Sin datos, todos los canales se vuelven stale: el watchdog termina el
    cliente y el loop de supervisión crea uno nuevo con las mismas streams."""
    creados: list[_FakeClient] = []

    def _factory(*args, **kwargs):
        client = _FakeClient()
        creados.append(client)
        return client

    monkeypatch.setattr("src.services.seedlink_ingestor.create_client", _factory)
    ingestor = _ingestor_rapido()

    thread = threading.Thread(
        target=lambda: ingestor.run([("UW", "LON", "HHZ")]), daemon=True
    )
    thread.start()
    deadline = time.monotonic() + 5
    while len(creados) < 2 and time.monotonic() < deadline:
        time.sleep(0.02)
    ingestor.stop()
    thread.join(timeout=5)

    assert len(creados) >= 2, "el watchdog debió forzar al menos una reconexión"
    assert creados[1].selected == [("UW", "LON", "HHZ")]


def test_sin_ningun_dato_en_give_up_after_el_proceso_muere(monkeypatch):
    """Reconectar para siempre sin recibir NADA sería el viejo deploy verde y
    mudo con otro disfraz: pasado give_up_after el proceso tiene que morir
    con error para que Railway lo reinicie y el fallo quede visible."""
    monkeypatch.setattr(
        "src.services.seedlink_ingestor.create_client", lambda *a, **kw: _FakeClient()
    )
    ingestor = _ingestor_rapido(give_up_after_s=0.4)

    with pytest.raises(RuntimeError):
        ingestor.run([("UW", "LON", "HHZ")])

    assert isinstance(ingestor.failure, RuntimeError)


def test_error_tras_haber_recibido_datos_reconecta_en_vez_de_morir(monkeypatch):
    """Un corte del servidor después de haber estado transmitiendo no es un
    arranque fallido: se reintenta con backoff en vez de matar el proceso."""
    creados: list = []

    class _ClientQueEmiteYMuere(_FakeClient):
        def __init__(self, on_data):
            super().__init__()
            self._on_data = on_data

        def run(self):
            self._on_data(_trace())
            raise ConnectionError("el servidor cortó la conexión")

    def _factory(server, on_data):
        client = (
            _ClientQueEmiteYMuere(on_data) if len(creados) == 0 else _FakeClient()
        )
        creados.append(client)
        return client

    monkeypatch.setattr("src.services.seedlink_ingestor.create_client", _factory)
    ingestor = _ingestor_rapido()

    thread = threading.Thread(
        target=lambda: ingestor.run([("UW", "LON", "HHZ")]), daemon=True
    )
    thread.start()
    deadline = time.monotonic() + 5
    while len(creados) < 2 and time.monotonic() < deadline:
        time.sleep(0.02)
    ingestor.stop()
    thread.join(timeout=5)

    assert len(creados) >= 2, "tras el ConnectionError debió reconectar"
    assert ingestor.failure is None


class _ClienteSordo(_FakeClient):
    """Cliente cuyo conn ignora terminate(): simula la carrera real de ObsPy
    donde collect() resetea terminate_flag al reentrar y la señal se pierde."""

    def __init__(self):
        super().__init__()
        self.terminates = 0
        self.conn = self  # el propio cliente hace de conn

    def terminate(self):
        self.terminates += 1  # ignora la señal: run() sigue bloqueado


def test_terminate_perdido_se_reintenta_sin_quemar_strikes(monkeypatch):
    """La señal de terminate puede perderse (collect() la pisa al reentrar).
    El watchdog debe reintentar en cada chequeo, y NO quemar strikes hasta
    que la reconexión ocurra de verdad — si no, tres terminates perdidos
    dejan al canal en cuarentena sin haber reconectado ni una vez."""
    cliente = _ClienteSordo()
    monkeypatch.setattr(
        "src.services.seedlink_ingestor.create_client", lambda *a, **kw: cliente
    )
    ingestor = _ingestor_rapido()  # max_strikes default = 3

    thread = threading.Thread(
        target=lambda: ingestor.run([("UW", "LON", "HHZ")]), daemon=True
    )
    thread.start()
    deadline = time.monotonic() + 5
    # Con strikes quemados por intento, el watchdog se rinde en 3 terminates.
    while cliente.terminates < 5 and time.monotonic() < deadline:
        time.sleep(0.02)
    ingestor.stop()
    cliente.terminated.set()
    thread.join(timeout=5)

    assert cliente.terminates >= 5, (
        "el watchdog dejó de reintentar: quemó strikes por terminates perdidos"
    )


def test_canal_muerto_permanente_quema_strikes_solo_al_reconectar(monkeypatch):
    """Con reconexiones REALES, un canal que nunca revive queda en cuarentena
    tras max_strikes ciclos y las reconexiones paran: exactamente 1 cliente
    inicial + max_strikes reconexiones, ni una más."""
    creados: list[_FakeClient] = []

    def _factory(*args, **kwargs):
        client = _FakeClient()
        creados.append(client)
        return client

    monkeypatch.setattr("src.services.seedlink_ingestor.create_client", _factory)
    ingestor = _ingestor_rapido(give_up_after_s=30)

    thread = threading.Thread(
        target=lambda: ingestor.run([("UW", "LON", "HHZ")]), daemon=True
    )
    thread.start()
    deadline = time.monotonic() + 5
    while len(creados) < 4 and time.monotonic() < deadline:
        time.sleep(0.02)
    # Tiempo de sobra para una quinta conexión que NO debe ocurrir.
    time.sleep(0.5)
    ingestor.stop()
    thread.join(timeout=5)

    assert len(creados) == 4, (
        f"esperaba 1 conexión + 3 reconexiones (cuarentena), hubo {len(creados)}"
    )


def test_canal_en_cuarentena_no_se_resuscribe_por_otro_motivo(monkeypatch):
    """EL BUG REAL (caso IU.MAJO/GUMO/SNZO del 31/8, servidor que ya no sirve
    esas estaciones): un canal cuarentenado (max_strikes agotados) no debe
    volver a aparecer en `selected` de una reconexión disparada por CUALQUIER
    otro motivo — acá, un canal efímero nuevo. Antes de este fix, el filtro
    de cuarentena solo evitaba que ESE canal disparara la PRÓXIMA reconexión,
    pero `active_channels` seguía incluyéndolo siempre iba en `client.
    select_stream(...)` de cada ciclo."""
    creados: list[_FakeClient] = []

    def _factory(*args, **kwargs):
        client = _FakeClient()
        creados.append(client)
        return client

    monkeypatch.setattr("src.services.seedlink_ingestor.create_client", _factory)
    # UW.LON siempre vivo (nunca stale); JP.JYT nunca manda datos y stale_after_s
    # bajo hace que agote max_strikes rápido con reconexiones reales.
    fake_redis = _FakeEphemeralRedis([])
    ingestor = _ingestor_rapido(
        give_up_after_s=30, ephemeral_redis=fake_redis, ephemeral_poll_interval_s=0.03
    )

    # Mantiene vivo a UW.LON.HHZ manualmente para que JP.JYT sea el único
    # mudo y las reconexiones sean atribuibles solo a él.
    def _keep_uw_alive():
        while not ingestor._stop.is_set():
            ingestor.watchdog.note_data("UW.LON.HHZ", datetime.now(timezone.utc))
            time.sleep(0.01)

    keeper = threading.Thread(target=_keep_uw_alive, daemon=True)
    keeper.start()

    thread = threading.Thread(
        target=lambda: ingestor.run([("UW", "LON", "HHZ"), ("JP", "JYT", "BHZ")]),
        daemon=True,
    )
    thread.start()
    # 1 inicial + 3 reconexiones ponen a JP.JYT en cuarentena.
    deadline = time.monotonic() + 5
    while len(creados) < 4 and time.monotonic() < deadline:
        time.sleep(0.02)
    assert len(creados) >= 4, "JP.JYT debió agotar sus strikes y quedar en cuarentena"

    # Ahora fuerzo una reconexión por OTRO motivo (canal efímero nuevo) y
    # verifico que JP.JYT NO vuelva a re-suscribirse pese a estar en la
    # lista de canales base que se pasó a run().
    fake_redis._keys = ["ephemeral_channel:IU.MAJO.00.BHZ"]
    deadline = time.monotonic() + 5
    while len(creados) < 5 and time.monotonic() < deadline:
        time.sleep(0.02)
    ingestor.stop()
    keeper.join(timeout=2)
    thread.join(timeout=5)

    assert len(creados) >= 5, "el canal efímero debió forzar una reconexión más"
    ultimo = creados[-1]
    assert ("JP", "JYT", "BHZ") not in ultimo.selected, (
        "el canal en cuarentena se re-suscribió igual pese a haber agotado "
        "sus strikes — la cuarentena no está siendo respetada"
    )
    assert ("UW", "LON", "HHZ") in ultimo.selected
    assert ("IU", "MAJO", "BHZ") in ultimo.selected


# ---------------------------------------------------------------------------
# Derivación de suscripciones del catálogo multi-candidata: el ingestor debe
# suscribir TODAS las candidatas (primaria + respaldos), no solo la primaria
# — si no, el respaldo nunca produce columnas y el failover es teatro.
# ---------------------------------------------------------------------------


def test_channels_from_catalog_incluye_respaldos_y_deduplica():
    candidatas = {
        "sandiego": ["CI.BAR..BHZ", "CI.PLM..BHZ"],
        # Otra ciudad comparte estación con distinto location code: para
        # SeedLink es la misma suscripción (net, sta, cha) — se descarta loc.
        "otra": ["CI.PLM.00.BHZ", "UW.LON..HHZ"],
    }
    assert channels_from_catalog(candidatas) == [
        ("CI", "BAR", "BHZ"),
        ("CI", "PLM", "BHZ"),
        ("UW", "LON", "HHZ"),
    ]


# ---------------------------------------------------------------------------
# Canales efímeros (ephemeral_channels.py): un canal fuera del catálogo fijo
# pedido en Redis debe entrar en la PRÓXIMA reconexión, sin tocar la lista de
# canales que ya llegaron por parámetro a run().
# ---------------------------------------------------------------------------


class _FakeEphemeralRedis:
    """Imita lo mínimo de redis.Redis que usa ephemeral_channels: scan_iter."""

    def __init__(self, keys: list[str]):
        self._keys = keys

    def scan_iter(self, match: str):
        return iter(self._keys)


def test_canal_efimero_se_suma_en_la_proxima_reconexion(monkeypatch):
    creados: list[_FakeClient] = []

    def _factory(*args, **kwargs):
        client = _FakeClient()
        creados.append(client)
        return client

    monkeypatch.setattr("src.services.seedlink_ingestor.create_client", _factory)
    fake_redis = _FakeEphemeralRedis(["ephemeral_channel:IU.MAJO.00.BHZ"])
    ingestor = _ingestor_rapido(
        ephemeral_redis=fake_redis, ephemeral_poll_interval_s=0.03
    )

    thread = threading.Thread(
        target=lambda: ingestor.run([("UW", "LON", "HHZ")]), daemon=True
    )
    thread.start()
    deadline = time.monotonic() + 5
    while len(creados) < 2 and time.monotonic() < deadline:
        time.sleep(0.02)
    ingestor.stop()
    thread.join(timeout=5)

    assert len(creados) >= 2, "el poll de efímeros debió forzar una reconexión"
    # El primer cliente NO tenía el canal efímero (llegó recién en el poll);
    # el segundo sí, sumado al catálogo fijo que vino por parámetro.
    assert creados[0].selected == [("UW", "LON", "HHZ")]
    assert ("IU", "MAJO", "BHZ") in creados[1].selected
    assert ("UW", "LON", "HHZ") in creados[1].selected


def test_sin_cambios_en_efimeros_no_fuerza_reconexion(monkeypatch):
    creados: list[_FakeClient] = []

    def _factory(*args, **kwargs):
        client = _FakeClient()
        creados.append(client)
        return client

    monkeypatch.setattr("src.services.seedlink_ingestor.create_client", _factory)
    # Redis SIN canales efímeros: la lista vigente (vacía) no cambia nunca
    # respecto al estado inicial (también vacío) — no hay reconexión que forzar.
    # stale_after_s alto A PROPÓSITO: aísla la variable bajo prueba (el poll de
    # efímeros) del watchdog de canales mudos, que en _ingestor_rapido por
    # default reconectaría solo por falta de datos y falsearía el conteo.
    fake_redis = _FakeEphemeralRedis([])
    ingestor = _ingestor_rapido(
        ephemeral_redis=fake_redis, ephemeral_poll_interval_s=0.03, stale_after_s=60
    )

    thread = threading.Thread(
        target=lambda: ingestor.run([("UW", "LON", "HHZ")]), daemon=True
    )
    thread.start()
    time.sleep(0.3)  # varios ciclos de poll sin cambios
    ingestor.stop()
    thread.join(timeout=5)

    assert len(creados) == 1, "sin cambios en Redis no debe reconectar de más"


def test_compute_column_tiene_paridad_swarm():
    # Un seno de 22 Hz: el pipeline viejo (bandpass 0.1-20 + mascara a 20)
    # lo borraba. Con paridad SWARM (sin filtro, banda a 25 Hz, 20*log10 de
    # la FFT cruda) tiene que aparecer como pico dominante.
    fs = 100.0
    t = np.arange(int(fs * 10)) / fs
    tr = Trace(
        data=(1000.0 * np.sin(2 * np.pi * 22.0 * t)),
        header={"network": "UW", "station": "LON", "channel": "HHZ", "sampling_rate": fs},
    )
    ingestor = _ingestor_rapido()

    column = ingestor._compute_column(tr, "UW.LON..HHZ")

    assert column is not None
    freqs = np.array(column["freqs"])
    power = np.array(column["power_db"])
    assert freqs.max() <= 25.0
    assert abs(freqs[int(power.argmax())] - 22.0) < 0.5
    assert power.max() > 60  # escala SWARM: counts de a miles viven en 60-120 dB


# ---------------------------------------------------------------------------
# Métricas por canal (PR-W3): el ingestor deriva RSAM/FI/pico/eventos de datos
# que YA tiene en mano y los publica al lado de la columna. La publicación es
# best-effort: un fallo de métricas JAMÁS puede frenar la ingesta de columnas.
# ---------------------------------------------------------------------------


def _make_trace(fs: float = 20.0, seconds: int = 60, amp: float = 100.0) -> Trace:
    rng = np.random.default_rng(42)
    data = (rng.normal(0.0, amp, int(fs * seconds))).astype(np.float64)
    tr = Trace(data=data)
    tr.stats.network, tr.stats.station = "IU", "MAJO"
    tr.stats.location, tr.stats.channel = "00", "BHZ"
    tr.stats.sampling_rate = fs
    tr.stats.starttime = UTCDateTime("2026-08-21T12:00:00")
    return tr


class _RecordingBus:
    """Captura (canal, payload) de publish sin Redis ni loop de verdad."""

    def __init__(self):
        self.published: list[tuple[str, dict]] = []

    async def publish(self, channel: str, event: dict) -> None:
        self.published.append((channel, event))


class _RecordingStore:
    def __init__(self):
        self.snapshots: list[tuple[str, dict]] = []

    async def set_snapshot(self, channel: str, metrics: dict, ttl_s: int = 60) -> None:
        self.snapshots.append((channel, metrics))


def _drive_on_data(ingestor, trace):
    """Corre _on_data con un loop real y ESPERA a que las corutinas terminen.

    Drenar con un sleep fijo dejaría el test verde por casualidad si alguna
    publicación nunca se agenda; acá se interceptan los futures que devuelve
    run_coroutine_threadsafe y se esperan uno por uno. Si una corutina deja
    escapar una excepción, el .result() la re-levanta acá — que es lo que
    convierte al test del best-effort en una verificación real.
    """
    import src.services.seedlink_ingestor as module

    loop = asyncio.new_event_loop()
    ingestor._loop = loop
    futures = []
    real_submit = asyncio.run_coroutine_threadsafe

    def _tracking_submit(coro, target_loop):
        future = real_submit(coro, target_loop)
        futures.append(future)
        return future

    runner = threading.Thread(target=loop.run_forever, daemon=True)
    runner.start()
    try:
        module.asyncio.run_coroutine_threadsafe = _tracking_submit
        try:
            ingestor._on_data(trace)
        finally:
            module.asyncio.run_coroutine_threadsafe = real_submit
        for future in futures:
            future.result(timeout=5)
    finally:
        loop.call_soon_threadsafe(loop.stop)
        runner.join(timeout=5)
        loop.close()


def test_on_data_publica_metricas_junto_con_la_columna():
    bus = _RecordingBus()
    store = _RecordingStore()
    ingestor = SeedLinkIngestor(bus=bus, metrics_store=store)

    _drive_on_data(ingestor, _make_trace())

    channels = [c for c, _ in bus.published]
    assert "spec:IU.MAJO.00.BHZ" in channels
    assert "metrics:IU.MAJO.00.BHZ" in channels
    metrics = next(p for c, p in bus.published if c.startswith("metrics:"))
    assert set(metrics) == {
        "channel",
        "endtime",
        "rsam",
        "freq_hz",
        "fi",
        "peak_db",
        "events_hour",
    }
    assert metrics["channel"] == "IU.MAJO.00.BHZ"
    assert metrics["rsam"] is not None and metrics["rsam"] > 0
    assert metrics["peak_db"] is not None
    assert metrics["events_hour"] == 0  # ruido estacionario: sin eventos
    assert store.snapshots and store.snapshots[0][0] == "IU.MAJO.00.BHZ"
    assert store.snapshots[0][1] == metrics


def test_la_columna_publicada_no_cambio_de_forma():
    """El payload de spec:{canal} es contrato en producción (canvas del
    dashboard + TimescaleDB): agregar métricas no puede tocarlo."""
    bus = _RecordingBus()
    ingestor = SeedLinkIngestor(bus=bus, metrics_store=_RecordingStore())

    _drive_on_data(ingestor, _make_trace())

    column = next(p for c, p in bus.published if c.startswith("spec:"))
    assert set(column) == {"channel", "endtime", "freqs", "power_db"}
    assert column["channel"] == "IU.MAJO.00.BHZ"
    assert isinstance(column["freqs"], list) and isinstance(column["power_db"], list)


def test_un_fallo_de_metricas_no_frena_la_columna():
    class _BoomStore:
        async def set_snapshot(self, channel, metrics, ttl_s=60):
            raise RuntimeError("redis caido")

    bus = _RecordingBus()
    ingestor = SeedLinkIngestor(bus=bus, metrics_store=_BoomStore())

    # _drive_on_data hace .result() de cada future: si _publish_metrics dejara
    # escapar el RuntimeError, este llamado levantaría acá y el test fallaría.
    _drive_on_data(ingestor, _make_trace())

    # la columna salió igual; el fallo del snapshot quedó en un warning
    assert any(c.startswith("spec:") for c, _ in bus.published)


def test_un_fallo_calculando_metricas_no_frena_la_columna(monkeypatch):
    """El cálculo corre en el hilo de ObsPy, ANTES de encolar nada: si
    reventara ahí se llevaría puesto el callback entero, no solo las métricas."""

    def _explota(_data):
        raise RuntimeError("numpy explotó")

    monkeypatch.setattr("src.services.seedlink_ingestor.rsam_sample", _explota)
    bus = _RecordingBus()
    ingestor = SeedLinkIngestor(bus=bus, metrics_store=_RecordingStore())

    _drive_on_data(ingestor, _make_trace())

    assert any(c.startswith("spec:") for c, _ in bus.published)
    assert not any(c.startswith("metrics:") for c, _ in bus.published)


def test_sin_store_sigue_publicando_pubsub():
    bus = _RecordingBus()
    ingestor = SeedLinkIngestor(bus=bus)  # metrics_store default None

    _drive_on_data(ingestor, _make_trace())

    assert any(c.startswith("metrics:") for c, _ in bus.published)

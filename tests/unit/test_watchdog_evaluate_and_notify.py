"""Tests de evaluate_and_notify y _notify_ntfy (Fase 3 del change).

Cubre los tres Requirements de la spec (observability/spec.md):
"Deduplicación de notificaciones de caída", "Notificación de recuperación
con duración de la caída" y "Comportamiento con Redis caído". Se mockea
`_notify_ntfy` para capturar el payload exacto de cada llamada, no solo si
fue invocada — ver design.md, Decision "Redis caído → notificar igual,
degradando SIN estado" para la semántica exacta cuando `store.get_state`
devuelve `None`.

La segunda mitad del archivo prueba `_notify_ntfy` en sí (título/tags/
prioridad exactos por componente, ver design.md Decision "Mensaje de
ntfy"), mockeando `httpx.AsyncClient.post` en vez de `_notify_ntfy` mismo.
"""

from unittest.mock import AsyncMock

import httpx
import pytest

from src.services.watchdog import CheckResult, WatchdogStateStore, _notify_ntfy, evaluate_and_notify

pytestmark = pytest.mark.asyncio

NTFY_URL = "https://ntfy.sh/geospectrum-watchdog-test"


class _FakeStateStore:
    """Doble de WatchdogStateStore: expone get_state/set_state instrumentados
    sin tocar Redis. Simula degradación devolviendo None de get_state cuando
    corresponda (mismo contrato que WatchdogStateStore ante Redis caído)."""

    def __init__(self, previous: dict | None) -> None:
        self._previous = previous
        self.get_state_calls: list[str] = []
        self.set_state_calls: list[tuple[str, str, str]] = []

    async def get_state(self, component: str):
        self.get_state_calls.append(component)
        return self._previous

    async def set_state(self, component: str, status: str, since: str) -> None:
        self.set_state_calls.append((component, status, since))


@pytest.fixture
def notify_mock(monkeypatch):
    mock = AsyncMock()
    monkeypatch.setattr("src.services.watchdog._notify_ntfy", mock)
    return mock


async def test_primera_deteccion_de_caida_notifica(notify_mock):
    store = _FakeStateStore(previous={"status": "up", "since": "2026-08-30T08:00:00+00:00"})
    result = CheckResult(up=False, detail="HTTP 500")

    await evaluate_and_notify("api", result, store, NTFY_URL)

    notify_mock.assert_awaited_once()
    assert len(store.set_state_calls) == 1
    component, status, since = store.set_state_calls[0]
    assert component == "api"
    assert status == "down"
    # El "since" de una transición nueva a down NO debe ser el previo (t0
    # anterior era de la transición a up, no de esta caída).
    assert since != "2026-08-30T08:00:00+00:00"


async def test_caida_sostenida_no_repite_notificacion(notify_mock):
    previous = {"status": "down", "since": "2026-08-30T08:00:00+00:00"}
    store = _FakeStateStore(previous=previous)
    result = CheckResult(up=False, detail="HTTP 500")

    await evaluate_and_notify("api", result, store, NTFY_URL)

    notify_mock.assert_not_awaited()
    assert store.set_state_calls == []


async def test_recuperacion_notifica_con_duracion(notify_mock):
    previous = {"status": "down", "since": "2026-08-30T08:00:00+00:00"}
    store = _FakeStateStore(previous=previous)
    result = CheckResult(up=True, detail="HTTP 200")

    await evaluate_and_notify("seedlink", result, store, NTFY_URL)

    notify_mock.assert_awaited_once()
    # El "since" persistido en la transición a "up" debe preservar el "since"
    # original de la caída (no un timestamp nuevo) — es el dato que permite
    # calcular la duración en el mensaje de recuperación.
    assert store.set_state_calls[0] == ("seedlink", "up", "2026-08-30T08:00:00+00:00")


async def test_recuperacion_sin_caida_previa_no_notifica(notify_mock):
    store = _FakeStateStore(previous={"status": "up", "since": "2026-08-30T08:00:00+00:00"})
    result = CheckResult(up=True, detail="HTTP 200")

    await evaluate_and_notify("ui", result, store, NTFY_URL)

    notify_mock.assert_not_awaited()
    assert store.set_state_calls == []


async def test_redis_caido_notifica_down_sin_deduplicar(notify_mock):
    store = _FakeStateStore(previous=None)  # simula degradación (Redis caído)
    result = CheckResult(up=False, detail="HTTP 500")

    await evaluate_and_notify("api", result, store, NTFY_URL)

    notify_mock.assert_awaited_once()


async def test_redis_caido_no_notifica_recuperacion_fantasma(notify_mock):
    store = _FakeStateStore(previous=None)  # simula degradación (Redis caído)
    result = CheckResult(up=True, detail="HTTP 200")

    await evaluate_and_notify("api", result, store, NTFY_URL)

    notify_mock.assert_not_awaited()


async def test_primera_caida_de_la_historia_persiste_estado_para_poder_recuperar(notify_mock):
    """Bug real visto en producción el 2026-08-31: si el PRIMER chequeo de
    la vida de un componente (nunca hubo estado en Redis) ya viene `down`
    (ej. seedlink cayó justo en el primer ciclo del watchdog), el estado
    inicial también debe persistirse — si no, el próximo ciclo vuelve a ver
    `previous is None` y jamás notifica la recuperación aunque el
    componente ya esté `up` de nuevo.
    """
    store = _FakeStateStore(previous=None)  # nunca se chequeó este componente antes
    result = CheckResult(up=False, detail="sin datos de 74/74 canales")

    await evaluate_and_notify("seedlink", result, store, NTFY_URL)

    notify_mock.assert_awaited_once()
    assert len(store.set_state_calls) == 1
    component, status, since = store.set_state_calls[0]
    assert component == "seedlink"
    assert status == "down"
    assert since  # debe quedar un "since" real para poder calcular la duración después


# ---------------------------------------------------------------------------
# Contra un WatchdogStateStore real (no el doble), para blindar el contrato
# get_state/set_state usado por evaluate_and_notify.
# ---------------------------------------------------------------------------


class _FakeRedisClient:
    def __init__(self) -> None:
        self._data: dict[str, str] = {}

    async def get(self, key: str):
        return self._data.get(key)

    async def set(self, key: str, value: str, **kwargs) -> None:
        self._data[key] = value


async def test_ciclo_completo_caida_y_recuperacion_contra_store_real(notify_mock):
    store = WatchdogStateStore(_FakeRedisClient())

    # Primer ciclo: sin estado previo (nunca corrió el watchdog para este
    # componente) y resultado up -> se persiste "up" como estado inicial,
    # sin notificar (no hay transición, es el primer dato conocido).
    await evaluate_and_notify("events", CheckResult(up=True, detail="heartbeat hace 3s"), store, NTFY_URL)
    assert notify_mock.await_count == 0
    state_initial = await store.get_state("events")
    assert state_initial["status"] == "up"

    # up -> down: notifica una vez, persiste down.
    await evaluate_and_notify("events", CheckResult(up=False, detail="sin heartbeat"), store, NTFY_URL)
    assert notify_mock.await_count == 1
    state_after_down = await store.get_state("events")
    assert state_after_down["status"] == "down"

    # down -> down: no vuelve a notificar.
    await evaluate_and_notify("events", CheckResult(up=False, detail="sin heartbeat"), store, NTFY_URL)
    assert notify_mock.await_count == 1

    # down -> up: notifica la recuperación.
    await evaluate_and_notify("events", CheckResult(up=True, detail="heartbeat hace 3s"), store, NTFY_URL)
    assert notify_mock.await_count == 2
    state_after_up = await store.get_state("events")
    assert state_after_up["status"] == "up"


# ---------------------------------------------------------------------------
# _notify_ntfy: título/tags/prioridad exactos por componente, ver design.md
# Decision "Mensaje de ntfy". Mockea httpx.AsyncClient.post directamente
# (NO evaluate_and_notify): este test valida el mapeo estático de datos, no
# la lógica de decisión de transición.
# ---------------------------------------------------------------------------

_EXPECTED_NTFY_INFO = {
    "api": ("rotating_light", "API"),
    "ui": ("globe_with_meridians", "Dashboard (UI)"),
    "seedlink": ("satellite", "SeedLink (ingesta en vivo)"),
    "events": ("earth_americas", "Ingesta de eventos sísmicos"),
}


@pytest.fixture
def post_mock(monkeypatch):
    """Mockea httpx.AsyncClient.post capturando (url, kwargs) de cada llamada.

    Construye un httpx.Request real con esos mismos kwargs ANTES de
    guardarlos: eso fuerza la validación real de httpx sobre los headers
    (normalize_header_value exige ASCII puro por defecto) — sin este paso,
    un header con tildes pasaría el mock en verde pero reventaría en
    producción con UnicodeEncodeError (bug real visto el 2026-08-31 en
    _notify_ntfy, título "... sísmicos CAÍDO" con headers en str en vez de
    bytes UTF-8).
    """
    calls: list[tuple[str, dict]] = []

    async def _fake_post(self, url, **kwargs):
        httpx.Request("POST", url, **kwargs)  # valida headers de verdad
        calls.append((url, kwargs))

    monkeypatch.setattr("httpx.AsyncClient.post", _fake_post)
    return calls


@pytest.mark.parametrize("component", ["api", "ui", "seedlink", "events"])
async def test_notify_ntfy_arma_el_payload_correcto_por_componente_caida(component, post_mock):
    tag, label = _EXPECTED_NTFY_INFO[component]

    await _notify_ntfy(component, "down", NTFY_URL, extra={"detail": "HTTP 500"})

    assert len(post_mock) == 1
    url, kwargs = post_mock[0]
    assert url == NTFY_URL
    headers = kwargs["headers"]
    assert headers["Title"] == f"GeoSpectrum watchdog: {label} CAÍDO".encode("utf-8")
    assert headers["Priority"] == "urgent"
    assert headers["Tags"] == f"warning,{tag}"
    assert "HTTP 500" in kwargs["content"].decode("utf-8")


@pytest.mark.parametrize("component", ["api", "ui", "seedlink", "events"])
async def test_notify_ntfy_arma_el_payload_correcto_por_componente_recuperacion(component, post_mock):
    tag, label = _EXPECTED_NTFY_INFO[component]

    await _notify_ntfy(component, "up", NTFY_URL, extra={"detail": "HTTP 200", "duration_s": 125})

    assert len(post_mock) == 1
    url, kwargs = post_mock[0]
    assert url == NTFY_URL
    headers = kwargs["headers"]
    assert headers["Title"] == f"GeoSpectrum watchdog: {label} recuperado".encode("utf-8")
    assert headers["Priority"] == "default"
    assert headers["Tags"] == f"white_check_mark,{tag}"
    body = kwargs["content"].decode("utf-8")
    assert "2m 5s" in body  # 125s = 2m 5s


async def test_notify_ntfy_recuperacion_sin_duracion_indica_redis_no_disponible(post_mock):
    await _notify_ntfy("api", "up", NTFY_URL, extra={"detail": "HTTP 200", "duration_s": None})

    _, kwargs = post_mock[0]
    body = kwargs["content"].decode("utf-8")
    assert "duración desconocida" in body
    assert "Redis no disponible" in body

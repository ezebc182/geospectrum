"""Tests del loop principal del watchdog (Fase 5 del change).

`run_watchdog_loop` es el ciclo standalone que corre los 4 chequeos + su
`evaluate_and_notify` cada `interval_seconds`, calcando el patrón
`stop_event` esperado de `disk_alert.py:75-94` (NO un `sleep` pelado). Cada
chequeo va en su propio `try/except` dentro del ciclo — un chequeo que
revienta con una excepción no anticipada no debe impedir que los otros tres
se ejecuten en ese mismo ciclo (ver spec, "Aislamiento de fallos entre
chequeos").

Los tests de acá NO validan la lógica interna de cada `check_*` ni de
`evaluate_and_notify` (ya cubierta en test_watchdog_checks.py y
test_watchdog_evaluate_and_notify.py) — usan stubs/mocks inyectados vía
monkeypatch para observar exclusivamente el comportamiento del LOOP: cuántas
veces se llamó cada pieza, y que el ciclo no muere ni queda colgado.
"""

import asyncio

import pytest

from src.services.watchdog import CheckResult

pytestmark = pytest.mark.asyncio


class _StopAfterNCycles:
    """stop_event que se setea solo, tras N vueltas del loop.

    Se usa en vez de un `asyncio.sleep` real disparado por una tarea externa
    porque acá lo que se quiere contar es "vueltas de ciclo", no tiempo de
    reloj: cada chequeo await-eable (los 4 check_* + evaluate_and_notify)
    incrementa el contador cuando el loop los llama, y al llegar a N el
    propio stub setea el stop_event ANTES de que el loop entre en el
    `wait_for(stop_event.wait(), timeout=interval_seconds)` de la próxima
    vuelta.
    """

    def __init__(self, event: asyncio.Event, cycles_before_stop: int) -> None:
        self._event = event
        self._remaining = cycles_before_stop

    def maybe_stop(self) -> None:
        self._remaining -= 1
        if self._remaining <= 0:
            self._event.set()


async def test_run_watchdog_loop_corre_los_4_chequeos_y_para_con_stop_event(monkeypatch):
    from src.services import watchdog as watchdog_module

    calls: list[str] = []
    stop_event = asyncio.Event()
    stopper = _StopAfterNCycles(stop_event, cycles_before_stop=1)

    async def _fake_check_api(client, url, timeout):
        calls.append("api")
        return CheckResult(up=True, detail="HTTP 200")

    async def _fake_check_ui(client, url, timeout):
        calls.append("ui")
        return CheckResult(up=True, detail="HTTP 200")

    async def _fake_check_seedlink(pool, stale_after_s, expected_channels):
        calls.append("seedlink")
        return CheckResult(up=True, detail="ok")

    async def _fake_check_events(redis_client, ttl_grace_s=0):
        calls.append("events")
        return CheckResult(up=True, detail="ok")

    async def _fake_evaluate_and_notify(component, result, store, ntfy_topic_url):
        calls.append(f"evaluate:{component}")
        # Cada llamada a evaluate_and_notify marca el fin de la vuelta para
        # el componente "events" (el último de los 4 en el orden del loop):
        # recién ahí se setea el stop, para no cortar a mitad de ciclo.
        if component == "events":
            stopper.maybe_stop()

    monkeypatch.setattr(watchdog_module, "check_api", _fake_check_api)
    monkeypatch.setattr(watchdog_module, "check_ui", _fake_check_ui)
    monkeypatch.setattr(watchdog_module, "check_seedlink", _fake_check_seedlink)
    monkeypatch.setattr(watchdog_module, "check_events", _fake_check_events)
    monkeypatch.setattr(watchdog_module, "evaluate_and_notify", _fake_evaluate_and_notify)

    settings_snapshot = {
        "interval_seconds": 300,
        "api_url": "https://api.example.org/health",
        "ui_url": "https://dashboard.example.org",
        "api_timeout_s": 10.0,
        "ui_timeout_s": 10.0,
        "seedlink_stale_after_seconds": 600,
        "expected_channels": ["A1", "A2"],
        "ntfy_topic_url": "https://ntfy.sh/test",
    }

    # `asyncio.wait_for` con un timeout real (300s) nunca debería completar
    # en este test: lo que corta el loop es el stop_event.set() disparado
    # por el propio fake de evaluate_and_notify, no el paso del tiempo.
    await asyncio.wait_for(
        watchdog_module.run_watchdog_loop(
            client=object(),
            pool=object(),
            redis_client=object(),
            store=object(),
            settings_snapshot=settings_snapshot,
            stop_event=stop_event,
        ),
        timeout=5.0,
    )

    assert calls.count("api") == 1
    assert calls.count("ui") == 1
    assert calls.count("seedlink") == 1
    assert calls.count("events") == 1
    assert calls.count("evaluate:api") == 1
    assert calls.count("evaluate:ui") == 1
    assert calls.count("evaluate:seedlink") == 1
    assert calls.count("evaluate:events") == 1
    assert stop_event.is_set()


async def test_run_watchdog_loop_excepcion_en_un_chequeo_no_aborta_el_ciclo(monkeypatch):
    """Aislamiento de fallos entre chequeos (ver spec homónima).

    check_seedlink revienta con una excepción NO anticipada (no la
    CheckResult(up=False, ...) que ya devuelve sola, sino un error real de
    conexión propagado por error de implementación). Los otros 3 chequeos
    deben ejecutarse y notificarse igual, en el MISMO ciclo, y el loop no
    debe morir.
    """
    from src.services import watchdog as watchdog_module

    calls: list[str] = []
    evaluated: list[str] = []
    stop_event = asyncio.Event()
    stopper = _StopAfterNCycles(stop_event, cycles_before_stop=1)

    async def _fake_check_api(client, url, timeout):
        calls.append("api")
        return CheckResult(up=True, detail="HTTP 200")

    async def _fake_check_ui(client, url, timeout):
        calls.append("ui")
        return CheckResult(up=True, detail="HTTP 200")

    async def _fake_check_seedlink(pool, stale_after_s, expected_channels):
        calls.append("seedlink")
        # Excepción NO anticipada: distinta del CheckResult(up=False, ...)
        # que check_seedlink ya sabe devolver sola ante un fallo esperado.
        raise ConnectionError("TimescaleDB inalcanzable (simulado)")

    async def _fake_check_events(redis_client, ttl_grace_s=0):
        calls.append("events")
        return CheckResult(up=True, detail="ok")

    async def _fake_evaluate_and_notify(component, result, store, ntfy_topic_url):
        evaluated.append(component)
        if component == "events":
            stopper.maybe_stop()

    monkeypatch.setattr(watchdog_module, "check_api", _fake_check_api)
    monkeypatch.setattr(watchdog_module, "check_ui", _fake_check_ui)
    monkeypatch.setattr(watchdog_module, "check_seedlink", _fake_check_seedlink)
    monkeypatch.setattr(watchdog_module, "check_events", _fake_check_events)
    monkeypatch.setattr(watchdog_module, "evaluate_and_notify", _fake_evaluate_and_notify)

    settings_snapshot = {
        "interval_seconds": 300,
        "api_url": "https://api.example.org/health",
        "ui_url": "https://dashboard.example.org",
        "api_timeout_s": 10.0,
        "ui_timeout_s": 10.0,
        "seedlink_stale_after_seconds": 600,
        "expected_channels": ["A1", "A2"],
        "ntfy_topic_url": "https://ntfy.sh/test",
    }

    await asyncio.wait_for(
        watchdog_module.run_watchdog_loop(
            client=object(),
            pool=object(),
            redis_client=object(),
            store=object(),
            settings_snapshot=settings_snapshot,
            stop_event=stop_event,
        ),
        timeout=5.0,
    )

    # Los 4 chequeos se intentaron llamar (seedlink revienta DESPUÉS de
    # quedar registrado en `calls`, así que su try/except individual no le
    # impide a los otros 3 correr en el mismo ciclo).
    assert set(calls) == {"api", "ui", "seedlink", "events"}
    # api, ui y events SÍ llegaron a evaluate_and_notify pese al fallo de
    # seedlink; seedlink NO, porque su try/except capturó la excepción antes
    # de poder producir un CheckResult que evaluar.
    assert set(evaluated) == {"api", "ui", "events"}
    assert stop_event.is_set()


# ---------------------------------------------------------------------------
# Arranque del proceso (`_main`, invocado por `if __name__ == "__main__":`)
# ---------------------------------------------------------------------------


async def test_main_no_arranca_el_loop_si_watchdog_enabled_es_false(monkeypatch):
    """Servicio opt-in (ver design.md, "Nombres de settings nuevos" y
    proposal.md "Rollback Plan"): con WATCHDOG_ENABLED=false, `_main()` debe
    volver sin llamar a `run_watchdog_loop` NI intentar conectar a
    Postgres/Redis/httpx — apagarlo por env var es un no-op limpio, no debe
    generar tráfico saliente innecesario en un despliegue con el flag
    apagado.
    """
    from src.services import watchdog as watchdog_module

    monkeypatch.setattr(watchdog_module.settings, "watchdog_enabled", False)

    loop_called = False

    async def _fake_run_watchdog_loop(**kwargs):
        nonlocal loop_called
        loop_called = True

    def _fail_if_called(*args, **kwargs):
        raise AssertionError(
            "no debía intentar conectar a Postgres/Redis/httpx con watchdog_enabled=False"
        )

    monkeypatch.setattr(watchdog_module, "run_watchdog_loop", _fake_run_watchdog_loop)
    monkeypatch.setattr(watchdog_module.TimescaleColumnWriter, "connect", _fail_if_called)
    monkeypatch.setattr(watchdog_module.aioredis, "from_url", _fail_if_called)
    monkeypatch.setattr(watchdog_module.httpx, "AsyncClient", _fail_if_called)

    await watchdog_module._main()

    assert loop_called is False

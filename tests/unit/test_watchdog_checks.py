"""Tests de los 4 chequeos puros del watchdog (Fase 2 del change).

Cada chequeo es independiente de los otros: recibe sus dependencias
inyectadas (cliente httpx, pool asyncpg, cliente Redis) y nunca propaga una
excepción de red/DB/Redis fuera de sí mismo — un fallo aislado no debe
tumbar el ciclo completo del watchdog (ver design.md, "Aislamiento de fallos
entre chequeos").
"""

import httpx
import pytest

from src.services.watchdog import CheckResult, check_api, check_events, check_seedlink, check_ui

pytestmark = pytest.mark.asyncio


class _FakeResponse:
    def __init__(self, status_code: int) -> None:
        self.status_code = status_code


class _FakeClient:
    """Stub manual de httpx.AsyncClient, mismo patrón que _CapturingClient
    en test_source_min_magnitude.py: no hay `respx` en requirements.txt, el
    proyecto mockea httpx con clases fake propias."""

    def __init__(self, response=None, exc=None) -> None:
        self._response = response
        self._exc = exc
        self.calls: list[tuple[str, float | None]] = []

    async def get(self, url, timeout=None):
        self.calls.append((url, timeout))
        if self._exc is not None:
            raise self._exc
        return self._response


# ---------------------------------------------------------------------------
# check_api
# ---------------------------------------------------------------------------


async def test_check_api_up_en_200():
    client = _FakeClient(response=_FakeResponse(200))
    result = await check_api(client, "https://api.example.org/health", timeout=10.0)
    assert result == CheckResult(up=True, detail="HTTP 200")


async def test_check_api_down_en_500():
    client = _FakeClient(response=_FakeResponse(500))
    result = await check_api(client, "https://api.example.org/health", timeout=10.0)
    assert result.up is False
    assert "500" in result.detail


async def test_check_api_down_por_timeout_no_bloquea_el_ciclo():
    client = _FakeClient(exc=httpx.TimeoutException("timed out"))
    # No debe propagar la excepción: check_api la captura y devuelve down.
    result = await check_api(client, "https://api.example.org/health", timeout=10.0)
    assert result.up is False
    assert "timeout" in result.detail.lower()


async def test_check_api_down_por_error_de_conexion():
    client = _FakeClient(exc=httpx.ConnectError("connection refused"))
    result = await check_api(client, "https://api.example.org/health", timeout=10.0)
    assert result.up is False


# ---------------------------------------------------------------------------
# check_ui
# ---------------------------------------------------------------------------


async def test_check_ui_up_en_200():
    client = _FakeClient(response=_FakeResponse(200))
    result = await check_ui(client, "https://dashboard.example.org", timeout=10.0)
    assert result == CheckResult(up=True, detail="HTTP 200")


async def test_check_ui_down_en_timeout():
    client = _FakeClient(exc=httpx.TimeoutException("timed out"))
    result = await check_ui(client, "https://dashboard.example.org", timeout=10.0)
    assert result.up is False


async def test_check_ui_independiente_de_check_api():
    """La UI caída no debe contaminar el resultado del API: cada chequeo usa
    su propio resultado, sin estado compartido entre llamadas."""
    api_client = _FakeClient(response=_FakeResponse(200))
    ui_client = _FakeClient(exc=httpx.ConnectError("refused"))

    api_result = await check_api(api_client, "https://api.example.org/health", timeout=10.0)
    ui_result = await check_ui(ui_client, "https://dashboard.example.org", timeout=10.0)

    assert api_result.up is True
    assert ui_result.up is False


# ---------------------------------------------------------------------------
# check_seedlink
# ---------------------------------------------------------------------------


class _FakePoolForFetchActiveChannels:
    """Stub de TimescaleColumnWriter con solo fetch_active_channels."""

    def __init__(self, active_channels: list[str]) -> None:
        self._active_channels = active_channels
        self.called_with_minutes: list[int] = []

    async def fetch_active_channels(self, minutes: int) -> list[str]:
        self.called_with_minutes.append(minutes)
        return self._active_channels


async def test_check_seedlink_todos_mudos_marca_down():
    pool = _FakePoolForFetchActiveChannels(active_channels=[])
    result = await check_seedlink(pool, stale_after_s=600, expected_channels=["A1", "A2", "A3"])
    assert result.up is False
    assert "3/3" in result.detail


async def test_check_seedlink_un_canal_mudo_otros_activos_marca_up():
    pool = _FakePoolForFetchActiveChannels(active_channels=["A2", "A3"])  # falta A1
    result = await check_seedlink(pool, stale_after_s=600, expected_channels=["A1", "A2", "A3"])
    assert result.up is True


async def test_check_seedlink_todos_activos_marca_up():
    pool = _FakePoolForFetchActiveChannels(active_channels=["A1", "A2", "A3"])
    result = await check_seedlink(pool, stale_after_s=600, expected_channels=["A1", "A2", "A3"])
    assert result.up is True


async def test_check_seedlink_catalogo_vacio_no_es_caida():
    pool = _FakePoolForFetchActiveChannels(active_channels=[])
    result = await check_seedlink(pool, stale_after_s=600, expected_channels=[])
    assert result.up is True
    # Catálogo vacío no debe ni tocar la base: "no hay nada que chequear" es
    # una situación distinta de "hay canales y todos están mudos".
    assert pool.called_with_minutes == []


# ---------------------------------------------------------------------------
# check_events
# ---------------------------------------------------------------------------


class _FakeRedisClient:
    def __init__(self, value=None) -> None:
        self._value = value

    async def get(self, key: str):
        return self._value


async def test_check_events_heartbeat_ausente_marca_down():
    redis_client = _FakeRedisClient(value=None)
    result = await check_events(redis_client)
    assert result.up is False


async def test_check_events_heartbeat_reciente_marca_up():
    from datetime import datetime, timedelta, timezone

    recent = (datetime.now(timezone.utc) - timedelta(seconds=5)).isoformat()
    redis_client = _FakeRedisClient(value=recent)
    result = await check_events(redis_client)
    assert result.up is True


async def test_check_events_heartbeat_viejo_marca_down():
    from datetime import datetime, timedelta, timezone

    old = (datetime.now(timezone.utc) - timedelta(seconds=999)).isoformat()
    redis_client = _FakeRedisClient(value=old)
    # ttl_grace_s=0 por default: cualquier heartbeat con más de 0s de margen
    # extra que "ahora" ya está claramente vencido para este test — se usa
    # un valor bien grande (999s) para no depender de un umbral fino.
    result = await check_events(redis_client, ttl_grace_s=60)
    assert result.up is False

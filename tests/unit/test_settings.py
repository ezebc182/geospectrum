"""Defaults de Settings sin variables de entorno seteadas.

No es un test crítico (no requiere mutación): cubre que un despliegue sin las
env vars nuevas del watchdog (openspec/changes/watchdog-servicios-railway)
sigue arrancando con el watchdog apagado, mismo criterio ya usado para
verificar google_oauth_configured en test_auth_service.py.
"""

from src.config.settings import Settings

_WATCHDOG_ENV_VARS = (
    "WATCHDOG_ENABLED",
    "WATCHDOG_NTFY_TOPIC_URL",
    "WATCHDOG_INTERVAL_SECONDS",
    "WATCHDOG_API_URL",
    "WATCHDOG_UI_URL",
    "WATCHDOG_API_TIMEOUT_S",
    "WATCHDOG_UI_TIMEOUT_S",
    "WATCHDOG_SEEDLINK_STALE_AFTER_SECONDS",
    "WATCHDOG_EVENTS_HEARTBEAT_TTL_SECONDS",
    "WATCHDOG_EVENTS_HEARTBEAT_INTERVAL_SECONDS",
)


def test_watchdog_settings_tienen_defaults_seguros_sin_env_vars(monkeypatch):
    for name in _WATCHDOG_ENV_VARS:
        monkeypatch.delenv(name, raising=False)

    s = Settings(_env_file=None)

    assert s.watchdog_enabled is False
    assert s.watchdog_ui_url is None
    assert s.watchdog_seedlink_stale_after_seconds == 600
    assert s.watchdog_api_url == "https://api.geospectrum.org/health"

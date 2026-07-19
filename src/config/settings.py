"""
Configuración centralizada del servicio.
Todas las variables de entorno se cargan aquí de forma tipada.
"""
from pydantic_settings import BaseSettings, SettingsConfigDict
from typing import Optional


class Settings(BaseSettings):
    """Configuración del servicio de monitoreo sísmico."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore"
    )

    # Región de monitoreo
    region_minlat: float = -40.0
    region_maxlat: float = -20.0
    region_minlon: float = -75.0
    region_maxlon: float = -60.0

    # Umbral de magnitud
    min_mag_alert: float = 3.0

    # Timeouts externos
    usgs_timeout_s: float = 5.0
    inpres_timeout_s: float = 5.0

    # Ventana de análisis
    window_minutes: int = 60

    # URLs de fuentes
    usgs_api_url: str = "https://earthquake.usgs.gov/fdsnws/event/1/query"
    inpres_proxy_url: Optional[str] = None

    # API server
    api_host: str = "0.0.0.0"
    api_port: int = 8000

    # Logging
    log_level: str = "INFO"

    # Observability
    prometheus_enabled: bool = True
    sentry_dsn: Optional[str] = None

    # Caché TTL (segundos). 0 = deshabilitado.
    cache_ttl_seconds: int = 30
    spectrogram_cache_ttl_seconds: int = 45

    # Rate limiting
    rate_limit_enabled: bool = False
    rate_limit_per_minute: int = 60

    # Storage opcional
    timescaledb_host: Optional[str] = None
    timescaledb_port: int = 5432
    timescaledb_db: str = "seismic"
    timescaledb_user: Optional[str] = None
    timescaledb_password: Optional[str] = None

    # Redis
    redis_url: str = "redis://localhost:6379/0"
    redis_password: Optional[str] = None

    # Auth (multi-user-auth). auth_secret_key es Optional[str] = None por
    # convención (mismo patrón que timescaledb_password), pero a diferencia
    # de TimescaleDB (opcional/best-effort) NO tiene un modo degradado
    # aceptable: si es None al arrancar, main.py debe fail-fast (ver
    # openspec/changes/multi-user-auth/design.md, Decision sobre lifespan).
    # No se le pone un default no-vacío acá — eso disfrazaría la falta de
    # configuración como una clave real y permitiría forjar tokens válidos.
    auth_secret_key: Optional[str] = None
    auth_token_expire_minutes: int = 1440

    # SSE
    max_sse_clients: int = 200
    sse_heartbeat_seconds: int = 30
    sse_replay_window_hours: int = 24

    # Archive
    archive_dir: str = "/tmp/events-archive"

    # Observability
    glitchtip_dsn: Optional[str] = None
    glitchtip_dsn_frontend: Optional[str] = None
    environment: str = "development"
    git_sha: str = "unknown"
    glitchtip_traces_sample_rate: float = 0.1

    # CORS
    cors_allowed_origins: str = (
        "http://localhost:3008,http://localhost:3000,"
        "http://127.0.0.1:3008,http://127.0.0.1:3000"
    )

    @property
    def cors_origins_list(self) -> list[str]:
        """Parsea cors_allowed_origins (CSV) a lista."""
        return [o.strip() for o in self.cors_allowed_origins.split(",") if o.strip()]

    @property
    def bbox(self) -> dict:
        """Retorna bounding box como dict."""
        return {
            "minlat": self.region_minlat,
            "maxlat": self.region_maxlat,
            "minlon": self.region_minlon,
            "maxlon": self.region_maxlon,
        }

    @property
    def timescaledb_dsn(self) -> Optional[str]:
        """Retorna connection string de TimescaleDB si está configurado."""
        if not all([self.timescaledb_host, self.timescaledb_user, self.timescaledb_password]):
            return None
        return (
            f"postgresql://{self.timescaledb_user}:{self.timescaledb_password}"
            f"@{self.timescaledb_host}:{self.timescaledb_port}/{self.timescaledb_db}"
        )


# Singleton
settings = Settings()

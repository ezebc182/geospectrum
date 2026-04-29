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

    # Rate limiting
    rate_limit_enabled: bool = False
    rate_limit_per_minute: int = 60

    # Storage opcional
    timescaledb_host: Optional[str] = None
    timescaledb_port: int = 5432
    timescaledb_db: str = "seismic"
    timescaledb_user: Optional[str] = None
    timescaledb_password: Optional[str] = None

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

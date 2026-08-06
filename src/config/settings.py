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

    # Región por defecto de MonitorReport.region_monitorizada cuando no hay un
    # área de interés resuelta (/events, /alerts). Ya NO recorta la consulta a
    # las fuentes: desde la ingesta global, los fetchers piden el planeta entero
    # y el filtro geográfico se aplica al leer, en build_report().
    region_minlat: float = -40.0
    region_maxlat: float = -20.0
    region_minlon: float = -75.0
    region_maxlon: float = -60.0

    # Umbral de magnitud
    min_mag_alert: float = 3.0

    # Techo de eventos por consulta a cada fuente. Con la ingesta global el
    # viejo hardcode de 200 dejaba de alcanzar: 200 eventos mundiales ordenados
    # por tiempo pueden caer todos fuera del área elegida y devolver una lista
    # vacía. USGS acepta hasta 20000 (maxAllowed).
    source_fetch_limit: int = 2000

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

    # Invitaciones (email-invitations). Días de vigencia de una invitación
    # desde su creación (Decision 9 del design: default 7, configurable por
    # env, SIN fail-fast — a diferencia de auth_secret_key, la ausencia de la
    # variable no impide el arranque). La expiración se evalúa en lectura
    # (`expires_at > now()`), sin worker que marque expiradas: el estado es
    # derivado de timestamps (Decision 1).
    invitation_expire_days: int = 7

    # Google OAuth (opcional — ver openspec/changes/google-oauth/design.md
    # Decision 1). A diferencia de auth_secret_key, la AUSENCIA de estas tres
    # variables NO impide el arranque del servidor: solo deshabilita la vía
    # de login por Google (endpoints /auth/google/* responden 503), el login
    # por password sigue intacto. google_redirect_uri no se deriva de otra
    # config existente (ej. cors_allowed_origins) porque el redirect_uri debe
    # coincidir EXACTAMENTE, carácter a carácter, con el valor registrado en
    # Google Cloud Console — derivarlo implícitamente de otra variable sería
    # frágil ante un mismatch silencioso.
    google_client_id: Optional[str] = None
    google_client_secret: Optional[str] = None
    google_redirect_uri: Optional[str] = None

    # URL pública del dashboard (Next.js) al que /auth/google/callback debe
    # redirigir tras resolver el login. Bug real detectado en verificación
    # manual: un redirect con ruta relativa ("/") lo resuelve el browser
    # contra el ORIGEN que sirvió el callback (este backend, puerto 8000/
    # donde GET / devuelve el JSON de info de la API), no contra el
    # dashboard — el usuario terminaba viendo la respuesta de la API en vez
    # del dashboard. Debe ser una URL absoluta de otro origen. Mismo default
    # que el primer origen de cors_allowed_origins (dashboard local en dev).
    dashboard_url: str = "http://localhost:3008"

    # Dominio de la cookie de sesión. En dev queda None (cookie host-only:
    # localhost comparte cookies entre puertos y funciona sola). En
    # producción DEBE ser el dominio registrable con punto inicial
    # (".geospectrum.org"): la API vive en api.geospectrum.org y el
    # middleware del dashboard corre en geospectrum.org — una cookie
    # host-only de la API nunca llega al dashboard y el login "vuelve a
    # /login" sin error visible (bug real del primer deploy, 2026-08-05).
    auth_cookie_domain: Optional[str] = None

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

    @property
    def google_oauth_configured(self) -> bool:
        """True si hay credenciales suficientes para habilitar /auth/google/*.

        Ver design.md Decision 1 — a diferencia de auth_secret_key (fail-fast
        total), esta es una condición de habilitación parcial, consultada por
        lifespan() y por los propios endpoints /auth/google/* en runtime.
        """
        return bool(self.google_client_id and self.google_client_secret and self.google_redirect_uri)


# Singleton
settings = Settings()

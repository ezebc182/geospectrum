"""
Configuración centralizada del servicio.
Todas las variables de entorno se cargan aquí de forma tipada.
"""

from pydantic_settings import BaseSettings, SettingsConfigDict
from typing import Optional


class Settings(BaseSettings):
    """Configuración del servicio de monitoreo sísmico."""

    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", case_sensitive=False, extra="ignore"
    )

    # Región por defecto de MonitorReport.region_monitorizada cuando no hay un
    # área de interés resuelta (/events, /alerts). Ya NO recorta la consulta a
    # las fuentes: desde la ingesta global, los fetchers piden el planeta entero
    # y el filtro geográfico se aplica al leer, en build_report().
    region_minlat: float = -40.0
    region_maxlat: float = -20.0
    region_minlon: float = -75.0
    region_maxlon: float = -60.0

    # Piso de magnitud del FETCH a las fuentes. Existe para descartar
    # micro-sismos (M<1 de redes locales densas), NO para esconder sismos
    # reales: con el viejo 3.0 los M<3 jamás entraban al sistema y el
    # dashboard parecía muerto (bug 2026-08-20). Los endpoints pueden pedir
    # un piso mayor por request; este es el mínimo que se trae de origen.
    source_min_magnitude: float = 1.0

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
    # 15 min: la imagen resume 24 h — regenerarla cada 45 s recalculaba TODO
    # una vez por minuto por ciudad y fue la causa de los OOM en Railway
    # (2026-08-20) cuando el muro creció a 30 ciudades.
    spectrogram_cache_ttl_seconds: int = 900

    # Cache eterno de resultados FDSN de ventana absoluta (tabla
    # fdsn_result_cache, migración 016). Tope por CANTIDAD y no por tiempo:
    # las ventanas históricas no vencen, pero un espectro de 1 h ronda los
    # 2 MB de JSON — 200 entradas acotan la tabla a unos cientos de MB.
    fdsn_result_cache_max_entries: int = 200

    # Warm-up del helicorder (FDSN_WARMUP_ENABLED=true SOLO en el servicio
    # api de Railway): precalienta las 24 h de las ganadoras por ciudad.
    # Apagado por default para que dev local y tests no generen tráfico
    # saliente a EarthScope.
    fdsn_warmup_enabled: bool = False
    # 12 min de ciclo con TTL de 20: el SET de un barrido nunca expira antes
    # de que el siguiente lo renueve (un barrido de ~27 canales a ~60 s con
    # concurrencia 3 tarda ~9 min).
    fdsn_warmup_interval_seconds: int = 720
    fdsn_warmup_cache_ttl_seconds: int = 1200
    fdsn_warmup_concurrency: int = 3

    # Alerta de disco de TimescaleDB (DISK_ALERT_ENABLED=true SOLO en el
    # servicio api de Railway, mismo criterio que fdsn_warmup_enabled).
    # Nace de la caída del 2026-08-28: la base se llenó y nadie se enteró
    # hasta el crash-loop. Mide pg_database_size() contra el tope conocido
    # del volumen (10 GB tras la migración 002) — no hay forma de leer el
    # % de disco del contenedor de Postgres desde acá, corre en un servicio
    # aparte. Sin ntfy_topic_url el chequeo queda deshabilitado igual que
    # sin resend_api_key deshabilita EmailService: no tiene sentido activar
    # el loop sin destino para el aviso.
    disk_alert_enabled: bool = False
    disk_alert_volume_capacity_gb: float = 10.0
    # 80%: a ~0,9 GB/día medidos tras la migración 002, deja margen para
    # investigar antes de llegar al 100% que causó el crash-loop.
    disk_alert_threshold_ratio: float = 0.8
    # 1 h: la base crece por chunks diarios, un ciclo más corto no aporta
    # señal nueva y uno más largo demora demasiado el primer aviso.
    disk_alert_interval_seconds: int = 3600
    ntfy_topic_url: Optional[str] = None

    # Watchdog de servicios en Railway (WATCHDOG_ENABLED=true SOLO en el
    # servicio watchdog dedicado, mismo criterio opt-in que
    # disk_alert_enabled/fdsn_warmup_enabled). Cubre el caso que NI Railway
    # ni los procesos internos pueden ver por sí mismos: un componente que
    # sigue VIVO pero dejó de producir algo útil ("falso vivo") — un
    # seedlink_ingestor colgado sin levantar su RuntimeError, un
    # events_ingestor sin heartbeat que nadie notaría hasta el próximo sismo,
    # o el dashboard de Vercel caído sin que el backend se entere. Railway ya
    # reinicia solo los procesos que crashean de verdad (ver
    # events_ingestor.py:191-198); este servicio nuevo vigila lo que Railway
    # no puede: el proceso vivo pero mudo. Topic ntfy dedicado, separado del
    # de disk_alert, para poder apagar/mover una alerta sin tocar la otra.
    watchdog_enabled: bool = False
    watchdog_ntfy_topic_url: Optional[str] = None
    watchdog_interval_seconds: int = 300
    watchdog_api_url: str = "https://api.geospectrum.org/health"
    # Optional[str] = None a propósito, sin default hardcodeado: sin
    # configurar la URL pública de Vercel, ESE chequeo puntual se salta con
    # un logger.info y no bloquea a los otros tres (mismo criterio que
    # google_client_id opcional) — no tiene sentido inventar una URL de
    # ejemplo que nunca sería la real.
    watchdog_ui_url: Optional[str] = None
    watchdog_api_timeout_s: float = 10.0
    watchdog_ui_timeout_s: float = 10.0
    # 600 s (10 min) = 2 ciclos del watchdog, un valor PROPIO y explícito,
    # distinto de las dos constantes internas de seedlink_ingestor.py. NO usa
    # STALE_AFTER_SECONDS=300 (umbral de UN canal individual mudo, forzar
    # reconexión — coincide con 1 solo ciclo del watchdog y confundiría una
    # reconexión rutinaria con una caída real). NO usa
    # GIVE_UP_AFTER_SECONDS=900 (umbral de "el ingestor se rinde y explota
    # con RuntimeError" — usar el MISMO valor anularía el propósito del
    # watchdog: el caso que debe cubrir es el "falso vivo", el proceso
    # colgado que NUNCA llega a levantar esa excepción). 600s da margen a una
    # reconexión SeedLink completa sin nunca coincidir con 1 ciclo, y alerta
    # ANTES que el propio GIVE_UP_AFTER_SECONDS=900 (ver design.md, Decision
    # "Umbral de seedlink_ingestor caído").
    watchdog_seedlink_stale_after_seconds: int = 600
    # TTL del heartbeat de events_ingestor en Redis: 3x el intervalo de
    # escritura (watchdog_events_heartbeat_interval_seconds, ver más abajo),
    # mismo margen 3x que ya usa fdsn_warmup entre ciclo y TTL de su caché.
    watchdog_events_heartbeat_ttl_seconds: int = 180
    # La ESCRIBE events_ingestor.py (no watchdog.py), pero se declara acá,
    # en el mismo bloque watchdog_*, para no crear un Settings paralelo.
    # 60 s coincide con el poll de USGS.
    watchdog_events_heartbeat_interval_seconds: int = 60

    # Rate limiting
    rate_limit_enabled: bool = False
    rate_limit_per_minute: int = 60

    # Emails transaccionales del flujo de beta (email_service.py). Sin
    # resend_api_key el servicio queda deshabilitado y sólo loguea (dev
    # local). resend_from DEBE ser del dominio verificado en Resend.
    # beta_notify_email: destinatario del aviso "nuevo interesado".
    resend_api_key: Optional[str] = None
    resend_from: str = "GeoSpectrum <noreply@geospectrum.org>"
    beta_notify_email: Optional[str] = None

    # Migraciones al arranque (scripts/apply_migrations.py). False por
    # default: en dev local se siguen aplicando a mano; en Railway SOLO el
    # servicio api lo activa — seedlink/inpres comparten imagen y base pero
    # no deben competir por el DDL en cada deploy.
    run_migrations_on_startup: bool = False

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
        "http://localhost:3008,http://localhost:3000," "http://127.0.0.1:3008,http://127.0.0.1:3000"
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
        return bool(
            self.google_client_id and self.google_client_secret and self.google_redirect_uri
        )


# Singleton
settings = Settings()

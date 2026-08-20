"""
Servicio principal de Monitoreo Sísmico.

API REST productiva para consulta de KPIs, eventos y alertas sísmicas.
Integra USGS ComCat + INPRES Argentina.

Endpoints:
- GET /health: Health check (liveness/readiness probes)
- GET /metrics: Métricas Prometheus
- GET /report: Reporte completo con KPIs, alertas y eventos
- GET /events: Solo lista de eventos
- GET /alerts: Solo alertas activas
"""

import asyncio
import logging
import uuid
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator, Optional
from uuid import UUID

import asyncpg
import redis.asyncio as aioredis
from authlib.integrations.starlette_client import OAuth
from authlib.integrations.base_client.errors import OAuthError
from fastapi import (
    Depends,
    FastAPI,
    HTTPException,
    Response,
    status,
    Query,
    Request,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, PlainTextResponse, RedirectResponse
from prometheus_client import Counter, Histogram, generate_latest, CONTENT_TYPE_LATEST
from starlette.middleware.sessions import SessionMiddleware

from src.config.settings import settings
from src.observability.glitchtip import init_glitchtip
from src.observability.logging_config import configure_logging
from src.observability.request_context import request_id_ctx
from src.models.beta import BetaSignupItem, BetaSignupRequest
from src.models.event import MonitorReport, SeismicEvent, Alert
from src.models.invitation import InvitationCreate, InvitationPublic, InvitationWithToken
from src.models.user import (
    AccountExport,
    CurrentUser,
    MeResponse,
    TotpSetupResponse,
    TotpVerifyRequest,
    RoleChangeRequest,
    UserCreate,
    UserListItem,
    UserProfile,
    UserProfileUpdate,
    UserPublic,
    UserRole,
)
from src.services.usgs_service import fetch_usgs_events
from src.services.inpres_service import fetch_inpres_events
from src.services.emsc_service import fetch_emsc_events
from src.services.emsc_detail_service import EMSCDetailService
from src.services.merge_service import merge_all_sources
from src.services.report_service import build_report, count_by_source, CANONICAL_SOURCES
from src.services.spectrogram_service import (
    get_spectrogram_service,
    resolve_live_catalog,
    LIVE_CANDIDATES_BY_CITY,
)
from src.services.event_bus import RedisPubSubBus
from src.services.timescale_service import TimescaleColumnWriter
from src.services.auth_service import (
    AccountDeactivatedError,
    AuthService,
    CannotAssignHigherOrEqualRoleError,
    CannotChangeSuperadminRoleError,
    CannotManageHigherOrEqualRoleError,
    CannotManageSelfError,
    EmailAlreadyRegisteredError,
    InvalidInvitationError,
    InvalidTokenError,
    InvitationEmailMismatchError,
    InvitationRequiredError,
    InvalidTotpCodeError,
    LastSuperadminError,
    Login2FAAttemptLimiter,
    TokenExpiredError,
    TooManyTotpAttemptsError,
    TotpAlreadyEnabledError,
    TotpNotAvailableForGoogleOnlyUserError,
    UserAlreadyDeactivatedError,
    UserAlreadyHasRoleError,
    UserNotDeactivatedError,
    UserNotFoundError,
)
from src.api.deps import (
    SESSION_COOKIE_NAME,
    get_current_user,
    get_current_user_optional,
    require_min_role,
)
from src.services.email_service import EmailService
from src.services.invitation_service import (
    PENDING_PREDICATE_SQL,
    CannotInviteHigherRoleError,
    InvitationAlreadyAcceptedError,
    InvitationAlreadyExistsError,
    InvitationNotFoundError,
    InvitationNotPendingError,
    InvitationService,
    insert_invitation_row,
)
from src.api.routers import areas as areas_router
from src.services.area_service import AreaService
from src.services.geo_filter import area_to_filter_dict
from src.services import cache

# =============================================================================
# Observability — must happen before any logger is used
# =============================================================================

init_glitchtip("api")
configure_logging(settings.log_level)

logger = logging.getLogger(__name__)


# =============================================================================
# Métricas Prometheus
# =============================================================================

# Contadores
requests_total = Counter(
    "geospectrum_requests_total",
    "Total de requests por endpoint",
    ["endpoint", "status"],
)

events_fetched = Counter(
    "geospectrum_events_fetched_total",
    "Total de eventos obtenidos",
    ["source"],
)

alerts_generated = Counter(
    "geospectrum_alerts_generated_total",
    "Total de alertas generadas",
    ["tipo"],
)

data_source_errors = Counter(
    "geospectrum_data_source_errors_total",
    "Errores al consultar fuentes externas",
    ["source"],
)

# Histogramas
request_duration = Histogram(
    "geospectrum_request_duration_seconds",
    "Duración de requests",
    ["endpoint"],
)


# =============================================================================
# Lifecycle hooks
# =============================================================================

event_bus = RedisPubSubBus(settings.redis_url)
column_writer: Optional[TimescaleColumnWriter] = (
    TimescaleColumnWriter(settings.timescaledb_dsn) if settings.timescaledb_dsn else None
)

# Cliente Redis dedicado al rate-limiting de POST /auth/2fa/login-verify
# (account-settings, fix post-verify — ver Login2FAAttemptLimiter en
# auth_service.py para la justificación de por qué Redis y no in-memory).
# Deliberadamente SEPARADO de `event_bus`: son responsabilidades distintas
# (pub/sub de espectrogramas vs. contador de intentos de login) con ciclos
# de vida propios; acoplarlos haría que un fallo/cierre de uno arrastre al
# otro sin necesidad.
totp_login_attempt_redis: aioredis.Redis = aioredis.from_url(
    settings.redis_url, decode_responses=True
)

# Google OAuth (google-oauth, Phase 3). Instancia module-level, igual que
# event_bus/column_writer arriba — el registro real del provider "google"
# (client_id/secret/discovery) ocurre en lifespan(), condicionado a
# settings.google_oauth_configured (ver design.md Decision 1: fail-fast
# CONDICIONAL, no total — a diferencia de AUTH_SECRET_KEY, el servidor
# arranca igual si faltan las credenciales de Google).
oauth = OAuth()


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Lifecycle manager para startup/shutdown."""
    logger.info("GeoSpectrum Service starting")
    logger.info("Region: %s", settings.bbox)
    logger.info("Source min magnitude: %s", settings.source_min_magnitude)
    logger.info("Window: %s minutes", settings.window_minutes)

    if settings.inpres_proxy_url:
        logger.info("INPRES proxy: %s", settings.inpres_proxy_url)
    else:
        logger.warning("INPRES proxy not configured - running USGS-only mode")

    try:
        await event_bus.connect()
        logger.info("EventBus (Redis) conectado: %s", settings.redis_url)
    except Exception:
        logger.warning(
            "EventBus (Redis) no disponible — /ws/spectrogram no funcionará "
            "hasta que Redis esté arriba y se reinicie el servicio",
            exc_info=True,
        )

    # Rate-limiting de POST /auth/2fa/login-verify (account-settings, fix
    # post-verify) — best-effort, MISMO criterio que event_bus arriba: si
    # Redis no está disponible al arrancar, el servicio NO aborta (a
    # diferencia de AUTH_SECRET_KEY/Postgres abajo). Ver
    # Login2FAAttemptLimiter.check_not_locked()/register_failure() en
    # auth_service.py — si `totp_login_attempt_redis` no llegó a conectar,
    # esas llamadas fallarían; se documenta como limitación conocida (ver
    # design.md) en vez de bloquear el arranque completo del servicio por un
    # rate-limiter, que es una mitigación de un riesgo ya aceptado, no una
    # garantía de seguridad crítica como la firma JWT.
    try:
        await totp_login_attempt_redis.ping()
        logger.info("Rate-limiter de 2FA login-verify (Redis) conectado: %s", settings.redis_url)
    except Exception:
        logger.warning(
            "Redis no disponible para el rate-limiter de POST "
            "/auth/2fa/login-verify — ese endpoint quedará SIN límite de "
            "intentos hasta que Redis esté arriba y se reinicie el servicio",
            exc_info=True,
        )

    if column_writer is not None:
        try:
            await column_writer.connect()
            logger.info("TimescaleDB conectado: %s", settings.timescaledb_host)
        except Exception:
            logger.warning(
                "TimescaleDB no disponible — /spectrograms/{channel}/history no funcionará",
                exc_info=True,
            )
    else:
        logger.info(
            "TimescaleDB no configurado (TIMESCALEDB_HOST vacío) — sin historial persistido"
        )

    # --------------------------------------------------------------------
    # Auth (multi-user-auth, Fase 3) — FAIL-FAST, deliberadamente NO
    # best-effort como event_bus/column_writer arriba.
    #
    # Decisión explícita del usuario (ver tasks.md 3.1 y design.md): si
    # AUTH_SECRET_KEY no está configurada, el proceso NO debe aceptar
    # requests. Una clave de firma JWT ausente o predecible permite a
    # cualquiera forjar tokens válidos (incluyendo tokens de rol "admin"),
    # lo que es una vulnerabilidad crítica de autenticación — no una
    # degradación aceptable de servicio como "no hay historial" (Timescale)
    # o "no hay espectrograma en vivo" (Redis). Por eso se levanta acá,
    # dentro de lifespan(), y no se atrapa: debe abortar el arranque.
    if not settings.auth_secret_key:
        raise RuntimeError(
            "AUTH_SECRET_KEY is required — refusing to start with an "
            "unsigned/predictable JWT secret (a missing signing key allows "
            "forging valid auth tokens, including admin-role tokens)"
        )

    dsn = settings.timescaledb_dsn
    if dsn is None:
        raise RuntimeError(
            "TimescaleDB/Postgres connection is required for the `users` "
            "table (auth_service) — configure TIMESCALEDB_HOST/USER/PASSWORD"
        )

    # Migraciones ANTES de abrir el pool: el resto del arranque asume el
    # schema al día. Sin try/except a propósito — una migración rota debe
    # abortar el deploy (Railway conserva el contenedor anterior), no dejar
    # la API corriendo contra un schema a medias. Gateado por env: sólo el
    # servicio api lo activa (ver scripts/apply_migrations.py).
    if settings.run_migrations_on_startup:
        from scripts.apply_migrations import apply_migrations

        await apply_migrations(dsn)
        logger.info("Migraciones aplicadas al arranque (RUN_MIGRATIONS_ON_STARTUP)")

    # Pool de Postgres COMPARTIDO (areas-of-interest / AOI-1). Antes vivía
    # encapsulado dentro de AuthService; se extrae acá porque area_service lo
    # necesita también y abrir un segundo pool contra la misma base duplicaría
    # conexiones sin motivo. app.state es el mismo lugar donde ya viven
    # auth_service/event_bus, así que no introduce un patrón nuevo.
    #
    # El dueño del ciclo de vida es este lifespan: se cierra abajo, DESPUÉS de
    # los servicios que lo usan. AuthService lo recibe inyectado y por eso su
    # close() es no-op (ver AuthService.__init__).
    db_pool = await asyncpg.create_pool(dsn, min_size=1, max_size=5)
    app.state.db_pool = db_pool

    auth_service = AuthService(
        dsn=dsn,
        secret_key=settings.auth_secret_key,
        token_expire_minutes=settings.auth_token_expire_minutes,
        pool=db_pool,
    )
    await auth_service.connect()
    app.state.auth_service = auth_service
    logger.info("AuthService conectado (tabla users en TimescaleDB/Postgres)")

    app.state.totp_login_attempt_limiter = Login2FAAttemptLimiter(totp_login_attempt_redis)

    # Áreas de interés (AOI-1). Recibe el pool COMPARTIDO y no lo cierra —
    # igual que AuthService, el dueño del ciclo de vida es este lifespan.
    # No tiene connect(): el pool ya está abierto cuando llega acá.
    app.state.area_service = AreaService(db_pool)

    # Invitaciones (email-invitations, Fase 3). Mismo patrón de pool
    # prestado que AreaService/AuthService: lo cierra este lifespan, no el
    # servicio. La vigencia de cada token sale de settings (Decision 9).
    app.state.invitation_service = InvitationService(
        pool=db_pool, expire_days=settings.invitation_expire_days
    )
    logger.info("InvitationService conectado (tabla invitations)")

    # Emails del flujo de beta (email_service.py). Sin estado ni conexión
    # persistente: un cliente httpx por envío — no participa del shutdown.
    app.state.email_service = EmailService(
        api_key=settings.resend_api_key,
        sender=settings.resend_from,
        admin_email=settings.beta_notify_email,
        dashboard_url=settings.dashboard_url,
    )
    logger.info("AreaService conectado (areas_of_interest)")

    # --------------------------------------------------------------------
    # Google OAuth (google-oauth, Phase 3) — registro CONDICIONAL, NO
    # fail-fast (ver design.md Decision 1). A diferencia del bloque de
    # AUTH_SECRET_KEY arriba, la ausencia de credenciales de Google NO
    # aborta el arranque: solo deshabilita /auth/google/* (responden 503),
    # el login por password sigue intacto.
    if settings.google_oauth_configured:
        oauth.register(
            "google",
            client_id=settings.google_client_id,
            client_secret=settings.google_client_secret,
            server_metadata_url="https://accounts.google.com/.well-known/openid-configuration",
            client_kwargs={"scope": "openid email profile"},
        )
        app.state.google_oauth_enabled = True
        logger.info("Google OAuth habilitado (/auth/google/*)")
    else:
        app.state.google_oauth_enabled = False
        logger.warning(
            "GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/GOOGLE_REDIRECT_URI no "
            "configurados — /auth/google/* responderá 503, login por "
            "password no afectado"
        )

    yield

    await event_bus.close()
    if column_writer is not None:
        await column_writer.close()
    await auth_service.close()
    # Después de auth_service (que ya no es dueño del pool): el pool compartido
    # se cierra último, cuando nadie lo puede estar usando.
    await db_pool.close()
    await totp_login_attempt_redis.aclose()
    logger.info("GeoSpectrum Service shutting down")


# =============================================================================
# FastAPI app
# =============================================================================

app = FastAPI(
    title="GeoSpectrum Service",
    description="Production-grade seismic monitoring with USGS + INPRES integration",
    version="1.0.0",
    docs_url="/docs",
    redoc_url="/redoc",
    lifespan=lifespan,
)

# =============================================================================
# CORS Configuration
# =============================================================================

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# =============================================================================
# Session Middleware (google-oauth) — SOLO para el `state`/`nonce` transitorio
# de Authlib durante el handshake OAuth, ver design.md Decision 2.
#
# CRÍTICO: session_cookie="oauth_state" está seteado explícitamente porque el
# default de Starlette es "session", que colisiona textualmente con
# SESSION_COOKIE_NAME = "session" (src/api/deps.py:30), la cookie del JWT de
# sesión de usuario ya emitida por /auth/login. Son dos cookies HTTP
# completamente distintas y sin relación: "oauth_state" vive solo los
# segundos que dura el flujo de Google; "session" es la sesión de usuario de
# larga duración. Reutiliza auth_secret_key (ya fail-fast garantizado arriba
# en lifespan()) en vez de introducir una key de firma nueva.
app.add_middleware(
    SessionMiddleware,
    secret_key=settings.auth_secret_key,
    session_cookie="oauth_state",
)

# =============================================================================
# Routers (AOI-1)
# =============================================================================
#
# Primer APIRouter del proyecto. El resto de los ~30 endpoints sigue con
# @app.get más abajo en este mismo archivo; migrarlos sería un refactor de toda
# la superficie de la API y no es parte de AOI-1.
app.include_router(areas_router.router)


# =============================================================================
# Request ID Middleware (M1.5)
# =============================================================================


@app.middleware("http")
async def request_id_middleware(request: Request, call_next):
    """Propaga o genera un X-Request-ID por cada request.

    - Si el cliente envía X-Request-ID, se reutiliza (trace distribuido).
    - Si no, se genera un UUID4.
    - El ID se almacena en request_id_ctx para que los loggers lo incluyan.
    - El ID se devuelve siempre en el header X-Request-ID de la response.
    """
    request_id = request.headers.get("X-Request-ID") or str(uuid.uuid4())
    token = request_id_ctx.set(request_id)
    try:
        response = await call_next(request)
    finally:
        request_id_ctx.reset(token)
    response.headers["X-Request-ID"] = request_id
    return response


# =============================================================================
# Endpoints
# =============================================================================


@app.get("/health", response_class=PlainTextResponse, tags=["ops"])
async def health() -> str:
    """
    Health check endpoint para liveness/readiness probes.

    Returns:
        "ok" siempre (si el servicio responde, está healthy)
    """
    requests_total.labels(endpoint="/health", status="200").inc()
    return "ok"


@app.get("/metrics", response_class=PlainTextResponse, tags=["ops"])
async def metrics() -> Response:
    """
    Endpoint de métricas Prometheus.

    Expone contadores y histogramas para scraping por Prometheus.
    """
    data = generate_latest()
    return Response(content=data, media_type=CONTENT_TYPE_LATEST)


async def _fetch_parallel(
    time_window: int,
    sources: list[str],
    min_magnitude: Optional[float] = None,
) -> tuple[list[SeismicEvent], list[SeismicEvent], list[SeismicEvent], list[str]]:
    """
    Consulta USGS, EMSC e INPRES en paralelo con asyncio.gather.

    Respeta el caché TTL: si hay resultado fresco para la clave fuente+ventana,
    lo devuelve sin hacer fetch externo.

    NOTA (change "unify-dashboard-events-source", Fase 3/4): esta copia se
    mantiene deliberadamente en main.py, aunque el diseño propone eliminarla
    (task 3.1), porque /events/search (que NO se toca en este change) es
    probada por tests/integration/test_api.py con
    `patch("src.main.fetch_usgs_events"/"fetch_emsc_events"/"fetch_inpres_events", ...)`.
    Esos mocks solo interceptan llamadas resueltas en el namespace de
    src.main; si /events/search delegara en report_service._fetch_parallel
    (que resuelve fetch_* en su propio namespace), los mocks dejarían de
    tener efecto y los tests golpearían red real. /report, /events y /alerts
    SÍ migraron a report_service.build_report (que trae su propia copia de
    _fetch_parallel) — ver Fase 3/4. Desviación de diseño documentada,
    priorizando no romper el contrato ya probado de /events/search.

    Returns:
        (usgs_events, emsc_events, inpres_events, errors)
    """
    ttl = settings.cache_ttl_seconds
    # Mismo criterio que report_service._fetch_parallel: el piso viaja en la
    # clave (el store del caché es global entre módulos).
    piso = min_magnitude if min_magnitude is not None else settings.source_min_magnitude

    async def _cached_fetch(source: str, fetcher: Any, window: int, with_min: bool) -> Any:
        key = f"{source}:{window}:{piso if with_min else '-'}"
        if ttl > 0:
            hit = cache.get(key)
            if hit is not None:
                return hit
        result = await (fetcher(window, min_magnitude=piso) if with_min else fetcher(window))
        if ttl > 0:
            cache.set(key, result, ttl)
        return result

    tasks = []
    fetch_map: list[str] = []

    if "usgs" in sources:
        tasks.append(_cached_fetch("usgs", fetch_usgs_events, time_window, with_min=True))
        fetch_map.append("usgs")
    if "emsc" in sources:
        tasks.append(_cached_fetch("emsc", fetch_emsc_events, time_window, with_min=True))
        fetch_map.append("emsc")
    if "inpres" in sources:
        # El proxy INPRES no acepta piso; se filtra post-merge en el endpoint.
        tasks.append(_cached_fetch("inpres", fetch_inpres_events, time_window, with_min=False))
        fetch_map.append("inpres")

    results = await asyncio.gather(*tasks)

    usgs_events: list[SeismicEvent] = []
    emsc_events: list[SeismicEvent] = []
    inpres_events: list[SeismicEvent] = []
    errors: list[str] = []

    for source, (evts, err) in zip(fetch_map, results):
        if err:
            errors.append(err)
            logger.warning("%s fetch error: %s", source.upper(), err)
        if source == "usgs":
            usgs_events = evts
        elif source == "emsc":
            emsc_events = evts
        elif source == "inpres":
            inpres_events = evts

    return usgs_events, emsc_events, inpres_events, errors


@app.get("/report", response_model=MonitorReport, tags=["monitoring"])
async def report(
    current_user: Optional[CurrentUser] = Depends(get_current_user_optional),
) -> MonitorReport:
    """
    Reporte completo de monitoreo sísmico, recortado al área de interés activa.

    Incluye:
    - KPIs calculados sobre ventana temporal
    - Alertas operativas activas
    - Lista completa de eventos detectados
    - Errores de fuentes externas (si los hubo)

    ENDPOINT PÚBLICO CON PERSONALIZACIÓN OPCIONAL (AOI-1). Usa
    get_current_user_optional, no get_current_user: con sesión válida el
    reporte se recorta al área activa del usuario; sin ella, al preset por
    defecto ("global"). Volverlo privado habría roto scripts/seismic-cli.py y
    el consumo anónimo del dashboard, sin ganar nada: el reporte no expone
    datos de nadie, sólo sismos públicos.

    El área recorta eventos, KPIs y alertas por igual (ver build_report): un
    usuario con área "Andes" no recibe alertas de sismos de Japón.

    DefaultAreaMissingError se deja propagar (500) igual que en /areas: una
    base sin seed es un error de configuración del servidor, no una condición
    del cliente, y debe llegar a los logs y a GlitchTip como tal.
    """
    with request_duration.labels(endpoint="/report").time():
        logger.info("Generating seismic report")

        # El área es una PERSONALIZACIÓN, no el corazón del endpoint: si no se
        # puede resolver (AreaService no wireado, base sin seed, Postgres
        # caído), /report degrada al reporte global en vez de devolver 500. El
        # monitoreo sísmico es la función principal y no puede caerse porque
        # falle el recorte por región. `area=None` reproduce exactamente el
        # comportamiento previo a AOI-1, que es el fallback correcto.
        area_filter = None
        try:
            area_service: AreaService = app.state.area_service
            if current_user is not None:
                active_area, _is_default = await area_service.get_active(current_user.id)
            else:
                active_area = await area_service.get_default()
            area_filter = area_to_filter_dict(active_area)
            logger.info("Report area: %s", active_area.slug)
        except Exception:
            # exception() y no warning(): el stack va a los logs y a GlitchTip
            # para que esto se vea y se arregle, en vez de quedar como una
            # degradación silenciosa que nadie nota.
            logger.exception("No se pudo resolver el área activa; reporte global")

        report_obj = await build_report(
            sources=CANONICAL_SOURCES,
            area=area_filter,
        )
        logger.info("Merged events: %d total", len(report_obj.eventos))

        # Desglose por fuente para events_fetched: se calcula sobre eventos
        # ya fusionados (report_obj.eventos), no sobre las listas pre-fusión
        # (esas viven dentro de build_report y no se exponen para evitar
        # duplicar el fetch). count_by_source espera listas separadas por
        # fuente; se arman aquí filtrando por el campo `fuentes` de cada
        # evento fusionado — un evento fusionado de 2+ fuentes cuenta en
        # cada una de ellas, igual que antes cuando USGS/INPRES no tenían
        # overlap real en /report.
        usgs_evts = [e for e in report_obj.eventos if "USGS" in e.fuentes]
        emsc_evts = [e for e in report_obj.eventos if "EMSC" in e.fuentes]
        inpres_evts = [e for e in report_obj.eventos if "INPRES" in e.fuentes]
        source_counts = count_by_source(usgs_evts, emsc_evts, inpres_evts)
        for source_name, count in source_counts.items():
            events_fetched.labels(source=source_name).inc(count)

        for err in report_obj.data_source_errors:
            src = err.split("_")[0]
            data_source_errors.labels(source=src).inc()

        for alerta in report_obj.alertas:
            alerts_generated.labels(tipo=alerta.tipo).inc()
            logger.warning("ALERT [%s]: %s", alerta.tipo, alerta.descripcion)

        requests_total.labels(endpoint="/report", status="200").inc()
        logger.info("Report generated successfully")

        return report_obj


@app.get("/events", response_model=list[SeismicEvent], tags=["monitoring"])
async def get_events() -> list[SeismicEvent]:
    """
    Solo eventos sísmicos (sin KPIs ni alertas).

    Útil para integraciones que solo necesitan lista de eventos.

    Returns:
        Lista de eventos normalizados
    """
    with request_duration.labels(endpoint="/events").time():
        report_obj = await build_report(sources=CANONICAL_SOURCES)

        requests_total.labels(endpoint="/events", status="200").inc()
        return report_obj.eventos


@app.get("/alerts", response_model=list[Alert], tags=["monitoring"])
async def get_alerts() -> list[Alert]:
    """
    Solo alertas activas (sin eventos completos).

    Útil para sistemas de notificación que solo necesitan saber
    si hay alertas operativas activas.

    Returns:
        Lista de alertas
    """
    with request_duration.labels(endpoint="/alerts").time():
        report_obj = await build_report(sources=CANONICAL_SOURCES)

        requests_total.labels(endpoint="/alerts", status="200").inc()
        return report_obj.alertas


# Presupuesto de altas a la beta por IP. 5/hora alcanza para cualquier humano
# (es UN formulario) y convierte el spam masivo desde una IP en goteo.
BETA_SIGNUP_MAX_PER_HOUR = 5
BETA_SIGNUP_WINDOW_SECONDS = 3600


def _client_ip(request: Request) -> str:
    """IP real del cliente, detrás del proxy de Railway o directa en dev.

    En producción el proxy pone la IP original como primer valor de
    X-Forwarded-For y `request.client.host` es la IP del proxy (inútil como
    clave de rate limit: todas las requests compartirían presupuesto). En dev
    no hay header y se usa la conexión directa. Un cliente directo puede
    falsear el header, pero en prod el proxy lo sobreescribe.
    """
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


@app.post("/beta-signups", status_code=status.HTTP_201_CREATED, tags=["beta"])
async def create_beta_signup(payload: BetaSignupRequest, request: Request) -> dict[str, bool]:
    """
    Alta pública en la lista de espera de la beta (landing).

    Defensa en capas contra spam (es el único endpoint público de escritura):

    * Honeypot: si `website` llega con contenido lo llenó un bot — se
      responde 201 normal SIN insertar (ver BetaSignupRequest).
    * Rate limit por IP en Redis: INCR + EXPIRE, misma conexión y mismo
      razonamiento multi-worker que Login2FAAttemptLimiter (auth_service.py).
      Si Redis no responde se degrada a aceptar el alta: perder protección
      anti-spam un rato es mejor que perder interesados reales.
    * EmailStr valida formato y largo; la tabla tiene UNIQUE.

    Idempotente a propósito: repetir un email ya anotado devuelve 201 igual
    (ON CONFLICT DO NOTHING). Distinguir "nuevo" de "ya existía" convertiría
    el endpoint en un oráculo de qué emails hay en la base — mismo criterio
    de no-enumeración que usa el login.
    """
    if payload.website:
        requests_total.labels(endpoint="/beta-signups", status="201").inc()
        return {"ok": True}

    try:
        key = f"beta_signup:{_client_ip(request)}"
        attempts = await totp_login_attempt_redis.incr(key)
        if attempts == 1:
            await totp_login_attempt_redis.expire(key, BETA_SIGNUP_WINDOW_SECONDS)
        if attempts > BETA_SIGNUP_MAX_PER_HOUR:
            requests_total.labels(endpoint="/beta-signups", status="429").inc()
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="Demasiados intentos. Probá de nuevo más tarde.",
            )
    except HTTPException:
        raise
    except Exception:
        logger.warning("Rate limit de /beta-signups no disponible (Redis caído?)", exc_info=True)

    email = payload.email.strip().lower()

    pool = request.app.state.db_pool
    # RETURNING distingue alta nueva de repetida SIN cambiar la respuesta
    # (el 201 idéntico preserva la no-enumeración): los emails salen sólo
    # en el alta nueva — reenviar confirmación en cada repost sería spam.
    # `locale` (migración 011) se persiste solo en el alta NUEVA: el ON
    # CONFLICT DO NOTHING garantiza que un repost no pisa el idioma original
    # (el repost no muta ni reenvía, comportamiento existente).
    inserted = await pool.fetchrow(
        "INSERT INTO beta_signups (email, locale) VALUES ($1, $2) "
        "ON CONFLICT (email) DO NOTHING RETURNING id",
        email,
        payload.locale,
    )

    if inserted is not None:
        # Confirmación al interesado + aviso al admin, en el idioma elegido
        # en la landing. EmailService nunca lanza: un Resend caído no rompe
        # el alta ya persistida.
        await request.app.state.email_service.send_beta_signup_emails(email, payload.locale)

    requests_total.labels(endpoint="/beta-signups", status="201").inc()
    return {"ok": True}


@app.get("/beta-signups", response_model=list[BetaSignupItem], tags=["beta"])
async def list_beta_signups(
    request: Request,
    _admin: CurrentUser = Depends(require_min_role(UserRole.ADMIN)),
) -> list[BetaSignupItem]:
    """Listado de interesados en la beta, para la vista admin del dashboard.

    Pendientes primero (approved_at NULL), más nuevos arriba — es la cola de
    trabajo del admin, no un log histórico.
    """
    pool = request.app.state.db_pool
    rows = await pool.fetch(
        """
        SELECT id, email, created_at, approved_at, locale
        FROM beta_signups
        ORDER BY (approved_at IS NULL) DESC, created_at DESC
        """
    )
    return [BetaSignupItem(**dict(row)) for row in rows]


@app.post("/beta-signups/{signup_id}/approve", tags=["beta"])
async def approve_beta_signup(
    signup_id: uuid.UUID,
    request: Request,
    admin: CurrentUser = Depends(require_min_role(UserRole.ADMIN)),
) -> dict[str, bool]:
    """Aprueba un interesado: crea su invitación y dispara la bienvenida.

    La invitación (rol viewer, vigencia settings.invitation_expire_days) se
    consume sola cuando el aprobado entra con Google — el email de
    bienvenida lleva link directo a /login, sin token (email-invitations,
    Decision 5). Todo lo persistente corre en UNA transacción; el email va
    DESPUÉS del commit, porque un Resend caído no debe deshacer una
    aprobación.

    Idempotente: re-aprobar a alguien ya aprobado (o con invitación pendiente
    vigente) no crea invitaciones duplicadas — respeta el invariante "una
    sola invitación pendiente y vigente por email" (migración 007).
    """
    pool = request.app.state.db_pool
    async with pool.acquire() as conn:
        async with conn.transaction():
            # FOR UPDATE: dos admins aprobando a la vez serializan acá.
            # `locale` viaja en el mismo SELECT: la invitación y el email de
            # aprobación heredan el idioma elegido en la landing (i18n).
            signup = await conn.fetchrow(
                "SELECT id, email, approved_at, locale FROM beta_signups WHERE id = $1 FOR UPDATE",
                signup_id,
            )
            if signup is None:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="beta signup not found",
                )

            already_approved = signup["approved_at"] is not None

            # Mismo advisory lock que create_invitation(), y ANTES del chequeo
            # de pendiente: sin esto, un approve y un create de admin
            # simultáneos sobre el mismo email veían cada uno "no hay
            # pendiente" y dejaban DOS invitaciones vigentes. El FOR UPDATE de
            # arriba serializa por signup, no por email — no alcanza.
            await conn.execute("SELECT pg_advisory_xact_lock(hashtext(lower($1)))", signup["email"])

            pending = await conn.fetchrow(
                f"SELECT id FROM invitations WHERE lower(email) = lower($1) AND {PENDING_PREDICATE_SQL}",
                signup["email"],
            )
            if pending is None and not already_approved:
                # insert_invitation_row (Fase 2 de email-invitations) es la
                # única fuente de verdad de cómo nace una invitación (token +
                # sha256 + expiración). El token en claro se DESCARTA a
                # propósito: este flujo no lo manda a ningún lado — el
                # consumo es por email (Google, Decision 5).
                # locale=signup["locale"]: la invitación hereda el idioma del
                # signup — toda la cadena aguas abajo (/invite, siembra de
                # cookie, primer login) ya es bilingüe por invitations.locale.
                # Idempotencia intacta: si ya hay pendiente vigente, este
                # branch no corre y el locale de esa invitación no se muta.
                await insert_invitation_row(
                    conn,
                    email=signup["email"],
                    role=UserRole.VIEWER,
                    invited_by=admin.id,
                    expire_days=settings.invitation_expire_days,
                    locale=signup["locale"],
                )

            await conn.execute(
                "UPDATE beta_signups SET approved_at = COALESCE(approved_at, now()) WHERE id = $1",
                signup_id,
            )

    if not already_approved:
        await request.app.state.email_service.send_beta_approved_email(
            signup["email"], signup["locale"]
        )

    return {"ok": True, "already_approved": already_approved}


@app.get("/events/search", response_model=list[SeismicEvent], tags=["monitoring"])
async def search_events(
    sources: Optional[str] = Query(
        None, description="Fuentes separadas por coma: usgs,emsc,inpres"
    ),
    min_mag: Optional[float] = Query(None, description="Magnitud mínima"),
    max_mag: Optional[float] = Query(None, description="Magnitud máxima"),
    min_depth: Optional[float] = Query(None, description="Profundidad mínima (km)"),
    max_depth: Optional[float] = Query(None, description="Profundidad máxima (km)"),
    min_lat: Optional[float] = Query(None, description="Latitud mínima"),
    max_lat: Optional[float] = Query(None, description="Latitud máxima"),
    min_lon: Optional[float] = Query(None, description="Longitud mínima"),
    max_lon: Optional[float] = Query(None, description="Longitud máxima"),
    window_minutes: Optional[int] = Query(None, description="Ventana temporal en minutos"),
    felt_only: Optional[bool] = Query(False, description="Solo eventos sentidos"),
    reviewed_only: Optional[bool] = Query(False, description="Solo eventos revisados"),
) -> list[SeismicEvent]:
    """
    Búsqueda avanzada de eventos sísmicos con filtros múltiples.
    """
    with request_duration.labels(endpoint="/events/search").time():
        time_window = window_minutes if window_minutes is not None else settings.window_minutes
        source_list = sources.lower().split(",") if sources else ["usgs", "emsc", "inpres"]
        source_list = [s.strip() for s in source_list]

        # El min_mag del usuario llega hasta la FUENTE: antes el fetch venía
        # recortado a un piso fijo y el slider del Explorador era mentira
        # (pedía 2.5 sobre un universo ya cortado en 3.0).
        usgs_events, emsc_events, inpres_events, errors = await _fetch_parallel(
            time_window, source_list, min_mag
        )
        for err in errors:
            logger.warning("Source error in search: %s", err)

        merged = merge_all_sources(usgs_events, emsc_events, inpres_events)
        filtered = merged

        if min_mag is not None:
            filtered = [e for e in filtered if e.mag >= min_mag]
        if max_mag is not None:
            filtered = [e for e in filtered if e.mag <= max_mag]
        if min_depth is not None:
            filtered = [e for e in filtered if e.prof_km is not None and e.prof_km >= min_depth]
        if max_depth is not None:
            filtered = [e for e in filtered if e.prof_km is not None and e.prof_km <= max_depth]
        if min_lat is not None:
            filtered = [e for e in filtered if e.lat >= min_lat]
        if max_lat is not None:
            filtered = [e for e in filtered if e.lat <= max_lat]
        if min_lon is not None:
            filtered = [e for e in filtered if e.lon >= min_lon]
        if max_lon is not None:
            filtered = [e for e in filtered if e.lon <= max_lon]
        if felt_only:
            filtered = [e for e in filtered if e.sentido]
        if reviewed_only:
            filtered = [e for e in filtered if e.revisado]

        logger.info(
            "Search: %d events (from %d total, sources: %s)",
            len(filtered),
            len(merged),
            source_list,
        )

        requests_total.labels(endpoint="/events/search", status="200").inc()
        return filtered


# =============================================================================
# Auth (multi-user-auth) — superficie nueva únicamente.
#
# Ningún endpoint existente de este archivo gana Depends() de auth en este
# change (ver design.md Decisión 2 y specs/auth/spec.md "No regresión sobre
# endpoints existentes"): /report, /events, /alerts, /events/search, etc.
# siguen 100% públicos. Solo /auth/me está protegido, porque no tiene
# sentido sin sesión.
# =============================================================================


def _get_auth_service(request: Request) -> AuthService:
    return request.app.state.auth_service


def _get_totp_login_attempt_limiter(request: Request) -> Login2FAAttemptLimiter:
    """DI del rate-limiter de POST /auth/2fa/login-verify (account-settings,
    fix post-verify) — mismo patrón que _get_auth_service arriba
    (request.app.state, poblado en lifespan())."""
    return request.app.state.totp_login_attempt_limiter


# Cookie del JWT de "pre-auth" (login de 2 pasos con 2FA — account-settings,
# design.md Decision 1). Separada de SESSION_COOKIE_NAME ("session") a
# propósito: un cliente que ignorara el estado "pendiente" nunca podría usar
# este token como si fuera una sesión completa simplemente por estar en la
# cookie de siempre — defensa en profundidad barata, además del rechazo
# explícito en get_current_user() (src/api/deps.py).
PENDING_2FA_COOKIE_NAME = "pending_2fa_session"
PENDING_2FA_COOKIE_MAX_AGE_SECONDS = 120


@app.post(
    "/auth/register", response_model=UserPublic, status_code=status.HTTP_201_CREATED, tags=["auth"]
)
async def register(
    payload: UserCreate,
    auth_service: AuthService = Depends(_get_auth_service),
) -> UserPublic:
    """
    Registro de usuario. RESUELTO (design.md Decision 6, Phase 3.5): el
    `role` recibido en el payload se IGNORA — AuthService.create_user()
    decide el rol real server-side según la regla de bootstrap (tabla
    `users` vacía -> primer registro es superadmin; no vacía -> siempre
    viewer). Ya no existe ningún path por el cual un caller no autenticado
    obtenga un rol superior a viewer vía este endpoint público, salvo el
    caso intencional del primer usuario del sistema. Ver
    [Requirement: Bootstrap del primer superadmin] en specs/auth/spec.md.

    Cubre [Requirement: Registro de usuario] — éxito con rol determinado
    server-side, y rechazo 409 por email duplicado. La validación 422
    (password corto, email inválido) la resuelve Pydantic vía UserCreate
    antes de que este código corra.
    """
    try:
        user = await auth_service.create_user(
            email=payload.email,
            password=payload.password,
            role=payload.role,
            invitation_token=payload.invitation_token,
        )
    except EmailAlreadyRegisteredError:
        return JSONResponse(
            status_code=status.HTTP_409_CONFLICT,
            content={"error": "email already registered"},
        )
    except InvitationRequiredError:
        # Registro invitation-only (email-invitations, Decision 5): sin
        # invitación pendiente y vigente no se crea NADA — este endpoint es
        # público y sin este gate cualquiera se registraba (el bootstrap del
        # primer usuario es la única excepción, decidida server-side).
        requests_total.labels(endpoint="/auth/register", status="403").inc()
        return JSONResponse(
            status_code=status.HTTP_403_FORBIDDEN,
            content={"error": "invitation_required"},
        )
    except InvitationEmailMismatchError:
        # ANTES que InvalidInvitationError (es su subclase): token válido
        # pero el email del payload no es el invitado — 422, la invitación
        # NO se quema (el rollback de la transacción revierte el consumo).
        requests_total.labels(endpoint="/auth/register", status="422").inc()
        return JSONResponse(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            content={"error": "invitation email mismatch"},
        )
    except InvalidInvitationError:
        # Token presente pero no consumible: desconocido, expirado, revocado
        # o ya usado — 410 Gone (matriz de Decision 3).
        requests_total.labels(endpoint="/auth/register", status="410").inc()
        return JSONResponse(
            status_code=status.HTTP_410_GONE,
            content={"error": "invalid invitation"},
        )

    requests_total.labels(endpoint="/auth/register", status="201").inc()
    return user


@app.post("/auth/login", tags=["auth"])
async def login(
    payload: dict,
    response: Response,
    auth_service: AuthService = Depends(_get_auth_service),
    totp_limiter: Login2FAAttemptLimiter = Depends(_get_totp_login_attempt_limiter),
):
    """
    Login. Mensaje de error genérico e indistinguible entre "email no
    existe" y "password incorrecto" — [Requirement: Login].

    NOTA: se recibe `payload: dict` (no un modelo Pydantic dedicado) porque
    el shape {email, password} no tiene reglas de validación propias más
    allá de "son strings" — a diferencia de UserCreate (que sí valida
    min_length/EmailStr para /auth/register), login no debe revelar vía 422
    si el email tiene formato inválido con un mensaje distinto al de
    credenciales incorrectas, para no filtrar información. Se valida
    manualmente abajo y cualquier fallo cae en el mismo 401 genérico.
    """
    email = payload.get("email")
    password = payload.get("password")

    user = await auth_service.get_user_by_email(email) if email else None
    password_ok = (
        auth_service.verify_password(password, user.password_hash)
        if user is not None and password
        else False
    )

    if user is None or not password_ok:
        requests_total.labels(endpoint="/auth/login", status="401").inc()
        return JSONResponse(
            status_code=status.HTTP_401_UNAUTHORIZED,
            content={"error": "invalid credentials"},
        )

    # (user-management, tarea 1.11, design.md Decision 3) Cuenta desactivada.
    #
    # Ubicación CRÍTICA, no reordenar: va DESPUÉS del bloque de credenciales
    # inválidas y ANTES del de 2FA.
    #
    # * Después del 401: el 403 explícito sólo lo ve quien probó su identidad
    #   con la password correcta. Emitirlo apenas se encuentra al usuario
    #   convertiría el endpoint en un oráculo de enumeración — cualquiera
    #   mandando {email, password: "x"} podría distinguir "existe y está
    #   desactivada" de "no existe". El docstring de arriba compromete
    #   explícitamente un mensaje indistinguible; esto no lo rompe.
    # * Antes del 2FA: si no, una cuenta desactivada con totp_enabled=true
    #   recibiría la cookie `pending_2fa_session` — una sesión parcial emitida
    #   a alguien que no tiene acceso.
    if user.deactivated_at is not None:
        requests_total.labels(endpoint="/auth/login", status="403").inc()
        return JSONResponse(
            status_code=status.HTTP_403_FORBIDDEN,
            content={"error": "account deactivated"},
        )

    # (account-settings, tarea 3.3, design.md Decision 1) Login de dos pasos
    # cuando totp_enabled=true: password correcto por sí solo NO otorga
    # sesión completa. Se emite un JWT de pre-auth de vida corta en una
    # cookie SEPARADA de `session`, y se responde {"requires_2fa": true} sin
    # UserPublic — el frontend usa este shape para distinguir "login
    # completo" de "falta segundo factor" (dashboard/lib/auth.ts, Phase 4).
    if user.totp_enabled:
        pre_auth_token = auth_service.create_access_token(user, pending_2fa=True)
        # Rate-limiting de login-verify (account-settings, fix post-verify):
        # un pre-auth NUEVO reinicia el presupuesto de intentos de código
        # para este usuario — el contador es por `sub` (ver
        # Login2FAAttemptLimiter en auth_service.py), así que sin este reset
        # explícito un usuario que ya agotó sus intentos en un login previo
        # seguiría bloqueado en el login siguiente aunque el TTL no haya
        # vencido. Best-effort: si Redis no está disponible, no debe romper
        # el login (mismo criterio best-effort que el resto del uso de Redis
        # en este proyecto — ver event_bus).
        try:
            await totp_limiter.reset(user.id)
        except Exception:
            logger.warning(
                "No se pudo resetear el rate-limiter de 2FA login-verify "
                "para user_id=%s (Redis no disponible?)",
                user.id,
                exc_info=True,
            )
        # NOTA: la cookie se setea sobre el JSONResponse que efectivamente
        # se retorna, NO sobre el `response: Response` inyectado por FastAPI
        # — un `return JSONResponse(...)` explícito reemplaza por completo
        # la respuesta que FastAPI construiría a partir de ese `response`
        # inyectado, así que cualquier `response.set_cookie(...)` hecho
        # sobre él se perdería silenciosamente (bug real detectado en
        # verificación: el test de integración de esta rama fallaba porque
        # la cookie pending_2fa_session nunca llegaba al cliente).
        json_response = JSONResponse(
            status_code=status.HTTP_200_OK,
            content={"requires_2fa": True},
        )
        json_response.set_cookie(
            PENDING_2FA_COOKIE_NAME,
            pre_auth_token,
            httponly=True,
            secure=True,
            samesite="lax",
            max_age=PENDING_2FA_COOKIE_MAX_AGE_SECONDS,
        )
        requests_total.labels(endpoint="/auth/login", status="200").inc()
        return json_response

    token = auth_service.create_access_token(user)
    response.set_cookie(
        SESSION_COOKIE_NAME,
        token,
        httponly=True,
        secure=True,
        samesite="lax",
        max_age=settings.auth_token_expire_minutes * 60,
        domain=settings.auth_cookie_domain,
    )

    requests_total.labels(endpoint="/auth/login", status="200").inc()
    return UserPublic(
        id=user.id,
        email=user.email,
        role=user.role,
        google_id=user.google_id,
        name=user.name,
        avatar_url=user.avatar_url,
    )


@app.post("/auth/logout", status_code=status.HTTP_204_NO_CONTENT, tags=["auth"])
async def logout(response: Response) -> None:
    """
    Logout. NO depende de get_current_user a propósito — debe funcionar
    incluso sin sesión activa [Requirement: Logout / Scenario: Logout sin
    sesión activa no falla].
    """
    response.delete_cookie(SESSION_COOKIE_NAME, samesite="lax", domain=settings.auth_cookie_domain)
    requests_total.labels(endpoint="/auth/logout", status="204").inc()


@app.get("/auth/me", response_model=MeResponse, tags=["auth"])
async def get_me(
    current_user: CurrentUser = Depends(get_current_user),
    auth_service: AuthService = Depends(_get_auth_service),
) -> MeResponse:
    """
    Perfil del usuario autenticado. Protegido con Depends(get_current_user)
    — [Requirement: Perfil del usuario autenticado].

    `onboarding_completed_at` se lee de la BASE en cada request, no del JWT
    (email-invitations, Decision 6): es un dato mutable — si viajara como
    claim quedaría stale tras completar el wizard hasta el próximo re-login.
    """
    onboarding_completed_at = await auth_service.get_onboarding_status(current_user.id)
    requests_total.labels(endpoint="/auth/me", status="200").inc()
    return MeResponse(
        **current_user.model_dump(),
        onboarding_completed_at=onboarding_completed_at,
    )


@app.post(
    "/auth/me/onboarding-complete",
    status_code=status.HTTP_204_NO_CONTENT,
    tags=["auth"],
)
async def complete_onboarding(
    current_user: CurrentUser = Depends(get_current_user),
    auth_service: AuthService = Depends(_get_auth_service),
) -> None:
    """
    Marca el onboarding del propio usuario como completado (wizard terminado
    O salteado — ambos convergen acá, Decision 7). Sin restricción de rol:
    cualquier usuario autenticado completa SU onboarding. Idempotente: la
    segunda llamada es un no-op y el timestamp original no se pisa —
    [Requirement: Persistencia del estado de onboarding].
    """
    await auth_service.complete_onboarding(current_user.id)
    requests_total.labels(endpoint="/auth/me/onboarding-complete", status="204").inc()


# =============================================================================
# email-invitations — gestión admin de invitaciones + validación pública
#
# Los 5 endpoints de gestión usan require_min_role(UserRole.ADMIN) existente
# (deps.py NO se toca — Decision 3: cubre admin y superadmin tal cual está).
# /auth/invitations/validate es PÚBLICO: lo consume la página /invite/[token]
# antes de que exista sesión alguna. Códigos de error según la matriz exacta
# de design.md Decision 3; shape {"error": ...} + métricas, como el resto.
# =============================================================================


def _get_invitation_service(request: Request) -> InvitationService:
    """DI del servicio de invitaciones — mismo patrón que _get_auth_service
    (request.app.state, poblado en lifespan())."""
    return request.app.state.invitation_service


@app.post(
    "/auth/invitations",
    response_model=InvitationWithToken,
    status_code=status.HTTP_201_CREATED,
    tags=["auth"],
)
async def create_invitation(
    payload: InvitationCreate,
    admin: CurrentUser = Depends(require_min_role(UserRole.ADMIN)),
    invitation_service: InvitationService = Depends(_get_invitation_service),
):
    """
    Crea una invitación y devuelve el token en claro — la ÚNICA vez que el
    sistema lo entrega (la base persiste solo el sha256; el reenvío genera
    uno NUEVO, no repite éste) — [Requirement: Creación de invitación].
    """
    try:
        invitation = await invitation_service.create_invitation(
            email=payload.email, role=payload.role, invited_by=admin, locale=payload.locale
        )
    except CannotInviteHigherRoleError:
        # Guard de escalación: un admin no se fabrica un superadmin por
        # interpósita invitación (Decision 3).
        requests_total.labels(endpoint="/auth/invitations", status="403").inc()
        return JSONResponse(
            status_code=status.HTTP_403_FORBIDDEN,
            content={"error": "cannot invite a role higher than your own"},
        )
    except EmailAlreadyRegisteredError:
        requests_total.labels(endpoint="/auth/invitations", status="409").inc()
        return JSONResponse(
            status_code=status.HTTP_409_CONFLICT,
            content={"error": "email already registered"},
        )
    except InvitationAlreadyExistsError:
        requests_total.labels(endpoint="/auth/invitations", status="409").inc()
        return JSONResponse(
            status_code=status.HTTP_409_CONFLICT,
            content={
                "error": "a pending invitation already exists for this email — resend it instead"
            },
        )

    requests_total.labels(endpoint="/auth/invitations", status="201").inc()
    return invitation


@app.get("/auth/invitations", response_model=list[InvitationPublic], tags=["auth"])
async def list_invitations(
    _admin: CurrentUser = Depends(require_min_role(UserRole.ADMIN)),
    invitation_service: InvitationService = Depends(_get_invitation_service),
) -> list[InvitationPublic]:
    """
    Listado con estado derivado (pending/accepted/revoked/expired) evaluado
    en la query. `list[InvitationPublic]` no puede filtrar tokens por
    construcción del tipo — [Requirement: Listado de invitaciones con estado].
    """
    invitations = await invitation_service.list_invitations()
    requests_total.labels(endpoint="/auth/invitations", status="200").inc()
    return invitations


@app.get("/auth/invitations/validate", tags=["auth"])
async def validate_invitation(
    token: str = Query(..., description="Token de invitación en claro (del link /invite/{token})"),
    invitation_service: InvitationService = Depends(_get_invitation_service),
):
    """
    Validación PÚBLICA de un token (página /invite/[token], sin sesión). NO
    consume: validar N veces deja la invitación igual de pendiente. 404 vs
    410 es deliberado (Decision 3): con 256 bits de entropía no hay riesgo
    de enumeración, y la UX distingue "link inválido" de "vencido — pedí un
    reenvío" — [Requirement: Validación pública del token de invitación].
    """
    try:
        invitation = await invitation_service.validate_token(token)
    except InvitationNotFoundError:
        requests_total.labels(endpoint="/auth/invitations/validate", status="404").inc()
        return JSONResponse(
            status_code=status.HTTP_404_NOT_FOUND,
            content={"error": "invalid invitation"},
        )
    except InvitationNotPendingError:
        requests_total.labels(endpoint="/auth/invitations/validate", status="410").inc()
        return JSONResponse(
            status_code=status.HTTP_410_GONE,
            content={"error": "invitation no longer valid"},
        )

    requests_total.labels(endpoint="/auth/invitations/validate", status="200").inc()
    return {
        "email": invitation.email,
        "role": invitation.role.value,
        # La página /invite/[token] muestra su copy en el idioma en que se
        # envió el email (pulido post-rollout, migración 010).
        "locale": invitation.locale,
        "expires_at": invitation.expires_at.isoformat(),
    }


@app.delete(
    "/auth/invitations/{invitation_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    tags=["auth"],
)
async def revoke_invitation(
    invitation_id: UUID,
    _admin: CurrentUser = Depends(require_min_role(UserRole.ADMIN)),
    invitation_service: InvitationService = Depends(_get_invitation_service),
):
    """
    Revoca una invitación no aceptada. 409 sobre una aceptada: revocar una
    invitación consumida no des-crea al usuario — rechazo explícito, no un
    no-op engañoso (Decision 3) — [Requirement: Revocación de invitación].
    """
    try:
        await invitation_service.revoke_invitation(invitation_id)
    except InvitationNotFoundError:
        requests_total.labels(endpoint="/auth/invitations/{id}", status="404").inc()
        return JSONResponse(
            status_code=status.HTTP_404_NOT_FOUND,
            content={"error": "invitation not found"},
        )
    except InvitationAlreadyAcceptedError:
        requests_total.labels(endpoint="/auth/invitations/{id}", status="409").inc()
        return JSONResponse(
            status_code=status.HTTP_409_CONFLICT,
            content={"error": "invitation already accepted"},
        )

    requests_total.labels(endpoint="/auth/invitations/{id}", status="204").inc()


@app.post(
    "/auth/invitations/{invitation_id}/resend",
    response_model=InvitationWithToken,
    tags=["auth"],
)
async def resend_invitation(
    invitation_id: UUID,
    _admin: CurrentUser = Depends(require_min_role(UserRole.ADMIN)),
    invitation_service: InvitationService = Depends(_get_invitation_service),
):
    """
    Regenera token + expiración (el link anterior queda muerto en el mismo
    acto; una expirada REVIVE) y devuelve el token nuevo en claro. 409 si ya
    fue aceptada o revocada — [Requirement: Reenvío de invitación con
    regeneración de token].
    """
    try:
        invitation = await invitation_service.resend_invitation(invitation_id)
    except InvitationNotFoundError:
        requests_total.labels(endpoint="/auth/invitations/{id}/resend", status="404").inc()
        return JSONResponse(
            status_code=status.HTTP_404_NOT_FOUND,
            content={"error": "invitation not found"},
        )
    except (InvitationAlreadyAcceptedError, InvitationNotPendingError):
        # Aceptada o revocada: ambas son 409 en el resend (matriz Decision 3).
        requests_total.labels(endpoint="/auth/invitations/{id}/resend", status="409").inc()
        return JSONResponse(
            status_code=status.HTTP_409_CONFLICT,
            content={"error": "invitation already accepted or revoked"},
        )

    requests_total.labels(endpoint="/auth/invitations/{id}/resend", status="200").inc()
    return invitation


@app.post(
    "/auth/invitations/{invitation_id}/mark-sent",
    status_code=status.HTTP_204_NO_CONTENT,
    tags=["auth"],
)
async def mark_invitation_email_sent(
    invitation_id: UUID,
    _admin: CurrentUser = Depends(require_min_role(UserRole.ADMIN)),
    invitation_service: InvitationService = Depends(_get_invitation_service),
):
    """
    Confirmación de envío del email (Decision 4): la invoca la route de Next
    tras un envío exitoso de Resend, con la cookie del admin — no es un
    reporte anónimo falsificable. Setea email_sent_at = now().
    """
    try:
        await invitation_service.mark_email_sent(invitation_id)
    except InvitationNotFoundError:
        requests_total.labels(endpoint="/auth/invitations/{id}/mark-sent", status="404").inc()
        return JSONResponse(
            status_code=status.HTTP_404_NOT_FOUND,
            content={"error": "invitation not found"},
        )

    requests_total.labels(endpoint="/auth/invitations/{id}/mark-sent", status="204").inc()


# =============================================================================
# user-management — administración de cuentas (listado + desactivar/reactivar)
#
# Los 3 endpoints viven acá y no en un router propio (design.md Decision 8):
# los 6 de /auth/invitations ya están en este módulo y partir los de usuarios
# dejaría el dominio auth en dos lugares. Todos con require_min_role(ADMIN)
# existente — deps.py NO se toca por permisos.
#
# Verbo POST y no DELETE a propósito: desactivar NO borra, y DELETE ya
# significa otra cosa en este proyecto (DELETE /account = hard-delete propio).
#
# Los labels de métrica son LITERALES (`/auth/users/{id}/deactivate`), sin
# interpolar el UUID, para no explotar la cardinalidad de Prometheus — mismo
# criterio que /auth/invitations/{id}/resend.
# =============================================================================


@app.get("/auth/users", response_model=list[UserListItem], tags=["auth"])
async def list_users(
    _admin: CurrentUser = Depends(require_min_role(UserRole.ADMIN)),
    auth_service: AuthService = Depends(_get_auth_service),
) -> list[UserListItem]:
    """
    Listado completo de usuarios para administración: TODOS (incluidos
    superadmins y el propio actor), con rol, origen (google/password), fecha
    de alta y `deactivated_at` (null = activa). `list[UserListItem]` no puede
    contener password_hash ni totp_secret por construcción del tipo —
    [Requirement: Listado de usuarios para administración].
    """
    users = await auth_service.list_users()
    requests_total.labels(endpoint="/auth/users", status="200").inc()
    return users


@app.post(
    "/auth/users/{user_id}/deactivate",
    status_code=status.HTTP_204_NO_CONTENT,
    # `response_model=None` es OBLIGATORIO acá: sin esto FastAPI infiere el
    # response_model desde la anotación de retorno (Optional[JSONResponse]),
    # concluye que la ruta tiene cuerpo y revienta al IMPORTAR el módulo con
    # "Status code 204 must not have a response body". La anotación describe
    # las ramas de error (que sí responden 403/404/409 con cuerpo); el 204 del
    # camino feliz no tiene ninguno. Los tests lo detectan, mypy solo no.
    response_model=None,
    tags=["auth"],
)
async def deactivate_user(
    user_id: UUID,
    admin: CurrentUser = Depends(require_min_role(UserRole.ADMIN)),
    auth_service: AuthService = Depends(_get_auth_service),
) -> Optional[JSONResponse]:
    """
    Soft-delete: setea `deactivated_at = now()` sin borrar nada. Bloquea los
    TRES caminos de acceso (login password, login Google y las sesiones ya
    emitidas, que mueren en el request siguiente) —
    [Requirement: Desactivación de cuenta (soft-delete)].

    Matriz de errores (design.md § Interfaces / Contracts): 409 auto-gestión,
    404 inexistente, 403 jerarquía, 409 ya desactivada. Los guards son
    server-side: la UI deshabilitando botones NO es el mecanismo de seguridad.
    """
    try:
        await auth_service.deactivate_user(admin, user_id)
    except CannotManageSelfError:
        # 409 y no 403: un superadmin tiene todo el permiso del mundo y aun
        # así no puede — es un conflicto de estado, no de autorización.
        requests_total.labels(endpoint="/auth/users/{id}/deactivate", status="409").inc()
        return JSONResponse(
            status_code=status.HTTP_409_CONFLICT,
            content={"error": "cannot deactivate your own account"},
        )
    except UserNotFoundError:
        requests_total.labels(endpoint="/auth/users/{id}/deactivate", status="404").inc()
        return JSONResponse(
            status_code=status.HTTP_404_NOT_FOUND,
            content={"error": "user not found"},
        )
    except CannotManageHigherOrEqualRoleError:
        requests_total.labels(endpoint="/auth/users/{id}/deactivate", status="403").inc()
        return JSONResponse(
            status_code=status.HTTP_403_FORBIDDEN,
            content={"error": "cannot manage a user with an equal or higher role"},
        )
    except UserAlreadyDeactivatedError:
        requests_total.labels(endpoint="/auth/users/{id}/deactivate", status="409").inc()
        return JSONResponse(
            status_code=status.HTTP_409_CONFLICT,
            content={"error": "user already deactivated"},
        )

    requests_total.labels(endpoint="/auth/users/{id}/deactivate", status="204").inc()
    # `return None` explícito y no caída por el borde: el tipo de retorno es
    # Optional[JSONResponse] porque las ramas de error SÍ devuelven un cuerpo.
    # En el camino feliz FastAPI emite el 204 sin cuerpo, que es lo correcto:
    # un 204 con payload es una contradicción del protocolo.
    return None


@app.post(
    "/auth/users/{user_id}/reactivate",
    status_code=status.HTTP_204_NO_CONTENT,
    # Ver el comentario simétrico en el decorador de deactivate_user().
    response_model=None,
    tags=["auth"],
)
async def reactivate_user(
    user_id: UUID,
    admin: CurrentUser = Depends(require_min_role(UserRole.ADMIN)),
    auth_service: AuthService = Depends(_get_auth_service),
) -> Optional[JSONResponse]:
    """
    Vuelve `deactivated_at` a NULL, restaurando el acceso por ambos caminos de
    login — [Requirement: Reactivación de cuenta]. Misma matriz de errores que
    deactivate, con 409 cuando la cuenta ya estaba activa (simetría con el 409
    de desactivar dos veces).
    """
    try:
        await auth_service.reactivate_user(admin, user_id)
    except CannotManageSelfError:
        requests_total.labels(endpoint="/auth/users/{id}/reactivate", status="409").inc()
        return JSONResponse(
            status_code=status.HTTP_409_CONFLICT,
            content={"error": "cannot manage your own account"},
        )
    except UserNotFoundError:
        requests_total.labels(endpoint="/auth/users/{id}/reactivate", status="404").inc()
        return JSONResponse(
            status_code=status.HTTP_404_NOT_FOUND,
            content={"error": "user not found"},
        )
    except CannotManageHigherOrEqualRoleError:
        requests_total.labels(endpoint="/auth/users/{id}/reactivate", status="403").inc()
        return JSONResponse(
            status_code=status.HTTP_403_FORBIDDEN,
            content={"error": "cannot manage a user with an equal or higher role"},
        )
    except UserNotDeactivatedError:
        requests_total.labels(endpoint="/auth/users/{id}/reactivate", status="409").inc()
        return JSONResponse(
            status_code=status.HTTP_409_CONFLICT,
            content={"error": "user is not deactivated"},
        )

    requests_total.labels(endpoint="/auth/users/{id}/reactivate", status="204").inc()
    # Ver el comentario simétrico en deactivate_user().
    return None


@app.post(
    "/auth/users/{user_id}/role",
    status_code=status.HTTP_204_NO_CONTENT,
    # Ver el comentario del decorador de deactivate_user(): sin
    # `response_model=None` FastAPI infiere el response_model desde
    # Optional[JSONResponse], concluye que un 204 tiene cuerpo y revienta al
    # IMPORTAR el módulo. mypy no lo ve; el primer test que levanta la app, sí.
    response_model=None,
    tags=["auth"],
)
async def change_user_role(
    user_id: UUID,
    payload: RoleChangeRequest,
    admin: CurrentUser = Depends(require_min_role(UserRole.ADMIN)),
    auth_service: AuthService = Depends(_get_auth_service),
) -> Optional[JSONResponse]:
    """
    Cambia el rol de OTRO usuario — [Requirement: Cambio de rol de un usuario
    existente]. 204 sin cuerpo, simétrico con deactivate/reactivate.

    Matriz de errores (specs/auth/spec.md § Matriz de status): 409 auto-cambio,
    404 inexistente, 403 jerarquía sobre el rol ACTUAL del objetivo, 403
    objetivo superadmin (guard dedicado), 403 jerarquía sobre el rol PEDIDO,
    409 no-op. Un `role` fuera del enum lo rechaza Pydantic con 422 antes de
    llegar acá.

    Los guards son server-side: el `<select>` deshabilitado de la UI no es el
    mecanismo de seguridad — [Scenario: El guard es server-side, no de UI].
    """
    try:
        await auth_service.change_user_role(admin, user_id, payload.role)
    except CannotManageSelfError:
        requests_total.labels(endpoint="/auth/users/{id}/role", status="409").inc()
        return JSONResponse(
            status_code=status.HTTP_409_CONFLICT,
            # El texto contiene "own account" a propósito: es la subcadena por
            # la que el frontend (UsersPanel.tsx) distingue este 409 del de
            # no-op. Contrato de facto — hay un test de integración que clava
            # el body literal para que reescribirlo reviente acá y no en una
            # traducción silenciosamente equivocada en producción.
            content={"error": "cannot change your own account role"},
        )
    except UserNotFoundError:
        requests_total.labels(endpoint="/auth/users/{id}/role", status="404").inc()
        return JSONResponse(
            status_code=status.HTTP_404_NOT_FOUND,
            content={"error": "user not found"},
        )
    except CannotManageHigherOrEqualRoleError:
        requests_total.labels(endpoint="/auth/users/{id}/role", status="403").inc()
        return JSONResponse(
            status_code=status.HTTP_403_FORBIDDEN,
            content={"error": "cannot manage a user with an equal or higher role"},
        )
    except CannotChangeSuperadminRoleError:
        requests_total.labels(endpoint="/auth/users/{id}/role", status="403").inc()
        return JSONResponse(
            status_code=status.HTTP_403_FORBIDDEN,
            content={"error": "cannot change the role of a superadmin"},
        )
    except CannotAssignHigherOrEqualRoleError:
        requests_total.labels(endpoint="/auth/users/{id}/role", status="403").inc()
        return JSONResponse(
            status_code=status.HTTP_403_FORBIDDEN,
            content={"error": "cannot assign a role equal to or higher than your own"},
        )
    except UserAlreadyHasRoleError:
        requests_total.labels(endpoint="/auth/users/{id}/role", status="409").inc()
        return JSONResponse(
            status_code=status.HTTP_409_CONFLICT,
            content={"error": "user already has that role"},
        )

    requests_total.labels(endpoint="/auth/users/{id}/role", status="204").inc()
    # Ver el comentario simétrico en deactivate_user().
    return None


# =============================================================================
# account-settings — 2FA TOTP (login de 2 pasos, setup, verify, disable)
#
# POST /auth/2fa/login-verify NO usa Depends(get_current_user): el token que
# consume es de pre-auth (pending_2fa=true), que get_current_user() rechaza
# explícitamente (design.md Decision 1, deps.py tarea 3.1). Decodifica el
# payload crudo a mano vía decode_token_payload().
#
# POST /auth/2fa/setup, /verify (setup) y /disable SÍ usan
# Depends(get_current_user) — requieren sesión COMPLETA.
# =============================================================================


@app.post("/auth/2fa/login-verify", tags=["auth"])
async def login_verify_2fa(
    payload: TotpVerifyRequest,
    request: Request,
    response: Response,
    auth_service: AuthService = Depends(_get_auth_service),
    totp_limiter: Login2FAAttemptLimiter = Depends(_get_totp_login_attempt_limiter),
):
    """
    Segundo paso del login con 2FA — [Requirement: Login con 2FA habilitado
    requiere segundo factor] + [Requirement: Uso de backup codes como
    alternativa al código TOTP en el login].

    Requiere la cookie `pending_2fa_session` (emitida por POST /auth/login
    cuando totp_enabled=true). Si está ausente/expirada/inválida -> 401 sin
    tocar ninguna cookie de sesión completa. Código válido (TOTP o backup
    code) -> emite `session` completa (create_access_token estándar), borra
    `pending_2fa_session`, responde 200 UserPublic. Código inválido -> 401.

    Rate-limiting (fix post-verify, ver Login2FAAttemptLimiter en
    auth_service.py): tras MAX_TOTP_LOGIN_ATTEMPTS intentos fallidos para el
    mismo pre-auth (`sub`), se rechaza con 401 SIN siquiera evaluar el
    código enviado — incluso uno correcto — forzando reiniciar el login
    desde POST /auth/login (que emite un pre-auth nuevo y resetea el
    contador). Best-effort: si Redis no está disponible, el endpoint
    degrada a "sin límite de intentos" en vez de romper el login (mismo
    criterio que el resto del uso de Redis en este proyecto).
    """
    pre_auth_token = request.cookies.get(PENDING_2FA_COOKIE_NAME)
    if pre_auth_token is None:
        requests_total.labels(endpoint="/auth/2fa/login-verify", status="401").inc()
        return JSONResponse(
            status_code=status.HTTP_401_UNAUTHORIZED,
            content={"error": "no pending 2FA session"},
        )

    try:
        token_payload = auth_service.decode_token_payload(pre_auth_token)
    except (InvalidTokenError, TokenExpiredError):
        requests_total.labels(endpoint="/auth/2fa/login-verify", status="401").inc()
        return JSONResponse(
            status_code=status.HTTP_401_UNAUTHORIZED,
            content={"error": "no pending 2FA session"},
        )

    if token_payload.get("pending_2fa") is not True:
        # Defensa en profundidad: un token que no sea de pre-auth (ej. uno
        # de sesión completa reenviado por error) tampoco debe habilitar
        # este flujo.
        requests_total.labels(endpoint="/auth/2fa/login-verify", status="401").inc()
        return JSONResponse(
            status_code=status.HTTP_401_UNAUTHORIZED,
            content={"error": "no pending 2FA session"},
        )

    user_id = UUID(token_payload["sub"])

    # Rate-limiting: se chequea ANTES de verificar el código, para que un
    # pre-auth ya bloqueado rechace incluso un código CORRECTO (Requirement
    # pedido: forzar reinicio del login desde POST /auth/login). Best-effort:
    # si Redis no está disponible, se loguea y se continúa sin límite en vez
    # de romper el login por completo.
    try:
        await totp_limiter.check_not_locked(user_id)
    except TooManyTotpAttemptsError:
        requests_total.labels(endpoint="/auth/2fa/login-verify", status="401").inc()
        return JSONResponse(
            status_code=status.HTTP_401_UNAUTHORIZED,
            content={"error": "invalid code"},
        )
    except Exception:
        logger.warning(
            "No se pudo consultar el rate-limiter de 2FA login-verify para "
            "user_id=%s (Redis no disponible?) — continuando sin límite",
            user_id,
            exc_info=True,
        )

    code_ok = await auth_service.verify_totp_or_backup_code(user_id, payload.code)
    if not code_ok:
        # Mismo criterio de no filtrar información que el login por
        # password: no se distingue "código TOTP incorrecto" de "backup code
        # inválido/ya usado" en el mensaje.
        try:
            await totp_limiter.register_failure(user_id)
        except Exception:
            logger.warning(
                "No se pudo registrar el intento fallido de 2FA login-verify "
                "para user_id=%s (Redis no disponible?)",
                user_id,
                exc_info=True,
            )
        requests_total.labels(endpoint="/auth/2fa/login-verify", status="401").inc()
        return JSONResponse(
            status_code=status.HTTP_401_UNAUTHORIZED,
            content={"error": "invalid code"},
        )

    user = await auth_service.get_user_by_id(user_id)
    if user is None:
        # El usuario referenciado por el claim `sub` del pre-auth token ya
        # no existe (ej. borró su cuenta entre el login y este segundo
        # paso) — mismo 401 genérico, sin distinguir la causa.
        requests_total.labels(endpoint="/auth/2fa/login-verify", status="401").inc()
        return JSONResponse(
            status_code=status.HTTP_401_UNAUTHORIZED,
            content={"error": "invalid code"},
        )

    try:
        await totp_limiter.reset(user_id)
    except Exception:
        logger.warning(
            "No se pudo resetear el rate-limiter de 2FA login-verify tras "
            "login exitoso para user_id=%s (Redis no disponible?)",
            user_id,
            exc_info=True,
        )

    token = auth_service.create_access_token(user)
    response.set_cookie(
        SESSION_COOKIE_NAME,
        token,
        httponly=True,
        secure=True,
        samesite="lax",
        max_age=settings.auth_token_expire_minutes * 60,
        domain=settings.auth_cookie_domain,
    )
    response.delete_cookie(PENDING_2FA_COOKIE_NAME, samesite="lax")

    requests_total.labels(endpoint="/auth/2fa/login-verify", status="200").inc()
    return UserPublic(
        id=user.id,
        email=user.email,
        role=user.role,
        google_id=user.google_id,
        name=user.name,
        avatar_url=user.avatar_url,
    )


@app.post("/auth/2fa/setup", response_model=TotpSetupResponse, tags=["auth"])
async def setup_2fa(
    current_user: CurrentUser = Depends(get_current_user),
    auth_service: AuthService = Depends(_get_auth_service),
):
    """
    [Requirement: Activación de 2FA TOTP restringida a usuarios con password
    propio] — protegido por Depends(get_current_user) (sesión completa, un
    token pending_2fa=true ya es rechazado ahí).
    """
    try:
        otpauth_uri, backup_codes = await auth_service.enable_totp(current_user.id)
    except TotpNotAvailableForGoogleOnlyUserError:
        requests_total.labels(endpoint="/auth/2fa/setup", status="409").inc()
        return JSONResponse(
            status_code=status.HTTP_409_CONFLICT,
            content={"error": "2FA is not available for accounts without a password"},
        )
    except TotpAlreadyEnabledError:
        requests_total.labels(endpoint="/auth/2fa/setup", status="409").inc()
        return JSONResponse(
            status_code=status.HTTP_409_CONFLICT,
            content={"error": "2FA is already enabled — disable it before setting up again"},
        )

    requests_total.labels(endpoint="/auth/2fa/setup", status="200").inc()
    return TotpSetupResponse(otpauth_uri=otpauth_uri, backup_codes=backup_codes)


@app.post("/auth/2fa/verify", tags=["auth"])
async def verify_2fa_setup(
    payload: TotpVerifyRequest,
    current_user: CurrentUser = Depends(get_current_user),
    auth_service: AuthService = Depends(_get_auth_service),
):
    """
    Verificación del código TOTP en el SETUP (distinto de
    /auth/2fa/login-verify) — [Requirement: Verificación del código TOTP en
    el setup]. Protegido por Depends(get_current_user): requiere sesión
    completa (el setup ya se hizo con esa misma sesión en /auth/2fa/setup).
    """
    try:
        await auth_service.verify_totp_setup(current_user.id, payload.code)
    except InvalidTotpCodeError:
        requests_total.labels(endpoint="/auth/2fa/verify", status="400").inc()
        return JSONResponse(
            status_code=status.HTTP_400_BAD_REQUEST,
            content={"error": "invalid or expired code"},
        )

    requests_total.labels(endpoint="/auth/2fa/verify", status="200").inc()
    return {}


@app.post("/auth/2fa/disable", tags=["auth"])
async def disable_2fa(
    current_user: CurrentUser = Depends(get_current_user),
    auth_service: AuthService = Depends(_get_auth_service),
):
    """
    [Requirement: Deshabilitación de 2FA] — protegido por
    Depends(get_current_user) (sesión COMPLETA, ya que get_current_user
    rechaza pending_2fa=true). Siempre 200 (idempotente, ver
    AuthService.disable_totp()).
    """
    await auth_service.disable_totp(current_user.id)
    requests_total.labels(endpoint="/auth/2fa/disable", status="200").inc()
    return {}


# =============================================================================
# account-settings — Perfil extendido, exportación y borrado de cuenta
# =============================================================================


@app.get("/account/profile", response_model=UserProfile, tags=["account"])
async def get_account_profile(
    current_user: CurrentUser = Depends(get_current_user),
    auth_service: AuthService = Depends(_get_auth_service),
) -> UserProfile:
    """[Requirement: Consulta del perfil extendido propio]."""
    requests_total.labels(endpoint="/account/profile", status="200").inc()
    return await auth_service.get_profile(current_user.id)


@app.patch("/account/profile", response_model=UserProfile, tags=["account"])
async def update_account_profile(
    payload: UserProfileUpdate,
    current_user: CurrentUser = Depends(get_current_user),
    auth_service: AuthService = Depends(_get_auth_service),
) -> UserProfile:
    """[Requirement: Edición del perfil extendido propio].

    `payload` es `UserProfileUpdate` — no declara `role`/`email`/
    `password_hash`, así que ningún valor de esos campos puede llegar a
    `AuthService.update_profile()` a través de este endpoint (garantía de
    diseño de tipos, ver src/models/user.py).
    """
    updated = await auth_service.update_profile(current_user.id, payload)
    requests_total.labels(endpoint="/account/profile", status="200").inc()
    return updated


@app.get("/account/export", response_model=AccountExport, tags=["account"])
async def export_account(
    current_user: CurrentUser = Depends(get_current_user),
    auth_service: AuthService = Depends(_get_auth_service),
) -> AccountExport:
    """[Requirement: Exportación de los propios datos de cuenta]."""
    requests_total.labels(endpoint="/account/export", status="200").inc()
    return await auth_service.export_user_data(current_user.id)


@app.delete("/account", tags=["account"])
async def delete_account(
    response: Response,
    current_user: CurrentUser = Depends(get_current_user),
    auth_service: AuthService = Depends(_get_auth_service),
):
    """[Requirement: Eliminación de la propia cuenta].

    Éxito -> borra también la cookie `session` del cliente (equivalente a un
    logout forzado, ya que el usuario ya no existe). 409 si es el único
    superadmin del sistema, sin tocar ninguna fila ni cookie.
    """
    try:
        await auth_service.delete_account(current_user.id)
    except LastSuperadminError:
        requests_total.labels(endpoint="/account", status="409").inc()
        return JSONResponse(
            status_code=status.HTTP_409_CONFLICT,
            content={"error": "no podés eliminar tu cuenta: sos el único superadmin del sistema"},
        )

    response.delete_cookie(SESSION_COOKIE_NAME, samesite="lax", domain=settings.auth_cookie_domain)
    requests_total.labels(endpoint="/account", status="200").inc()
    return {}


# -----------------------------------------------------------------------
# Auth vía Google OAuth (google-oauth) — ver design.md/tasks.md Phase 3.
#
# Convención de redirects (tasks.md 3.12, resuelve la Open Question de
# design.md sobre destino exacto): en éxito, 302 al dashboard (raíz). En
# error (las 4 ramas de 3.6-3.10), 302 a "/login?error=<código-legible>" del
# dashboard, consistente en las 5 ramas (4 de error + 1 de éxito) de este
# bloque. Los códigos de error son valores cortos, estables y legibles por
# el frontend (no mensajes libres), para que dashboard/app/login/page.tsx
# pueda mapearlos a copy localizado sin parsear texto libre.
#
# CRÍTICO: ambos destinos usan settings.dashboard_url (URL ABSOLUTA), NUNCA
# una ruta relativa ("/", "/login"). El navegador resuelve una ruta relativa
# contra el ORIGEN que sirvió el 302 — que es ESTE backend (ej. :8000),
# donde GET / devuelve el JSON de info de la API, no el dashboard de
# Next.js (otro origen, ej. :3008). Bug real detectado en verificación
# manual con consentimiento real de Google: sin esto, el usuario terminaba
# viendo la respuesta de la API en vez de su sesión en el dashboard.
# -----------------------------------------------------------------------

_GOOGLE_LOGIN_ERROR_REDIRECT = "{dashboard_url}/login?error={code}"


def _google_error_redirect(code: str) -> RedirectResponse:
    return RedirectResponse(
        url=_GOOGLE_LOGIN_ERROR_REDIRECT.format(dashboard_url=settings.dashboard_url, code=code),
        status_code=status.HTTP_302_FOUND,
    )


@app.get("/auth/google/login", tags=["auth"])
async def google_login(request: Request):
    """
    Inicia el flujo OAuth 2.0 Authorization Code con Google — redirige al
    navegador al endpoint de autorización de Google con `client_id`,
    `redirect_uri`, `scope` y un `state` generado y persistido por Authlib
    (cookie `oauth_state`, ver SessionMiddleware arriba) —
    [Requirement: Endpoints OAuth de Google / Scenario: GET
    /auth/google/login redirige a Google con los parámetros correctos].

    503 si Google OAuth no está configurado (design.md Decision 1) — no es
    un fail-fast de arranque, es una condición de runtime consultada acá.
    """
    if not request.app.state.google_oauth_enabled:
        requests_total.labels(endpoint="/auth/google/login", status="503").inc()
        return JSONResponse(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            content={"error": "Google OAuth not configured"},
        )

    requests_total.labels(endpoint="/auth/google/login", status="302").inc()
    return await oauth.google.authorize_redirect(request, settings.google_redirect_uri)


@app.get("/auth/google/callback", tags=["auth"])
async def google_callback(
    request: Request,
    response: Response,
    code: Optional[str] = Query(None),
    state: Optional[str] = Query(None),
    error: Optional[str] = Query(None),
    auth_service: AuthService = Depends(_get_auth_service),
):
    """
    Callback de Google tras el consentimiento del usuario. Resuelve/crea el
    usuario y emite la MISMA cookie `session` httpOnly que `/auth/login`
    (reutilización estricta de `AuthService.create_access_token()` — ver
    design.md Decision 5). En cualquier rama de error: redirect a
    `/login?error=<código>`, sin `Set-Cookie`, sin tocar `users`, nunca 500
    — [Requirement: Manejo de errores del flujo OAuth de Google].

    503 si Google OAuth no está configurado (mismo criterio que
    /auth/google/login).
    """
    if not request.app.state.google_oauth_enabled:
        requests_total.labels(endpoint="/auth/google/callback", status="503").inc()
        return JSONResponse(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            content={"error": "Google OAuth not configured"},
        )

    # (3.6) Usuario canceló el consentimiento: Google redirige sin `code`.
    if error is not None:
        # (3.7) Google devuelve un parámetro de error explícito
        # (access_denied u otro) — mismo tratamiento que "sin code".
        requests_total.labels(endpoint="/auth/google/callback", status="302").inc()
        return _google_error_redirect("google_oauth_" + error)

    if code is None:
        requests_total.labels(endpoint="/auth/google/callback", status="302").inc()
        return _google_error_redirect("google_oauth_cancelled")

    # (3.8) Intercambio code -> token contra Google. Authlib valida el
    # `state` internamente (compara contra la cookie "oauth_state" seteada
    # por authorize_redirect) y levanta MismatchingStateError si no
    # coincide (state ausente/reutilizado/manipulado) — no se reimplementa
    # esa comparación a mano (design.md Decision 2). OAuthError es la clase
    # base de Authlib para MismatchingStateError y para cualquier otro
    # fallo del intercambio código->token (timeout, código expirado,
    # client_id/client_secret inválidos) — se captura acá para nunca dejar
    # escapar un 500 no controlado.
    try:
        token = await oauth.google.authorize_access_token(request)
    except OAuthError:
        requests_total.labels(endpoint="/auth/google/callback", status="302").inc()
        return _google_error_redirect("google_oauth_token_exchange_failed")

    # (3.9) La validación de firma/claims (iss, aud, exp) del ID token la
    # hace Authlib internamente al parsear `token["userinfo"]`, contra las
    # JWKS publicadas por Google (server_metadata_url de oauth.register) —
    # no se reimplementa acá. Si esa validación falla, Authlib levanta una
    # excepción (subclase de OAuthError o, en casos de JWT malformado, un
    # error de la librería jose subyacente) antes de que el flujo llegue a
    # esta línea; el try/except de arriba ya cubre authorize_access_token,
    # que es donde ocurre el parseo+validación del ID token.
    userinfo = token.get("userinfo")
    if userinfo is None:
        requests_total.labels(endpoint="/auth/google/callback", status="302").inc()
        return _google_error_redirect("google_oauth_invalid_id_token")

    # (3.10) email_verified vive en el endpoint, NO en AuthService
    # (design.md Decision 4) — AuthService.resolve_or_create_google_user()
    # no conoce el concepto de "email_verified", es un claim específico de
    # OpenID Connect/Google, no un concepto genérico de "usuario".
    if not userinfo.get("email_verified"):
        requests_total.labels(endpoint="/auth/google/callback", status="302").inc()
        return _google_error_redirect("google_oauth_email_not_verified")

    # (3.11) Resolución/creación de usuario + emisión de la MISMA cookie
    # "session" que usa /auth/login (mismo create_access_token(), mismos
    # atributos de cookie).
    #
    # name/picture (extensión google-oauth, migración 004): claims estándar
    # OpenID Connect que Google entrega dado el scope "openid email profile"
    # (ver oauth.register() en lifespan()). A diferencia de sub/email/
    # email_verified, son OPCIONALES en el ID token — .get() con default None,
    # nunca deben bloquear el login si Google no los envía por algún motivo.
    try:
        user = await auth_service.resolve_or_create_google_user(
            google_id=userinfo["sub"],
            email=userinfo["email"],
            name=userinfo.get("name"),
            avatar_url=userinfo.get("picture"),
        )
    except InvitationRequiredError:
        # Cierre invitation-only (email-invitations, Decision 5): una cuenta
        # de Google sin usuario existente NI invitación vigente NO entra.
        # Antes de este gate, cualquier cuenta de Google se auto-provisionaba
        # como viewer — incidente real reportado el 2026-08-06.
        requests_total.labels(endpoint="/auth/google/callback", status="302").inc()
        return _google_error_redirect("google_no_invitation")
    except AccountDeactivatedError:
        # (user-management, tarea 1.12, Decision 5) La cuenta existe pero está
        # desactivada. El servicio levanta la excepción ANTES de cualquier
        # UPDATE, así que ni el refresco de name/avatar ni el auto-link de
        # google_id llegan a ocurrir. Código sin prefijo `google_` a propósito:
        # la causa no es del flujo de Google sino de la cuenta, y el frontend
        # reusa el MISMO código para el 403 del login por password.
        requests_total.labels(endpoint="/auth/google/callback", status="302").inc()
        return _google_error_redirect("account_deactivated")

    access_token = auth_service.create_access_token(user)

    redirect = RedirectResponse(url=settings.dashboard_url, status_code=status.HTTP_302_FOUND)
    redirect.set_cookie(
        SESSION_COOKIE_NAME,
        access_token,
        httponly=True,
        secure=True,
        samesite="lax",
        max_age=settings.auth_token_expire_minutes * 60,
        domain=settings.auth_cookie_domain,
    )

    requests_total.labels(endpoint="/auth/google/callback", status="302").inc()
    return redirect


# =============================================================================
# Spectrograms — WebSocket en vivo (SeedLink -> Redis -> aquí)
# =============================================================================

# Ventana para considerar un canal "transmitiendo": el ingestor escribe una
# columna cada ~8s por canal, así que 10 minutos tolera cortes breves de la
# estación sin ofrecer como Vivo algo que lleva horas muerto.
LIVE_FRESHNESS_MINUTES = 10


@app.websocket("/ws/spectrogram/{channel}")
async def ws_spectrogram(websocket: WebSocket, channel: str) -> None:
    """
    Streaming en vivo de columnas de espectrograma para un canal SEED
    (ej. "IU.MAJO.00.BHZ"). Las columnas las produce src/services/seedlink_ingestor.py
    (proceso separado) y las publica en Redis; acá solo hacemos fan-out a
    los navegadores conectados. Requiere que el ingestor esté corriendo.
    """
    await websocket.accept()
    logger.info("WebSocket conectado: /ws/spectrogram/%s", channel)
    try:
        async for column in event_bus.subscribe(f"spec:{channel}"):
            await websocket.send_json(column)
    except WebSocketDisconnect:
        logger.info("WebSocket desconectado: /ws/spectrogram/%s", channel)
    except Exception:
        logger.warning("WebSocket error en /ws/spectrogram/%s", channel, exc_info=True)


@app.get("/spectrograms/live-channels", tags=["spectrograms"])
async def get_live_channels() -> list[dict]:
    """
    Ciudades con streaming en vivo disponible (SeedLink), con su canal SEED
    completo. El frontend usa esto para decidir en qué tarjetas mostrar el
    toggle Vivo/24h — solo aparece donde hay cobertura real.

    El catálogo estático dice qué canales están suscriptos; que un canal
    produzca datos es otra cosa (estación caída, ingestor muerto). Por eso
    se filtra contra las columnas frescas de TimescaleDB. Sin base (local
    sin TIMESCALEDB_HOST, o consulta fallida) se devuelve el catálogo
    completo: mejor ofrecer de más que esconder canales vivos.
    """
    active: Optional[set] = None
    if column_writer is not None:
        try:
            active = set(await column_writer.fetch_active_channels(LIVE_FRESHNESS_MINUTES))
        except Exception:
            logger.warning(
                "live-channels: fallo consultando canales activos, "
                "se devuelve el catálogo completo",
                exc_info=True,
            )
    return resolve_live_catalog(LIVE_CANDIDATES_BY_CITY, active)


@app.get("/spectrograms/{channel}/history", tags=["spectrograms"])
async def get_spectrogram_history(
    channel: str,
    minutes: int = Query(5, description="Minutos de historial a recuperar", ge=1, le=1440),
) -> dict:
    """
    Historial persistido de columnas de espectrograma para un canal SEED
    (ej. "IU.MAJO.00.BHZ"), para pintar el canvas antes de conectar el
    WebSocket en vivo. Requiere TimescaleDB configurado y el ingestor
    corriendo con column_writer activo.
    """
    if column_writer is None:
        return {"channel": channel, "columns": [], "error": "TimescaleDB no configurado"}

    columns = await column_writer.fetch_history(channel, minutes)
    return {"channel": channel, "columns": columns}


# =============================================================================
# Spectrograms
# =============================================================================


@app.get("/spectrograms/{city_id}", tags=["spectrograms"])
async def get_spectrogram(
    city_id: str,
    latitude: float = Query(..., description="Latitud de la ciudad"),
    longitude: float = Query(..., description="Longitud de la ciudad"),
    network: Optional[str] = Query(None, description="Código de red FDSN preferido"),
    duration_hours: int = Query(24, description="Duración en horas", ge=1, le=168),
) -> dict:
    """
    Generar espectrograma para una ubicación específica.
    """
    with request_duration.labels(endpoint=f"/spectrograms/{city_id}").time():
        ttl = settings.spectrogram_cache_ttl_seconds
        cache_key = f"spectrogram:{city_id}:{duration_hours}"

        if ttl > 0:
            cached = cache.get(cache_key)
            if cached is not None:
                requests_total.labels(endpoint="/spectrograms", status="200").inc()
                return cached

        logger.info("Generating spectrogram for %s at (%s, %s)", city_id, latitude, longitude)

        spectrogram_service = get_spectrogram_service()

        result = await spectrogram_service.generate_spectrogram_for_location(
            latitude=latitude,
            longitude=longitude,
            network_code=network,
            duration_hours=duration_hours,
            city_id=city_id,
        )

        if result["success"]:
            requests_total.labels(endpoint="/spectrograms", status="200").inc()
            logger.info("Spectrogram generated for %s", city_id)
            if ttl > 0:
                cache.set(cache_key, result, ttl)
        else:
            requests_total.labels(endpoint="/spectrograms", status="500").inc()
            logger.warning(
                "Failed to generate spectrogram for %s: %s",
                city_id,
                result.get("error"),
            )

        return result


@app.get("/events/{event_id}/detail", tags=["advanced"])
async def get_event_detail(event_id: str) -> dict:
    """
    Obtener detalles completos de un evento por su ID.
    """
    with request_duration.labels(endpoint="/events/detail").time():
        logger.info("Fetching detailed event information for %s", event_id)

        # El id público del catálogo lleva prefijo de fuente (ver emsc_service.py:
        # id=f"emsc_{eventid}"); la API de EMSC solo conoce el eventid crudo.
        raw_event_id = event_id.removeprefix("emsc_")
        event_detail = await EMSCDetailService.get_event_with_rupture(raw_event_id)

        if event_detail:
            requests_total.labels(endpoint="/events/detail", status="200").inc()
            logger.info("Event %s retrieved successfully", event_id)

            if event_detail.get("rupture_model"):
                logger.info("Rupture model available for %s", event_id)

            return event_detail
        else:
            requests_total.labels(endpoint="/events/detail", status="404").inc()
            logger.warning("Event %s not found", event_id)

            return JSONResponse(status_code=404, content={"error": f"Event {event_id} not found"})


@app.get("/events/{event_id}/rupture", tags=["advanced"])
async def get_rupture_model(event_id: str) -> dict:
    """
    Obtener modelo de ruptura de falla finita para un evento específico.
    """
    with request_duration.labels(endpoint="/events/rupture").time():
        logger.info("Fetching rupture model for %s", event_id)

        raw_event_id = event_id.removeprefix("emsc_")
        rupture_model = await EMSCDetailService.get_rupture_model(raw_event_id)

        if rupture_model:
            requests_total.labels(endpoint="/events/rupture", status="200").inc()
            logger.info("Rupture model found for %s", event_id)
            return rupture_model
        else:
            requests_total.labels(endpoint="/events/rupture", status="404").inc()
            logger.warning("No rupture model available for %s", event_id)

            return JSONResponse(
                status_code=404,
                content={
                    "error": f"No rupture model available for event {event_id}",
                    "note": "Rupture models are only available for significant earthquakes with published finite fault solutions.",
                },
            )


# =============================================================================
# Debug endpoints (solo cuando settings.debug == True)
# =============================================================================

if getattr(settings, "debug", False):

    @app.get("/__debug/raise", tags=["debug"])
    async def debug_raise() -> None:
        """Lanza una excepción para testear la integración con Sentry/GlitchTip."""
        raise ValueError("Intentional test exception from /__debug/raise")


# =============================================================================
# Root endpoint
# =============================================================================


@app.get("/", tags=["info"])
async def root() -> dict:
    """
    Información básica del servicio.
    """
    return {
        "service": "GeoSpectrum",
        "version": "1.0.0",
        "status": "operational",
        "docs": "/docs",
        "health": "/health",
        "metrics": "/metrics",
        "endpoints": {
            "report": "/report",
            "events": "/events",
            "events_search": "/events/search",
            "event_detail": "/events/{event_id}/detail",
            "rupture_model": "/events/{event_id}/rupture",
            "alerts": "/alerts",
            "spectrograms": "/spectrograms/{city_id}",
        },
    }


# =============================================================================
# Entry point
# =============================================================================

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "src.main:app",
        host=settings.api_host,
        port=settings.api_port,
        log_level=settings.log_level.lower(),
        reload=False,
    )

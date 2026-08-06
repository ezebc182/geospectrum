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
from typing import AsyncIterator, Optional, List
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
from src.models.beta import BetaSignupRequest
from src.models.event import MonitorReport, SeismicEvent, Alert
from src.models.user import (
    AccountExport,
    CurrentUser,
    TotpSetupResponse,
    TotpVerifyRequest,
    UserCreate,
    UserProfile,
    UserProfileUpdate,
    UserPublic,
)
from src.services.usgs_service import fetch_usgs_events
from src.services.inpres_service import fetch_inpres_events
from src.services.emsc_service import fetch_emsc_events
from src.services.emsc_detail_service import EMSCDetailService
from src.services.merge_service import merge_all_sources
from src.services.report_service import build_report, count_by_source, CANONICAL_SOURCES
from src.services.spectrogram_service import get_spectrogram_service, LIVE_CHANNELS_BY_CITY
from src.services.event_bus import RedisPubSubBus
from src.services.timescale_service import TimescaleColumnWriter
from src.services.auth_service import (
    AuthService,
    EmailAlreadyRegisteredError,
    InvalidTokenError,
    InvalidTotpCodeError,
    LastSuperadminError,
    Login2FAAttemptLimiter,
    TokenExpiredError,
    TooManyTotpAttemptsError,
    TotpAlreadyEnabledError,
    TotpNotAvailableForGoogleOnlyUserError,
)
from src.api.deps import (
    SESSION_COOKIE_NAME,
    get_current_user,
    get_current_user_optional,
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
    logger.info("Min magnitude: %s", settings.min_mag_alert)
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
        logger.info("TimescaleDB no configurado (TIMESCALEDB_HOST vacío) — sin historial persistido")

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

    async def _cached_fetch(source: str, fetcher, window: int):
        key = f"{source}:{window}"
        if ttl > 0:
            hit = cache.get(key)
            if hit is not None:
                return hit
        result = await fetcher(window)
        if ttl > 0:
            cache.set(key, result, ttl)
        return result

    tasks = []
    fetch_map: list[str] = []

    if "usgs" in sources:
        tasks.append(_cached_fetch("usgs", fetch_usgs_events, time_window))
        fetch_map.append("usgs")
    if "emsc" in sources:
        tasks.append(_cached_fetch("emsc", fetch_emsc_events, time_window))
        fetch_map.append("emsc")
    if "inpres" in sources:
        tasks.append(_cached_fetch("inpres", fetch_inpres_events, time_window))
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
    await pool.execute(
        "INSERT INTO beta_signups (email) VALUES ($1) ON CONFLICT (email) DO NOTHING",
        email,
    )

    requests_total.labels(endpoint="/beta-signups", status="201").inc()
    return {"ok": True}


@app.get("/events/search", response_model=list[SeismicEvent], tags=["monitoring"])
async def search_events(
    sources: Optional[str] = Query(None, description="Fuentes separadas por coma: usgs,emsc,inpres"),
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

        usgs_events, emsc_events, inpres_events, errors = await _fetch_parallel(
            time_window, source_list
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
            len(filtered), len(merged), source_list,
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


@app.post("/auth/register", response_model=UserPublic, status_code=status.HTTP_201_CREATED, tags=["auth"])
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
            email=payload.email, password=payload.password, role=payload.role
        )
    except EmailAlreadyRegisteredError:
        return JSONResponse(
            status_code=status.HTTP_409_CONFLICT,
            content={"error": "email already registered"},
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
                "para user_id=%s (Redis no disponible?)", user.id, exc_info=True,
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
    response.delete_cookie(
        SESSION_COOKIE_NAME, samesite="lax", domain=settings.auth_cookie_domain
    )
    requests_total.labels(endpoint="/auth/logout", status="204").inc()


@app.get("/auth/me", response_model=CurrentUser, tags=["auth"])
async def get_me(current_user: CurrentUser = Depends(get_current_user)) -> CurrentUser:
    """
    Perfil del usuario autenticado. Protegido con Depends(get_current_user)
    — [Requirement: Perfil del usuario autenticado].
    """
    requests_total.labels(endpoint="/auth/me", status="200").inc()
    return current_user


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
            user_id, exc_info=True,
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
                "para user_id=%s (Redis no disponible?)", user_id, exc_info=True,
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
            user_id, exc_info=True,
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
            content={
                "error": "no podés eliminar tu cuenta: sos el único superadmin del sistema"
            },
        )

    response.delete_cookie(
        SESSION_COOKIE_NAME, samesite="lax", domain=settings.auth_cookie_domain
    )
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
    user = await auth_service.resolve_or_create_google_user(
        google_id=userinfo["sub"],
        email=userinfo["email"],
        name=userinfo.get("name"),
        avatar_url=userinfo.get("picture"),
    )
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
    """
    return [{"city_id": city_id, "channel": channel} for city_id, channel in LIVE_CHANNELS_BY_CITY.items()]


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
    duration_hours: int = Query(24, description="Duración en horas", ge=1, le=168)
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
                city_id, result.get("error"),
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

            return JSONResponse(
                status_code=404,
                content={"error": f"Event {event_id} not found"}
            )


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
                    "note": "Rupture models are only available for significant earthquakes with published finite fault solutions."
                }
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

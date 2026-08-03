"""
Dependencias de FastAPI para autenticación y autorización.

get_current_user y require_role() son Depends() reusables — no un middleware
global (ver openspec/changes/multi-user-auth/design.md: la protección se
aplica endpoint por endpoint, deliberadamente, para no afectar la superficie
existente de src/main.py). Ningún endpoint existente usa estas dependencias
en este change; quedan listas para /auth/me (Fase 3, fuera de este batch) y
para endpoints futuros (regiones, dashboards personalizados).

Resolución de AuthService: vía request.app.state.auth_service, seteado en
el lifespan() de main.py (Fase 3) siguiendo el mismo lugar donde hoy vive
la instancia module-level de column_writer/event_bus — a diferencia de esos
dos, AuthService no puede tener un `Optional`/best-effort en tiempo de
request: si app.state.auth_service no existe, es un error de configuración
del servidor, no una condición de sesión inválida del cliente (se levanta
tal cual, no se atrapa como 401/403).
"""
from __future__ import annotations

from typing import Optional

from fastapi import Depends, HTTPException, Request, status

from src.models.user import CurrentUser, UserRole, role_level
from src.services.auth_service import (
    AuthService,
    InvalidTokenError,
    TokenExpiredError,
)

SESSION_COOKIE_NAME = "session"


def _get_auth_service(request: Request) -> AuthService:
    return request.app.state.auth_service


async def get_current_user(
    request: Request,
    auth_service: AuthService = Depends(_get_auth_service),
) -> CurrentUser:
    """Resuelve el usuario autenticado a partir de la cookie `session`.

    Cubre [Requirement: Perfil del usuario autenticado / Scenario: Usuario
    no autenticado recibe 401] y [Scenario: Cookie con JWT corrupto o con
    firma inválida recibe 401] — en ambos casos (y en el de expiración) el
    resultado público es 401, nunca una excepción no controlada (500).

    [Tarea 3.1, account-settings, design.md Decision 1] Defensa en
    profundidad: ANTES de construir el `CurrentUser`, se decodifica el
    payload crudo (`decode_token_payload()`, que no exige el shape completo
    de sesión) y se rechaza explícitamente con 401 cualquier token con
    `pending_2fa=true` — un JWT de pre-auth (emitido por `POST /auth/login`
    cuando `totp_enabled=true`, ver Phase 3) JAMÁS debe resolver una
    identidad completa, incluso si (por bug o manipulación del cliente)
    terminara en la cookie `session` en lugar de `pending_2fa_session`.
    """
    token = request.cookies.get(SESSION_COOKIE_NAME)
    if token is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="not authenticated",
        )

    try:
        payload = auth_service.decode_token_payload(token)
    except (InvalidTokenError, TokenExpiredError) as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="not authenticated",
        ) from exc

    if payload.get("pending_2fa") is True:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="not authenticated",
        )

    try:
        return auth_service.decode_access_token(token)
    except (InvalidTokenError, TokenExpiredError) as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="not authenticated",
        ) from exc


async def get_current_user_optional(request: Request) -> Optional[CurrentUser]:
    """Igual que get_current_user(), pero devuelve None en vez de rechazar.

    Para endpoints PÚBLICOS que personalizan su respuesta cuando hay sesión y
    siguen funcionando cuando no la hay — hoy /report, que resuelve el área de
    interés activa del usuario y cae al preset por defecto para anónimos. Sin
    esto, personalizar /report obligaría a volverlo privado (401), rompiendo
    scripts/seismic-cli.py y el consumo anónimo del dashboard.

    DELIBERADAMENTE delega en get_current_user() en lugar de reimplementar la
    validación: la verificación de firma, expiración y el rechazo de tokens
    `pending_2fa` viven en UN solo lugar. Una copia paralela sería un agujero
    de seguridad esperando a que las dos versiones diverjan — exactamente el
    tipo de bug que nadie nota hasta que un JWT de pre-auth entra por acá.

    NO declara `auth_service` como Depends(_get_auth_service), a diferencia de
    get_current_user(): un Depends se resuelve ANTES de entrar al cuerpo, así
    que si app.state.auth_service no existe el AttributeError escapa por
    afuera de cualquier try/except de acá y el endpoint devuelve 500. Eso
    convertiría a un endpoint público y robusto en uno que explota — lo
    detectaron tests/integration/test_api.py::test_report_* cuando /report
    pasó a usar esta dependencia. Sin cookie no hace falta ningún service, y
    ese es justamente el caso del anónimo: se resuelve adentro y sólo cuando
    hay algo que validar.

    Sólo se traga el 401 (sesión ausente/inválida/pre-auth): cualquier otro
    error se propaga. Un fallo de configuración del servidor NO debe
    disfrazarse silenciosamente de "usuario anónimo".
    """
    if request.cookies.get(SESSION_COOKIE_NAME) is None:
        return None

    try:
        auth_service = _get_auth_service(request)
        return await get_current_user(request, auth_service)
    except HTTPException as exc:
        if exc.status_code == status.HTTP_401_UNAUTHORIZED:
            return None
        raise


def require_role(role: UserRole):
    """Factory de dependencia: exige sesión válida Y rol EXACTO (igualdad).

    Usar cuando un endpoint necesita ese rol específico y ningún otro (ni
    siquiera uno de nivel superior en la jerarquía) — caso de uso acotado.
    Para "este rol o cualquiera por encima en la jerarquía" usar
    require_min_role() en su lugar (ver design.md Decision 6).

    Cubre [Requirement: Roles jerárquicos / Scenario: require_role permite
    el acceso cuando el rol coincide exactamente], [Scenario: require_role
    rechaza con 403 cuando el rol no coincide exactamente] (incluye el caso
    de un rol de nivel superior, que tampoco matchea por igualdad) y
    [Scenario: require_role rechaza con 401 cuando no hay sesión] (la falta
    de autenticación se resuelve antes que la de autorización, porque
    get_current_user ya corrió como Depends antes de este chequeo).
    """

    async def _require_role(
        current_user: CurrentUser = Depends(get_current_user),
    ) -> CurrentUser:
        if current_user.role != role:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="insufficient role",
            )
        return current_user

    return _require_role


def require_min_role(role: UserRole):
    """Factory de dependencia: exige sesión válida Y rol de nivel >= al mínimo.

    A diferencia de require_role() (igualdad exacta), esta compara NIVEL
    jerárquico (ver src/models/user.py ROLE_LEVEL/role_level()): acepta el
    rol pedido o cualquier rol de nivel superior. Es el mecanismo pensado
    para endpoints futuros de gestión de usuarios y de las iniciativas
    dependientes (regiones, dashboards personalizados) — ej.
    require_min_role(UserRole.MODERADOR) deja pasar a moderador, admin y
    superadmin, pero no a viewer.

    Cubre [Requirement: Roles jerárquicos / Scenario: require_min_role
    permite el acceso cuando el rol coincide con el mínimo], [Scenario:
    require_min_role permite el acceso cuando el rol es de nivel superior
    al mínimo], [Scenario: require_min_role rechaza con 403 cuando el rol
    es de nivel inferior al mínimo] y [Scenario: require_min_role rechaza
    con 401 cuando no hay sesión].
    """

    async def _require_min_role(
        current_user: CurrentUser = Depends(get_current_user),
    ) -> CurrentUser:
        if role_level(current_user.role) < role_level(role):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="insufficient role",
            )
        return current_user

    return _require_min_role

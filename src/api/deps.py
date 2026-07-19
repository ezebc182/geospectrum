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

from fastapi import Depends, HTTPException, Request, status

from src.models.user import CurrentUser, UserRole
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
    """
    token = request.cookies.get(SESSION_COOKIE_NAME)
    if token is None:
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


def require_role(role: UserRole):
    """Factory de dependencia: exige sesión válida Y rol exacto.

    Cubre los 3 escenarios de [Requirement: Roles admin y viewer]: permite
    si el rol coincide, 403 si no coincide, 401 si no hay sesión (la falta
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

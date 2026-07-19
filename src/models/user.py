"""
Modelos de datos para autenticación multi-usuario con roles.
"""
from enum import Enum
from uuid import UUID

from pydantic import BaseModel, EmailStr, Field


class UserRole(str, Enum):
    """Roles soportados, con jerarquía estricta descendente (ver
    openspec/changes/multi-user-auth/design.md, Decision 6).

    Se mantiene `str, Enum` (NO `IntEnum`) a propósito: el valor de este
    enum ya es un contrato de API/JWT/DB (se serializa como el string
    "superadmin", no como un número). La noción de "nivel jerárquico" vive
    aparte en ROLE_LEVEL/role_level(), para no acoplar serialización externa
    con lógica interna de comparación.
    """

    SUPERADMIN = "superadmin"
    ADMIN = "admin"
    MODERADOR = "moderador"
    VIEWER = "viewer"


# Nivel de cada rol en la jerarquía estricta descendente: un usuario de
# nivel N solo puede gestionar (crear/asignar rol a) usuarios de nivel
# ESTRICTAMENTE menor que N. Nadie gestiona su propio nivel ni uno igual o
# superior.
ROLE_LEVEL: dict[UserRole, int] = {
    UserRole.SUPERADMIN: 3,
    UserRole.ADMIN: 2,
    UserRole.MODERADOR: 1,
    UserRole.VIEWER: 0,
}


def role_level(role: UserRole) -> int:
    """Nivel numérico de un rol, para comparación jerárquica (require_min_role)."""

    return ROLE_LEVEL[role]


class UserCreate(BaseModel):
    """Payload de POST /auth/register.

    NOTA (design.md Decision 6): `role` se acepta en el shape del payload
    por compatibilidad (no rechaza el campo con 422 si el cliente lo manda),
    pero el endpoint `POST /auth/register` lo IGNORA deliberadamente — el
    rol real persistido lo determina server-side la regla de bootstrap
    (tabla `users` vacía -> superadmin; no vacía -> viewer), nunca el valor
    pedido por un caller no autenticado. Ver AuthService.create_user().
    """

    email: EmailStr
    # min_length=8: [Requirement: Registro de usuario / Scenario: Registro
    # rechazado por password que no cumple la política mínima] — 422 si
    # len(password) < 8, aplicado automáticamente por Pydantic.
    password: str = Field(..., min_length=8)
    role: UserRole = UserRole.VIEWER


class UserPublic(BaseModel):
    """Representación de usuario segura para exponer en responses (sin hash)."""

    id: UUID
    email: EmailStr
    role: UserRole


class UserInDB(BaseModel):
    """Representación interna de usuario, incluye el hash de password."""

    id: UUID
    email: EmailStr
    password_hash: str
    role: UserRole


class CurrentUser(BaseModel):
    """Usuario autenticado resuelto por Depends(get_current_user)."""

    id: UUID
    email: EmailStr
    role: UserRole

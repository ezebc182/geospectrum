"""
Modelos de datos para autenticación multi-usuario con roles.
"""
from enum import Enum
from uuid import UUID

from pydantic import BaseModel, EmailStr, Field


class UserRole(str, Enum):
    """Roles soportados. Mínimo viable: admin y viewer (ver proposal.md)."""

    ADMIN = "admin"
    VIEWER = "viewer"


class UserCreate(BaseModel):
    """Payload de POST /auth/register."""

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

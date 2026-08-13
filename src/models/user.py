"""
Modelos de datos para autenticación multi-usuario con roles.
"""

from datetime import datetime
from enum import Enum
from typing import Literal, Optional
from uuid import UUID

from pydantic import BaseModel, EmailStr, Field

# Idioma de UI soportado ('es' | 'en'), compartido por users.locale (migración
# 011), invitations.locale (010) y beta_signups.locale (011). Vive ACÁ y no en
# invitation.py porque invitation.py ya importa UserRole de este módulo:
# importar en la dirección inversa armaría un ciclo de imports (el design de
# i18n-dashboard asumía "sin ciclos" y ese supuesto era falso). invitation.py
# lo re-exporta como InvitationLocale para sus consumidores existentes.
Locale = Literal["es", "en"]


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
    # Registro invitation-only (email-invitations): token del link de
    # invitación. Opcional en el shape — el PRIMER usuario del sistema
    # (bootstrap) registra sin token; todos los demás lo necesitan o
    # create_user() rechaza con InvitationRequiredError (403).
    invitation_token: Optional[str] = None


class UserPublic(BaseModel):
    """Representación de usuario segura para exponer en responses (sin hash)."""

    id: UUID
    email: EmailStr
    role: UserRole
    # google_id: Optional (ver openspec/changes/google-oauth/design.md) —
    # None si el usuario nunca vinculó una cuenta de Google (solo password).
    google_id: Optional[str] = None
    # name/avatar_url: Optional (migración 004, extensión de google-oauth).
    # Solo se completan para usuarios que se loguearon vía Google (claims
    # OpenID Connect `name`/`picture`); un usuario exclusivamente de password
    # los tiene en None a propósito — el frontend resuelve un fallback de
    # iniciales derivadas del email cuando avatar_url es None.
    name: Optional[str] = None
    avatar_url: Optional[str] = None


class UserInDB(BaseModel):
    """Representación interna de usuario, incluye el hash de password."""

    id: UUID
    email: EmailStr
    # Optional (ver openspec/changes/google-oauth/design.md, migración 003):
    # un usuario que se registró exclusivamente vía Google no tiene password.
    # AuthService.verify_password() tiene un guard explícito para None — ver
    # verify_password() abajo.
    password_hash: Optional[str] = None
    role: UserRole
    # None si el usuario nunca vinculó una cuenta de Google (solo password).
    google_id: Optional[str] = None
    # Ver UserPublic.name/avatar_url arriba (migración 004).
    name: Optional[str] = None
    avatar_url: Optional[str] = None
    # totp_enabled (migración 005, account-settings): default False para
    # usuarios pre-existentes a la migración — get_user_by_email() siempre
    # lo trae explícito desde `users` (columna NOT NULL DEFAULT false), pero
    # el default acá evita romper cualquier construcción manual de UserInDB
    # en tests que no lo especifiquen (mismo criterio que name/avatar_url).
    totp_enabled: bool = False
    # deactivated_at (migración 012, user-management): None = cuenta ACTIVA.
    # Lo lee el guard de POST /auth/login para rechazar con 403 a una cuenta
    # desactivada DESPUÉS de verificar la password. Default None con el mismo
    # criterio que totp_enabled: get_user_by_email()/get_user_by_id() siempre
    # lo traen explícito del SELECT, pero el default evita romper las
    # construcciones manuales de UserInDB que hacen los tests.
    deactivated_at: Optional[datetime] = None


class UserListItem(BaseModel):
    """Item de `GET /auth/users` (user-management, design.md Decision 9).

    Tipo DEDICADO, no una extensión de `UserPublic`. Dos razones:

    1. `UserPublic` se usa en los responses de login/registro: agregarle
       `deactivated_at`/`created_at` contaminaría el contrato de auth con
       campos que sólo le importan a la pantalla de administración.
    2. `password_hash` y `totp_secret` son INEXPRESABLES por construcción del
       tipo — no hay forma de que un cambio futuro en la query los filtre
       "sin querer" al response. Mismo argumento con el que el proyecto
       separó `InvitationPublic` de los tokens en claro.

    `has_google`/`has_password` son booleanos DERIVADOS en la query
    (`google_id IS NOT NULL`, `password_hash IS NOT NULL`) en vez del
    `google_id` crudo: el admin necesita saber CÓMO entra la persona (para
    entender qué le bloquea la desactivación), no el identificador de Google.
    Menos superficie expuesta, misma utilidad.

    `deactivated_at`: None = cuenta activa (ver migración 012).
    """

    id: UUID
    email: EmailStr
    role: UserRole
    name: Optional[str] = None
    avatar_url: Optional[str] = None
    has_google: bool
    has_password: bool
    created_at: datetime
    deactivated_at: Optional[datetime] = None


class CurrentUser(BaseModel):
    """Usuario autenticado resuelto por Depends(get_current_user)."""

    id: UUID
    email: EmailStr
    role: UserRole
    # Ver UserPublic.name/avatar_url arriba (migración 004) — el JWT emitido
    # por AuthService.create_access_token() incluye estos claims para que
    # get_current_user() no dependa de un round-trip extra a Postgres.
    name: Optional[str] = None
    avatar_url: Optional[str] = None


class MeResponse(CurrentUser):
    """Response model de GET /auth/me (email-invitations, Decision 6).

    Hereda el shape ACTUAL de /auth/me (CurrentUser, resuelto del JWT) y le
    suma `onboarding_completed_at`, que se lee de la BASE en cada request —
    NUNCA del JWT: es un dato mutable (el usuario completa el wizard y debe
    apagarse al instante) y un claim quedaría stale hasta el re-login. None
    significa "onboarding pendiente": el frontend monta el wizard.
    """

    onboarding_completed_at: Optional[datetime] = None


# --- account-settings (migración 005) --------------------------------------
#
# NOTA de nomenclatura (Decisión Cerrada, ver design.md Decision 2 y
# tasks.md header): `full_name` (este bloque, editable por el usuario, vive
# SOLO en /account/profile) y `name` (arriba, poblado exclusivamente por
# Google OAuth, migración 004, expuesto en /auth/me/JWT/header/avatar) se
# mantienen DELIBERADAMENTE separados. Ninguno de los modelos de abajo debe
# mezclarse ni sobreescribirse con `UserPublic`/`CurrentUser`/`UserInDB`
# (Decisión Cerrada #4 del proposal: el perfil extendido vive fuera del JWT).


class UserProfile(BaseModel):
    """Perfil extendido del usuario, expuesto SOLO vía GET /account/profile.

    Todos los campos son opcionales (Decisión Cerrada #4 del proposal): un
    usuario puede completar solo alguno de ellos, dejar el resto en blanco,
    o no completar ninguno. Nunca aparece en /auth/me ni en los claims del
    JWT — ver Requirement: Aislamiento del perfil extendido respecto de
    /auth/me y del JWT (specs/account-settings/spec.md).

    `totp_enabled` (fix puntual post-Phase 4, fuera del flujo de fases SDD):
    único booleano de estado de seguridad expuesto acá — NUNCA `totp_secret`.
    Se agrega porque ningún endpoint liviano exponía el estado de 2FA y el
    frontend terminaba llamando a GET /account/export (pensado para exportar
    TODOS los datos de la cuenta) solo para leer ese flag. `CurrentUser`/
    `UserPublic` (sesión/auth) siguen sin tocarse — Decisión Cerrada #4 vigente.

    `locale` (i18n-dashboard, migración 011): preferencia de idioma persistida.
    None = "nunca eligió" — la UI resuelve por el resto de la cascada (cookie,
    Accept-Language, default 'es'). NUNCA viaja en el JWT ni en /auth/me
    (mismo aislamiento que el resto del perfil extendido).
    """

    full_name: Optional[str] = None
    address: Optional[str] = None
    phone: Optional[str] = None
    totp_enabled: bool = False
    locale: Optional[Locale] = None


class UserProfileUpdate(BaseModel):
    """Payload de PATCH /account/profile (actualización parcial).

    Mismo shape que UserProfile a propósito: el endpoint aplica un UPDATE
    parcial solo de los campos presentes (`exclude_unset=True`). Esta clase
    NO incluye `role`, `email`, ni `password_hash` — la ausencia de esos
    campos en el propio tipo ya garantiza, a nivel de diseño de tipos, que
    este endpoint no puede tocar datos de seguridad de la cuenta (ver
    Requirement: Edición del perfil extendido propio).

    `locale` es ESTRICTO a propósito (a diferencia de BetaSignupRequest, que
    colapsa valores inválidos a 'es'): un PATCH con `locale: "fr"` responde
    422 sin modificar nada — requirement explícito de specs/account-settings
    (Scenario: Valor no soportado es rechazado). El Literal pelado ya produce
    ese 422 vía Pydantic.
    """

    full_name: Optional[str] = None
    address: Optional[str] = None
    phone: Optional[str] = None
    locale: Optional[Locale] = None


class TotpSetupResponse(BaseModel):
    """Respuesta de POST /auth/2fa/setup.

    `backup_codes` viaja en texto claro únicamente en esta respuesta —
    Decisión Cerrada #2 del proposal: se muestran UNA vez y nunca más se
    exponen en claro por ningún otro endpoint.
    """

    otpauth_uri: str
    backup_codes: list[str]


class TotpVerifyRequest(BaseModel):
    """Payload compartido por POST /auth/2fa/verify (setup) y
    POST /auth/2fa/login-verify (login step): código TOTP de 6 dígitos o
    backup code formateado "XXXX-XXXX" (8 caracteres + separador = 9).
    """

    code: str = Field(..., min_length=6, max_length=9)


class AccountExport(BaseModel):
    """Shape de GET /account/export (design.md Decision 5).

    `account`/`security` son `dict` deliberadamente (no modelos Pydantic
    dedicados): su contenido lo arma AuthService.export_user_data() a mano,
    excluyendo explícitamente password_hash/totp_secret/backup codes por
    construcción — ver Requirement: Exportación de los propios datos de
    cuenta.
    """

    account: dict
    profile: UserProfile
    security: dict
    exported_at: datetime

"""
Modelos de invitaciones (email-invitations, design.md Decision 8).

La separación InvitationPublic / InvitationWithToken es deliberada: un
endpoint que responda `list[InvitationPublic]` no PUEDE filtrar el token en
claro ni el hash porque el tipo no los declara — misma técnica de garantía
por diseño de tipos que documenta UserProfileUpdate en src/models/user.py.
"""

from datetime import datetime
from enum import Enum
from typing import Literal, Optional
from uuid import UUID

from pydantic import BaseModel, EmailStr

from src.models.user import UserRole

# Idioma del email de invitación (migración 010). Literal y no Enum: son dos
# valores cerrados sin comportamiento asociado — Pydantic rechaza con 422
# cualquier otro, igual que haría un enum, con menos ceremonia.
InvitationLocale = Literal["es", "en"]


class InvitationStatus(str, Enum):
    """Estado DERIVADO de los timestamps de la fila (design.md Decision 1):
    no existe columna `status` en la tabla — revocada/aceptada/expirada se
    deducen de revoked_at/accepted_at/expires_at al momento de la consulta,
    y este enum es sólo la representación de ese cálculo hacia afuera.
    """

    PENDING = "pending"
    ACCEPTED = "accepted"
    REVOKED = "revoked"
    EXPIRED = "expired"


class InvitationCreate(BaseModel):
    """Payload de POST /auth/invitations.

    `role` usa el enum existente — Pydantic rechaza con 422 cualquier rol
    fuera del contrato. El guard de escalación (nadie invita un rol superior
    al propio) NO vive acá: necesita conocer al invitador, es regla del
    servicio (InvitationService.create_invitation).
    """

    email: EmailStr
    role: UserRole
    # Idioma en que saldrá el email (pulido post-rollout): lo elige el admin
    # al invitar. Default 'es' — mismo default que la columna (migración 010).
    locale: InvitationLocale = "es"


class InvitationPublic(BaseModel):
    """Invitación segura para exponer: SIN token en claro y SIN token_hash.

    [Requirement: Token de invitación almacenado solo como hash / Scenario:
    El listado no expone tokens] — por construcción del tipo.
    """

    id: UUID
    email: EmailStr
    role: UserRole
    # El resend lo CONSERVA (regenera token, no idioma): el destinatario es el
    # mismo y su idioma no cambió.
    locale: InvitationLocale
    status: InvitationStatus
    # None si el admin que invitó borró su cuenta (FK ON DELETE SET NULL,
    # migración 007): se pierde trazabilidad, no funcionalidad.
    invited_by: Optional[UUID] = None
    created_at: datetime
    expires_at: datetime
    accepted_at: Optional[datetime] = None
    # None mientras la route de Next no confirmó el envío del email
    # (design.md Decision 4) — la UI lo muestra como "email sin confirmar".
    email_sent_at: Optional[datetime] = None


class InvitationWithToken(InvitationPublic):
    """InvitationPublic + token en claro. SOLO como response de create y
    resend — la ÚNICA vez que el sistema devuelve el claro (Decision 8);
    la base persiste únicamente el sha256 hex.
    """

    token: str

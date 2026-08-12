"""
Modelos del alta a la beta (landing pública).

Separado de user.py a propósito: un interesado en la beta NO es un usuario —
no tiene rol, ni password, ni sesión. Mezclarlo con los modelos de auth
invitaría a tratarlo como tal.
"""

from datetime import datetime
from typing import Optional
from uuid import UUID

from pydantic import BaseModel, EmailStr, Field, field_validator

from src.models.invitation import InvitationLocale


class BetaSignupItem(BaseModel):
    """Fila del listado admin de beta testers (GET /beta-signups).

    El estado se deriva de `approved_at` (mismo criterio que invitations:
    timestamps, no columnas de estado que puedan desincronizarse)."""

    id: UUID
    email: str
    created_at: datetime
    approved_at: Optional[datetime] = None
    # Idioma elegido en la landing (migración 011). Default 'es': espejo del
    # default de la columna, cubre construcciones de tests previas a i18n.
    locale: InvitationLocale = "es"


class BetaSignupRequest(BaseModel):
    """Payload de POST /beta-signups.

    `website` es un honeypot: el campo existe oculto en el form de la landing
    y ningún humano lo completa — un bot que rellena todos los inputs sí. Si
    llega con contenido, el endpoint responde 201 normal pero NO inserta:
    responder distinto le enseñaría al bot qué campo evitar.
    """

    email: EmailStr
    website: str = Field(default="", max_length=200)
    # Idioma del toggle de la landing. TOLERANTE a propósito (a diferencia de
    # UserProfileUpdate.locale, que responde 422): specs/auth exige que un
    # locale ausente O INVÁLIDO caiga a 'es' con 201 — nunca un 400/422 por
    # este campo, para que un caller viejo sin el campo (o un valor basura)
    # siga funcionando. El validator mode="before" colapsa cualquier cosa que
    # no sea 'es'/'en' ANTES de que el Literal la rechace.
    locale: InvitationLocale = "es"

    @field_validator("locale", mode="before")
    @classmethod
    def _coerce_unsupported_locale_to_spanish(cls, value: object) -> object:
        """Cualquier valor no soportado (None, "xx", números, "") cae a 'es'."""
        return value if value in ("es", "en") else "es"

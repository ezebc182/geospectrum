"""
Modelos del alta a la beta (landing pública).

Separado de user.py a propósito: un interesado en la beta NO es un usuario —
no tiene rol, ni password, ni sesión. Mezclarlo con los modelos de auth
invitaría a tratarlo como tal.
"""

from pydantic import BaseModel, EmailStr, Field


class BetaSignupRequest(BaseModel):
    """Payload de POST /beta-signups.

    `website` es un honeypot: el campo existe oculto en el form de la landing
    y ningún humano lo completa — un bot que rellena todos los inputs sí. Si
    llega con contenido, el endpoint responde 201 normal pero NO inserta:
    responder distinto le enseñaría al bot qué campo evitar.
    """

    email: EmailStr
    website: str = Field(default="", max_length=200)

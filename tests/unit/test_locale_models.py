"""Tests unitarios del locale en modelos y templates de email (i18n-dashboard, 1.8a).

Dos comportamientos DELIBERADAMENTE distintos, ambos por spec:

* `BetaSignupRequest.locale` es TOLERANTE — specs/auth exige que un locale
  ausente o inválido en el endpoint público caiga a 'es' con 201, nunca un
  422 (un caller viejo sin el campo sigue funcionando).
* `UserProfileUpdate.locale` es ESTRICTO — specs/account-settings exige 422
  ante un valor no soportado en PATCH /account/profile.

Los templates de email se verifican capturando `_send` del EmailService real
(sin red): subject y cuerpo completos en el idioma del locale, y el aviso
interno al admin siempre en español (tooling interno — MAY de la spec).
"""

from unittest.mock import AsyncMock

import pytest
from pydantic import ValidationError

from src.models.beta import BetaSignupItem, BetaSignupRequest
from src.models.user import UserProfile, UserProfileUpdate
from src.services.email_service import EmailService

# ---------------------------------------------------------------------------
# BetaSignupRequest — tolerante: todo lo no soportado colapsa a 'es'
# ---------------------------------------------------------------------------


def test_beta_signup_request_without_locale_defaults_to_spanish():
    """[Scenario: Caller sin locale o con valor inválido cae a español] —
    la mitad "sin campo": un payload viejo sin `locale` valida y queda 'es'."""
    request = BetaSignupRequest(email="fan@example.com")

    assert request.locale == "es"


@pytest.mark.parametrize("invalid", ["xx", "fr", "", None, 123, "ES", "en-US"])
def test_beta_signup_request_collapses_unsupported_locale_to_spanish(invalid):
    """[Scenario: Caller sin locale o con valor inválido cae a español] —
    la mitad "valor inválido": nada de 422, el validator before colapsa a 'es'."""
    request = BetaSignupRequest.model_validate({"email": "fan@example.com", "locale": invalid})

    assert request.locale == "es"


@pytest.mark.parametrize("valid", ["es", "en"])
def test_beta_signup_request_keeps_supported_locale(valid):
    """[Scenario: Alta desde la landing en inglés persiste el locale] — los
    dos valores soportados pasan intactos por el validator."""
    request = BetaSignupRequest.model_validate({"email": "fan@example.com", "locale": valid})

    assert request.locale == valid


def test_beta_signup_item_defaults_to_spanish():
    """Espejo del default de la columna (migración 011): una fila histórica
    construida sin locale reporta 'es'."""
    item = BetaSignupItem(
        id="3f9a2b1c-1111-2222-3333-444455556680",
        email="fan@example.com",
        created_at="2026-01-01T00:00:00Z",
    )

    assert item.locale == "es"


# ---------------------------------------------------------------------------
# UserProfileUpdate / UserProfile — estricto: 422 ante valor no soportado
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("valid", ["es", "en", None])
def test_user_profile_update_accepts_supported_locales(valid):
    """[Requirement: Edición del locale vía PATCH /account/profile] — es, en
    y None (no tocar) son los únicos valores válidos."""
    update = UserProfileUpdate(locale=valid)

    assert update.locale == valid


@pytest.mark.parametrize("invalid", ["fr", "", "xx", 123, "ES"])
def test_user_profile_update_rejects_unsupported_locale(invalid):
    """[Scenario: Valor no soportado es rechazado] — el Literal pelado produce
    el error de validación que el endpoint traduce a 422, SIN el fallback
    tolerante de BetaSignupRequest."""
    with pytest.raises(ValidationError):
        UserProfileUpdate.model_validate({"locale": invalid})


def test_user_profile_update_without_locale_leaves_it_unset():
    """[Scenario: PATCH de otros campos no pisa la preferencia] — sin `locale`
    en el payload, el campo NO entra al UPDATE parcial (exclude_unset)."""
    update = UserProfileUpdate(full_name="Nueva Firma")

    assert "locale" not in update.model_dump(exclude_unset=True)


def test_user_profile_defaults_locale_to_none():
    """[Scenario: Cuenta preexistente sin preferencia] — None es el estado
    inicial ("nunca eligió"), no 'es'."""
    assert UserProfile().locale is None


# ---------------------------------------------------------------------------
# Templates de email por locale (subject y cuerpo, sin red)
# ---------------------------------------------------------------------------


@pytest.fixture
def email_service():
    """EmailService real con `_send` capturado: se afirma sobre subject/html
    exactamente como saldrían, sin tocar Resend."""
    service = EmailService(
        api_key="test-key",
        sender="GeoSpectrum <no-reply@geospectrum.org>",
        admin_email="admin@geospectrum.org",
        dashboard_url="https://app.geospectrum.org",
    )
    service._send = AsyncMock(return_value=True)  # type: ignore[method-assign]
    return service


def _sent_to(service, recipient):
    """El (subject, html) del email enviado a `recipient`."""
    for call in service._send.call_args_list:
        if call.kwargs["to"] == recipient:
            return call.kwargs["subject"], call.kwargs["html"]
    raise AssertionError(f"no se envió email a {recipient}")


@pytest.mark.asyncio
async def test_beta_signup_email_in_english(email_service):
    """[Scenario: Confirmación de lista de espera en inglés] — subject y
    cuerpo completos en inglés; el aviso al admin sigue en español."""
    await email_service.send_beta_signup_emails("fan@example.com", "en")

    subject, html = _sent_to(email_service, "fan@example.com")
    assert subject == "You're on the GeoSpectrum waitlist"
    assert "your spot on the beta waitlist" in html
    assert "lista de espera" not in html

    admin_subject, admin_html = _sent_to(email_service, "admin@geospectrum.org")
    assert admin_subject == "Beta: nuevo interesado — fan@example.com"
    assert "lista de espera" in admin_html


@pytest.mark.asyncio
async def test_beta_signup_email_in_spanish_by_default(email_service):
    """[Scenario: Confirmación de lista de espera en inglés / AND en español]
    — sin locale sale el copy ES completo, y la vieja línea muted en inglés
    (el parche monolingüe) ya no existe."""
    await email_service.send_beta_signup_emails("fan@example.com")

    subject, html = _sent_to(email_service, "fan@example.com")
    assert subject == "Estás en la lista de espera de GeoSpectrum"
    assert "lista de espera" in html
    assert "You're on the waitlist" not in html


@pytest.mark.asyncio
async def test_beta_approved_email_in_english(email_service):
    """[Scenario: Email de aprobación en el idioma del signup] — inglés
    completo, con el mismo link a /login de siempre."""
    await email_service.send_beta_approved_email("fan@example.com", "en")

    subject, html = _sent_to(email_service, "fan@example.com")
    assert subject == "Your GeoSpectrum access is ready"
    assert "Sign in with your Google account" in html
    assert "https://app.geospectrum.org/login" in html
    assert "Entrá" not in html


@pytest.mark.asyncio
async def test_beta_approved_email_in_spanish_by_default(email_service):
    """[Scenario: Email de aprobación en el idioma del signup] — contraparte
    ES: mismo template parametrizado por idioma, mismo link a /login."""
    await email_service.send_beta_approved_email("fan@example.com")

    subject, html = _sent_to(email_service, "fan@example.com")
    assert subject == "Tu acceso a GeoSpectrum está listo"
    assert "https://app.geospectrum.org/login" in html
    assert "Sign in with" not in html

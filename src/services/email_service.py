"""
Emails transaccionales del flujo de beta, vía la API REST de Resend.

Sale de FastAPI (no de react-email/Next) a propósito: el alta y la
aprobación de beta testers ocurren en este backend, y mandar el email desde
donde ocurre el hecho evita el viaje absurdo FastAPI → Next → Resend. Los
transaccionales "lindos" del dashboard (react-email) son otra iniciativa
(email-invitations, Fases 5+).

Diseño: tablas anidadas con estilos inline — es el único markup que Gmail,
Outlook y Apple Mail renderizan parejo (nada de flexbox/grid/CSS externo).
La identidad es la misma "sala de control" del producto: banda oscura de
marca con acento teal, cuerpo claro para legibilidad (los emails full-dark
se rompen en el dark mode automático de Gmail), chips mono para datos.

Filosofía de errores: NUNCA lanza. Un email caído no puede romper un alta
ni una aprobación — el registro en la base es la verdad; el email es un
side-effect que se loguea y se reintenta a mano si hace falta. Sin
RESEND_API_KEY el servicio queda deshabilitado y sólo loguea (dev local).
"""

import asyncio
import logging
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

RESEND_API_URL = "https://api.resend.com/emails"

# Paleta: los tokens de la "sala de control" traducidos a hex planos.
_DARK = "#0b1526"  # banda de marca (azul casi-negro del theme)
_ACCENT = "#14b8a6"  # teal primario
_ACCENT_DARK = "#0d9488"
_AMBER = "#f59e0b"  # severidad moderada — divider decorativo
_RED = "#ef4444"  # severidad crítica — divider decorativo
_TEXT = "#0f172a"
_MUTED = "#64748b"
_CHIP_BG = "#f1f5f9"

_FONT = "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"
_MONO = "'SF Mono',SFMono-Regular,Consolas,'Liberation Mono',Menlo,monospace"


def _button(url: str, label: str) -> str:
    """CTA bulletproof: tabla + padding en la celda (Outlook ignora el
    padding de los <a>, pero respeta el de los <td>)."""
    return f"""\
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:28px 0 8px">
  <tr>
    <td style="background:{_ACCENT_DARK};border-radius:10px">
      <a href="{url}" style="display:inline-block;padding:14px 32px;font-family:{_FONT};font-size:15px;font-weight:700;color:#ffffff;text-decoration:none">{label}</a>
    </td>
  </tr>
</table>"""


def _chip(value: str) -> str:
    """Dato destacado (un email, un código) en chip monoespaciado."""
    return f"""\
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:4px 0 20px">
  <tr>
    <td style="background:{_CHIP_BG};border:1px solid #e2e8f0;border-radius:8px;padding:10px 16px;font-family:{_MONO};font-size:14px;color:{_TEXT}">{value}</td>
  </tr>
</table>"""


def _layout(kicker: str, title: str, body_html: str) -> str:
    """Esqueleto común: banda de marca oscura, cuerpo claro, divider con la
    paleta de severidad (el guiño sísmico), footer oscuro."""
    return f"""\
<div style="background:#e8edf4;padding:32px 12px;margin:0">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:560px;margin:0 auto">

    <!-- Banda de marca -->
    <tr>
      <td style="background:{_DARK};border-radius:16px 16px 0 0;padding:28px 36px;border-bottom:3px solid {_ACCENT}">
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
          <tr>
            <td style="font-family:{_FONT};font-size:20px;font-weight:800;letter-spacing:-0.3px;color:#ffffff">
              <span style="color:{_ACCENT}">&#9650;</span>&nbsp; GeoSpectrum
            </td>
            <td align="right" style="font-family:{_MONO};font-size:10px;letter-spacing:2px;color:#7d8ba1;text-transform:uppercase">
              Monitoreo s&iacute;smico global
            </td>
          </tr>
        </table>
      </td>
    </tr>

    <!-- Cuerpo -->
    <tr>
      <td style="background:#ffffff;padding:40px 36px 32px">
        <p style="margin:0 0 10px;font-family:{_MONO};font-size:11px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:{_ACCENT_DARK}">{kicker}</p>
        <h1 style="margin:0 0 18px;font-family:{_FONT};font-size:26px;line-height:1.25;letter-spacing:-0.4px;color:{_TEXT}">{title}</h1>
        {body_html}
      </td>
    </tr>

    <!-- Divider de severidad: el guiño a la escala de magnitud -->
    <tr>
      <td style="background:#ffffff;padding:0 36px 28px">
        <table role="presentation" cellpadding="0" cellspacing="0">
          <tr>
            <td style="width:34px;height:4px;background:{_ACCENT};border-radius:2px"></td>
            <td style="width:8px"></td>
            <td style="width:18px;height:4px;background:{_AMBER};border-radius:2px"></td>
            <td style="width:8px"></td>
            <td style="width:8px;height:4px;background:{_RED};border-radius:2px"></td>
          </tr>
        </table>
      </td>
    </tr>

    <!-- Footer -->
    <tr>
      <td style="background:{_DARK};border-radius:0 0 16px 16px;padding:22px 36px">
        <p style="margin:0;font-family:{_FONT};font-size:12px;line-height:1.7;color:#7d8ba1">
          GeoSpectrum &middot; La Tierra no avisa. GeoSpectrum s&iacute;.<br>
          <a href="https://geospectrum.org" style="color:{_ACCENT};text-decoration:none">geospectrum.org</a>
          &nbsp;&middot;&nbsp; Datos: USGS &middot; EMSC &middot; INPRES
        </p>
      </td>
    </tr>

  </table>
</div>"""


def _paragraph(text: str, muted: bool = False) -> str:
    color = _MUTED if muted else _TEXT
    size = "13px" if muted else "15px"
    return f'<p style="margin:0 0 16px;font-family:{_FONT};font-size:{size};line-height:1.65;color:{color}">{text}</p>'


class EmailService:
    """Cliente mínimo de Resend para los emails del flujo de beta."""

    def __init__(
        self,
        api_key: Optional[str],
        sender: str,
        admin_email: Optional[str],
        dashboard_url: str,
    ) -> None:
        self._api_key = api_key
        self._sender = sender
        self._admin_email = admin_email
        self._dashboard_url = dashboard_url.rstrip("/")

    @property
    def enabled(self) -> bool:
        return bool(self._api_key)

    async def _send(self, to: str, subject: str, html: str) -> bool:
        """Un email. Loguea y devuelve False ante cualquier fallo — jamás
        propaga: el caller ya persistió lo importante en la base."""
        if not self.enabled:
            logger.info("Email deshabilitado (sin RESEND_API_KEY) — no se envía: %s", subject)
            return False

        try:
            async with httpx.AsyncClient(timeout=10) as client:
                response = await client.post(
                    RESEND_API_URL,
                    headers={"Authorization": f"Bearer {self._api_key}"},
                    json={"from": self._sender, "to": [to], "subject": subject, "html": html},
                )
            if response.status_code >= 400:
                logger.error(
                    "Resend rechazó el email '%s' a %s: %s %s",
                    subject,
                    to,
                    response.status_code,
                    response.text,
                )
                return False
            logger.info("Email enviado a %s: %s", to, subject)
            return True
        except httpx.HTTPError:
            logger.exception("No se pudo enviar el email '%s' a %s", subject, to)
            return False

    async def send_beta_signup_emails(self, email: str) -> None:
        """Alta NUEVA en la lista de espera: confirmación al interesado +
        aviso al admin, en paralelo (decisión del usuario: ambos)."""
        confirmation = self._send(
            to=email,
            subject="Estás en la lista de espera de GeoSpectrum",
            html=_layout(
                "Lista de espera",
                "Ya estás en la lista",
                _paragraph(
                    "Gracias por tu interés en GeoSpectrum. Reservamos tu lugar "
                    "en la lista de espera de la beta con este email:"
                )
                + _chip(email)
                + _paragraph(
                    "Cuando se abra tu cupo te va a llegar un email de "
                    "bienvenida con el acceso — no hace falta que hagas nada más."
                )
                + _paragraph(
                    "You're on the waitlist — we'll email you when your spot opens.", muted=True
                ),
            ),
        )

        tasks = [confirmation]
        if self._admin_email:
            tasks.append(
                self._send(
                    to=self._admin_email,
                    subject=f"Beta: nuevo interesado — {email}",
                    html=_layout(
                        "Nuevo interesado",
                        "Alguien quiere entrar a la beta",
                        _paragraph("Se sumó a la lista de espera desde la landing:")
                        + _chip(email)
                        + _button(f"{self._dashboard_url}/beta", "Ver lista y aprobar"),
                    ),
                )
            )
        await asyncio.gather(*tasks)

    async def send_beta_approved_email(self, email: str) -> None:
        """Aprobación: bienvenida con link directo a /login. Sin token en el
        link a propósito — la invitación se consume por match del email
        verificado de Google (email-invitations, Decision 5)."""
        await self._send(
            to=email,
            subject="Tu acceso a GeoSpectrum está listo",
            html=_layout(
                "Tu cupo se abrió",
                "Bienvenido a la beta de GeoSpectrum",
                _paragraph(
                    "Tu acceso está listo. Entrá con tu cuenta de Google usando "
                    "<strong>este mismo email</strong> — la invitación está "
                    "atada a esta dirección:"
                )
                + _chip(email)
                + _button(f"{self._dashboard_url}/login", "Entrar a GeoSpectrum")
                + _paragraph(
                    "El acceso vence en unos días si no lo usás. Si te pasó de "
                    "largo, respondé este email y te lo reenviamos.",
                    muted=True,
                ),
            ),
        )

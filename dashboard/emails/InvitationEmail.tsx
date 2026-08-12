/**
 * Email de invitación a GeoSpectrum (react-email).
 *
 * Lo renderiza `app/api/invitations/send/route.ts` vía la prop `react:` del
 * SDK de Resend — server-side ÚNICAMENTE. Este archivo NUNCA debe importarse
 * desde un client component (arrastraría el SDK y el template al bundle del
 * navegador; ver checklist de seguridad del proposal).
 *
 * BILINGÜE en un solo template: bloque en español arriba, divisor, bloque en
 * inglés abajo. Sin prop `locale` ni diccionarios a propósito — al momento de
 * invitar no sabemos qué idioma habla el destinatario (va a haber invitados
 * de Argentina y de USA), y un email es un envío único sin chance de
 * corregir. Mostrar los dos idiomas siempre es más barato y más robusto que
 * adivinar; el costo es un email un poco más largo.
 *
 * Ojo con la convención del proyecto: lo bilingüe es SOLO el copy que lee el
 * destinatario. Los identificadores siguen en inglés y los comentarios en
 * español, igual que en todo el repo.
 */

import { Button, Hr, Section, Text } from '@react-email/components';

import { EmailLayout, brand } from './components/EmailLayout';

/** Etiquetas de rol por idioma. Las de español coinciden con las que muestra
 *  la UI (el backend serializa los roles en español salvo `viewer`; ver
 *  lib/types.ts UserRole). */
const ROLE_LABELS_ES: Record<string, string> = {
  superadmin: 'Superadministrador',
  admin: 'Administrador',
  moderador: 'Moderador',
  viewer: 'Visualizador',
};

const ROLE_LABELS_EN: Record<string, string> = {
  superadmin: 'Superadmin',
  admin: 'Admin',
  moderador: 'Moderator',
  viewer: 'Viewer',
};

export interface InvitationEmailProps {
  /** Email invitado — es el que quedará atado a la cuenta. */
  email: string;
  /** Rol pre-asignado por quien invitó. El invitado no puede cambiarlo. */
  role: string;
  /** Link absoluto a `/invite/{token}` sobre la URL base pública. */
  inviteUrl: string;
  /** Vencimiento de la invitación en ISO-8601 (viene del backend). */
  expiresAt: string;
}

/**
 * Fecha de expiración legible, con el locale SIEMPRE explícito: el locale por
 * defecto del servidor (Vercel) no es el del destinatario y variaría entre
 * entornos. `es-AR` da 17/08/2026; `en-US` da Aug 17, 2026 — cada bloque de
 * idioma muestra la fecha como la espera su lector, sin ambigüedad
 * día/mes. Fallback al valor crudo si el string no es parseable: nunca romper
 * el email por una fecha mal formada.
 */
function formatExpiry(expiresAt: string, locale: 'es-AR' | 'en-US'): string {
  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime())) return expiresAt;

  // `dateStyle: 'short'` en es-AR abrevia el año a dos dígitos (17/8/26):
  // ambiguo para una fecha de vencimiento. Se piden los campos explícitos
  // para obtener 17/08/2026. En en-US, 'medium' ya da Aug 17, 2026.
  if (locale === 'es-AR') {
    return new Intl.DateTimeFormat('es-AR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      timeZone: 'America/Argentina/Buenos_Aires',
    }).format(date);
  }

  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeZone: 'America/Argentina/Buenos_Aires',
  }).format(date);
}

export function InvitationEmail({ email, role, inviteUrl, expiresAt }: InvitationEmailProps) {
  const roleLabelEs = ROLE_LABELS_ES[role] ?? role;
  const roleLabelEn = ROLE_LABELS_EN[role] ?? role;
  const expiryEs = formatExpiry(expiresAt, 'es-AR');
  const expiryEn = formatExpiry(expiresAt, 'en-US');

  return (
    <EmailLayout preview="Te invitaron a GeoSpectrum / You've been invited to GeoSpectrum">
      {/* ---------------------------- Español ---------------------------- */}
      <Text style={headingStyle}>Te invitaron a GeoSpectrum</Text>

      <Text style={paragraphStyle}>
        Alguien del equipo te invitó a sumarte a GeoSpectrum, la plataforma de monitoreo sísmico
        en tiempo real. La invitación es para <strong>{email}</strong> con el rol{' '}
        <strong>{roleLabelEs}</strong>.
      </Text>

      <Section style={buttonWrapperStyle}>
        <Button href={inviteUrl} style={buttonStyle}>
          Aceptar invitación
        </Button>
      </Section>

      <Text style={paragraphStyle}>
        Al abrir el link vas a poder crear tu cuenta con una contraseña o continuar con Google.
      </Text>

      <Text style={expiryStyle}>
        Esta invitación vence el <strong>{expiryEs}</strong>. Después de esa fecha el link deja de
        funcionar y vas a tener que pedir un reenvío.
      </Text>

      <Text style={fallbackLabelStyle}>Si el botón no funciona, copiá y pegá esta dirección:</Text>
      <Text style={fallbackLinkStyle}>{inviteUrl}</Text>

      {/* ------------------------ Divisor de idioma ---------------------- */}
      <Hr style={languageDividerStyle} />

      {/* ---------------------------- English ---------------------------- */}
      <Text style={headingStyle}>You&apos;ve been invited to GeoSpectrum</Text>

      <Text style={paragraphStyle}>
        Someone on the team invited you to join GeoSpectrum, the real-time seismic monitoring
        platform. This invitation is for <strong>{email}</strong> with the{' '}
        <strong>{roleLabelEn}</strong> role.
      </Text>

      <Section style={buttonWrapperStyle}>
        <Button href={inviteUrl} style={buttonStyle}>
          Accept invitation
        </Button>
      </Section>

      <Text style={paragraphStyle}>
        Opening the link lets you create your account with a password or continue with Google.
      </Text>

      <Text style={expiryStyle}>
        This invitation expires on <strong>{expiryEn}</strong>. After that date the link stops
        working and you&apos;ll need to request a new one.
      </Text>

      <Text style={fallbackLabelStyle}>
        If the button doesn&apos;t work, copy and paste this address:
      </Text>
      <Text style={fallbackLinkStyle}>{inviteUrl}</Text>
    </EmailLayout>
  );
}

export default InvitationEmail;

const headingStyle = {
  color: brand.text,
  fontSize: '20px',
  fontWeight: 700,
  margin: '0 0 16px',
};

const paragraphStyle = {
  color: brand.text,
  fontSize: '15px',
  lineHeight: '24px',
  margin: '0 0 16px',
};

const buttonWrapperStyle = {
  margin: '24px 0',
  textAlign: 'center' as const,
};

const buttonStyle = {
  backgroundColor: brand.primary,
  borderRadius: '8px',
  color: '#ffffff',
  display: 'inline-block',
  fontSize: '15px',
  fontWeight: 600,
  padding: '12px 28px',
  textDecoration: 'none',
};

const expiryStyle = {
  color: brand.text,
  fontSize: '14px',
  lineHeight: '22px',
  margin: '0 0 24px',
};

const fallbackLabelStyle = {
  color: brand.muted,
  fontSize: '12px',
  margin: '0 0 4px',
};

const fallbackLinkStyle = {
  color: brand.primary,
  fontSize: '12px',
  margin: '0',
  wordBreak: 'break-all' as const,
};

// Separador entre los dos bloques de idioma — más aire que el <Hr> del
// layout para que se lea como "acá empieza la misma invitación en el otro
// idioma", no como un cambio de tema.
const languageDividerStyle = {
  borderColor: brand.border,
  margin: '32px 0',
};

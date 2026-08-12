/**
 * Email de invitación a GeoSpectrum (react-email).
 *
 * Lo renderiza `app/api/invitations/send/route.ts` vía la prop `react:` del
 * SDK de Resend — server-side ÚNICAMENTE. Este archivo NUNCA debe importarse
 * desde un client component (arrastraría el SDK y el template al bundle del
 * navegador; ver checklist de seguridad del proposal).
 *
 * MONOLINGÜE según la prop `locale` (pulido post-rollout): el admin elige el
 * idioma al invitar y viaja con la invitación (columna `locale`, migración
 * 010). Reemplaza al template bilingüe duplicado — ahora que el idioma se
 * conoce al invitar, mandar los dos bloques era ruido. El rol tampoco va en
 * el cuerpo: decisión del usuario, es información innecesaria para aceptar.
 *
 * Ojo con la convención del proyecto: lo localizado es SOLO el copy que lee
 * el destinatario. Los identificadores siguen en inglés y los comentarios en
 * español, igual que en todo el repo.
 */

import { Button, Section, Text } from '@react-email/components';

import { EmailLayout, brand } from './components/EmailLayout';
import type { EmailLocale } from './components/EmailLayout';

export interface InvitationEmailProps {
  /** Email invitado — es el que quedará atado a la cuenta. */
  email: string;
  /** Link absoluto a `/invite/{token}` sobre la URL base pública. */
  inviteUrl: string;
  /** Vencimiento de la invitación en ISO-8601 (viene del backend). */
  expiresAt: string;
  /** Idioma del email. Default 'es' — mismo default que backend y columna. */
  locale?: EmailLocale;
}

/**
 * Fecha de expiración legible, con el locale SIEMPRE explícito: el locale por
 * defecto del servidor (Vercel) no es el del destinatario y variaría entre
 * entornos. `es-AR` da 17/08/2026; `en-US` da Aug 17, 2026 — la fecha se
 * muestra como la espera su lector, sin ambigüedad día/mes. Fallback al valor
 * crudo si el string no es parseable: nunca romper el email por una fecha mal
 * formada.
 */
function formatExpiry(expiresAt: string, locale: EmailLocale): string {
  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime())) return expiresAt;

  // `dateStyle: 'short'` en es-AR abrevia el año a dos dígitos (17/8/26):
  // ambiguo para una fecha de vencimiento. Se piden los campos explícitos
  // para obtener 17/08/2026. En en-US, 'medium' ya da Aug 17, 2026.
  if (locale === 'es') {
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

/** Copy completo por idioma. Un solo diccionario plano — dos idiomas y un
 *  template no ameritan una librería de i18n. */
const COPY = {
  es: {
    preview: 'Te invitaron a GeoSpectrum',
    heading: 'Te invitaron a GeoSpectrum',
    intro: (email: string) => (
      <>
        Alguien del equipo te invitó a sumarte a GeoSpectrum, la plataforma de monitoreo sísmico
        en tiempo real. La invitación es para <strong>{email}</strong>.
      </>
    ),
    cta: 'Aceptar invitación',
    afterCta: 'Al abrir el link vas a poder crear tu cuenta con una contraseña o continuar con Google.',
    expiry: (date: string) => (
      <>
        Esta invitación vence el <strong>{date}</strong>. Después de esa fecha el link deja de
        funcionar y vas a tener que pedir un reenvío.
      </>
    ),
    fallbackLabel: 'Si el botón no funciona, copiá y pegá esta dirección:',
  },
  en: {
    preview: "You've been invited to GeoSpectrum",
    heading: "You've been invited to GeoSpectrum",
    intro: (email: string) => (
      <>
        Someone on the team invited you to join GeoSpectrum, the real-time seismic monitoring
        platform. This invitation is for <strong>{email}</strong>.
      </>
    ),
    cta: 'Accept invitation',
    afterCta: 'Opening the link lets you create your account with a password or continue with Google.',
    expiry: (date: string) => (
      <>
        This invitation expires on <strong>{date}</strong>. After that date the link stops working
        and you&apos;ll need to request a new one.
      </>
    ),
    fallbackLabel: "If the button doesn't work, copy and paste this address:",
  },
} as const;

export function InvitationEmail({ email, inviteUrl, expiresAt, locale = 'es' }: InvitationEmailProps) {
  const copy = COPY[locale];
  const expiry = formatExpiry(expiresAt, locale);

  return (
    <EmailLayout preview={copy.preview} locale={locale}>
      <Text style={headingStyle}>{copy.heading}</Text>

      <Text style={paragraphStyle}>{copy.intro(email)}</Text>

      <Section style={buttonWrapperStyle}>
        <Button href={inviteUrl} style={buttonStyle}>
          {copy.cta}
        </Button>
      </Section>

      <Text style={paragraphStyle}>{copy.afterCta}</Text>

      <Text style={expiryStyle}>{copy.expiry(expiry)}</Text>

      <Text style={fallbackLabelStyle}>{copy.fallbackLabel}</Text>
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

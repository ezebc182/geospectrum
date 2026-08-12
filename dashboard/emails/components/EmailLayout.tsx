/**
 * Layout base de los emails transaccionales de GeoSpectrum.
 *
 * Reusable a propósito: el Out of Scope del proposal anticipa más
 * transaccionales (alertas sísmicas por email, aviso de link de cuenta
 * Google, reset de password). Cada template nuevo aporta SOLO su contenido;
 * el branding, el ancho, la tipografía y el pie viven acá una sola vez.
 *
 * Estilos inline y tablas (no clases ni flex/grid): los clientes de email
 * — Outlook y Gmail sobre todo — descartan `<style>` y no soportan layout
 * moderno. `@react-email/components` ya emite ese HTML compatible; lo que
 * no hay que hacer es meterle Tailwind por costumbre.
 */

import {
  Body,
  Container,
  Head,
  Hr,
  Html,
  Preview,
  Section,
  Text,
} from '@react-email/components';
import type { ReactNode } from 'react';

// Paleta alineada con el dashboard (app/globals.css: --primary 172 80% 32%).
export const brand = {
  primary: '#0f9384',
  text: '#0f172a',
  muted: '#64748b',
  border: '#e2e8f0',
  background: '#f8fafc',
  surface: '#ffffff',
} as const;

/** Idiomas soportados por los emails transaccionales — espejo del
 *  `InvitationLocale` del backend (migración 010). */
export type EmailLocale = 'es' | 'en';

/** Copy del pie por idioma (el pie también es copy que lee el destinatario:
 *  monolingüe, mismo criterio que los templates desde el pulido post-rollout). */
const FOOTER_COPY: Record<EmailLocale, { tagline: string; footer: string }> = {
  es: {
    tagline: 'Monitoreo sísmico en tiempo real',
    footer: 'Este es un email automático de GeoSpectrum. Si no esperabas recibirlo, podés ignorarlo.',
  },
  en: {
    tagline: 'Real-time seismic monitoring',
    footer: "This is an automated email from GeoSpectrum. If you weren't expecting it, you can ignore it.",
  },
};

interface EmailLayoutProps {
  /** Texto del preview en la bandeja de entrada (antes de abrir el email). */
  preview: string;
  /** Idioma del pie y el tagline. Default 'es', igual que los templates. */
  locale?: EmailLocale;
  children: ReactNode;
}

export function EmailLayout({ preview, locale = 'es', children }: EmailLayoutProps) {
  const copy = FOOTER_COPY[locale];

  return (
    <Html lang={locale}>
      <Head />
      <Preview>{preview}</Preview>
      <Body style={bodyStyle}>
        <Container style={containerStyle}>
          <Section style={headerStyle}>
            <Text style={logoStyle}>GeoSpectrum</Text>
            <Text style={taglineStyle}>{copy.tagline}</Text>
          </Section>

          <Section style={cardStyle}>{children}</Section>

          <Hr style={hrStyle} />

          <Section>
            <Text style={footerStyle}>{copy.footer}</Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

const bodyStyle = {
  backgroundColor: brand.background,
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
  margin: '0',
  padding: '24px 0',
};

const containerStyle = {
  backgroundColor: 'transparent',
  margin: '0 auto',
  maxWidth: '560px',
  padding: '0 16px',
};

const headerStyle = {
  paddingBottom: '16px',
  textAlign: 'center' as const,
};

const logoStyle = {
  color: brand.primary,
  fontSize: '26px',
  fontWeight: 700,
  letterSpacing: '-0.5px',
  margin: '0',
};

const taglineStyle = {
  color: brand.muted,
  fontSize: '13px',
  margin: '4px 0 0',
};

const cardStyle = {
  backgroundColor: brand.surface,
  border: `1px solid ${brand.border}`,
  borderRadius: '10px',
  padding: '32px',
};

const hrStyle = {
  borderColor: brand.border,
  margin: '24px 0 16px',
};

const footerStyle = {
  color: brand.muted,
  fontSize: '12px',
  lineHeight: '18px',
  margin: '0',
  textAlign: 'center' as const,
};

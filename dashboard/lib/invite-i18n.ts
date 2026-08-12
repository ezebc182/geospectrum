/**
 * i18n autocontenido de la página pública de invitación (ES/EN).
 *
 * Mismo criterio que lib/landing-i18n.ts: diccionarios planos sin librería —
 * es UNA página con texto estático y no justifica next-intl ni rutas
 * [locale]. El idioma INICIAL viene del `locale` de la invitación (respuesta
 * de validate, migración 010); el toggle de la página permite cambiarlo en
 * caliente sin persistencia (la página se visita una sola vez).
 */

import type { InvitationLocale, UserRole } from './types';

export interface InviteCopy {
  /** Etiqueta accesible del grupo de botones de idioma. */
  localeSwitcherAria: string;
  loading: string;
  errors: {
    invalidTitle: string;
    invalidMessage: string;
    goneTitle: string;
    goneMessage: string;
    networkTitle: string;
    networkMessage: string;
  };
  accept: {
    kicker: string;
    title: string;
    emailLabel: string;
    roleLabel: string;
    expiresLabel: string;
    passwordLabel: string;
    passwordPlaceholder: string;
    confirmLabel: string;
    confirmPlaceholder: string;
    /** Error inline cuando la confirmación no coincide. */
    mismatch: string;
    showPassword: string;
    hidePassword: string;
    /** Prefijo del medidor ("Fuerza" / "Strength"). */
    strengthLabel: string;
    /** 4 niveles, de más débil a más fuerte — índice = score - 1. */
    strengthLevels: readonly [string, string, string, string];
    submit: string;
    submitting: string;
    divider: string;
    google: string;
    /** Se interpola el email con {email}. */
    googleHint: [string, string];
    errorGone: string;
    errorConflict: string;
    errorGeneric: string;
  };
  roles: Record<UserRole, string>;
}

export const INVITE_COPY: Record<InvitationLocale, InviteCopy> = {
  es: {
    localeSwitcherAria: 'Idioma de la página',
    loading: 'Validando tu invitación…',
    errors: {
      invalidTitle: 'Invitación no válida',
      invalidMessage:
        'Este link de invitación no existe. Revisá que la URL esté completa o pedile a quien te invitó que la genere de nuevo.',
      goneTitle: 'Invitación vencida o revocada',
      goneMessage:
        'Este link ya no sirve: la invitación expiró, fue revocada o ya se usó. Pedile a quien te invitó que la reenvíe — el reenvío genera un link nuevo.',
      networkTitle: 'No se pudo validar la invitación',
      networkMessage:
        'Hubo un problema de conexión al validar el link. Recargá la página para intentar de nuevo.',
    },
    accept: {
      kicker: 'Invitación',
      title: 'Te invitaron a GeoSpectrum',
      emailLabel: 'Email',
      roleLabel: 'Rol',
      expiresLabel: 'Válida hasta',
      passwordLabel: 'Elegí una contraseña',
      passwordPlaceholder: 'Mínimo 8 caracteres',
      confirmLabel: 'Confirmar contraseña',
      confirmPlaceholder: 'Repetí la contraseña',
      mismatch: 'Las contraseñas no coinciden.',
      showPassword: 'Mostrar contraseña',
      hidePassword: 'Ocultar contraseña',
      strengthLabel: 'Fuerza',
      strengthLevels: ['Muy débil', 'Débil', 'Aceptable', 'Fuerte'],
      submit: 'Crear cuenta y entrar',
      submitting: 'Creando tu cuenta…',
      divider: 'o',
      google: 'Continuar con Google',
      googleHint: ['Usá la cuenta de Google de ', ' — la invitación está atada a ese email.'],
      errorGone:
        'La invitación dejó de ser válida mientras completabas el alta. Pedí un reenvío del link.',
      errorConflict: 'Este email ya tiene una cuenta. Entrá desde la página de login.',
      errorGeneric: 'No se pudo crear la cuenta. Intentá de nuevo en unos segundos.',
    },
    roles: {
      superadmin: 'Superadmin',
      admin: 'Administrador',
      moderador: 'Moderador',
      viewer: 'Observador',
    },
  },
  en: {
    localeSwitcherAria: 'Page language',
    loading: 'Validating your invitation…',
    errors: {
      invalidTitle: 'Invalid invitation',
      invalidMessage:
        'This invitation link does not exist. Check that the URL is complete or ask the person who invited you to generate it again.',
      goneTitle: 'Invitation expired or revoked',
      goneMessage:
        'This link no longer works: the invitation expired, was revoked, or was already used. Ask the person who invited you to resend it — resending generates a new link.',
      networkTitle: 'Could not validate the invitation',
      networkMessage:
        'There was a connection problem while validating the link. Reload the page to try again.',
    },
    accept: {
      kicker: 'Invitation',
      title: "You've been invited to GeoSpectrum",
      emailLabel: 'Email',
      roleLabel: 'Role',
      expiresLabel: 'Valid until',
      passwordLabel: 'Choose a password',
      passwordPlaceholder: 'At least 8 characters',
      confirmLabel: 'Confirm password',
      confirmPlaceholder: 'Repeat the password',
      mismatch: 'Passwords do not match.',
      showPassword: 'Show password',
      hidePassword: 'Hide password',
      strengthLabel: 'Strength',
      strengthLevels: ['Very weak', 'Weak', 'Fair', 'Strong'],
      submit: 'Create account and sign in',
      submitting: 'Creating your account…',
      divider: 'or',
      google: 'Continue with Google',
      googleHint: ['Use the Google account for ', ' — the invitation is tied to that email.'],
      errorGone:
        'The invitation stopped being valid while you were signing up. Ask for the link to be resent.',
      errorConflict: 'This email already has an account. Sign in from the login page.',
      errorGeneric: 'Could not create the account. Try again in a few seconds.',
    },
    roles: {
      superadmin: 'Superadmin',
      admin: 'Administrator',
      moderador: 'Moderator',
      viewer: 'Viewer',
    },
  },
};

/**
 * Fuerza de contraseña client-side, sin dependencias: score 0–4 por longitud
 * y variedad de clases de caracteres. Es SOLO feedback visual — la política
 * real (mínimo 8) la valida el backend en /auth/register.
 */
export function passwordStrength(password: string): number {
  if (password.length === 0) return 0;

  let classes = 0;
  if (/[a-z]/.test(password)) classes += 1;
  if (/[A-Z]/.test(password)) classes += 1;
  if (/[0-9]/.test(password)) classes += 1;
  if (/[^a-zA-Z0-9]/.test(password)) classes += 1;

  let score = 1;
  if (password.length >= 8) score += 1;
  if (password.length >= 12 && classes >= 2) score += 1;
  if (password.length >= 12 && classes >= 3) score += 1;

  return score;
}

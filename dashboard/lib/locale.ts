/**
 * Identificador de locale de la app ('es' | 'en') y utilidades de cookie.
 *
 * Dos niveles deliberados (design i18n-dashboard, Decision 2):
 * - Identificador de app ('es'/'en'): viaja en la cookie NEXT_LOCALE, en
 *   users.locale / beta_signups.locale / invitations.locale y nombra los
 *   archivos de mensajes.
 * - Locale de FORMATO ('es-AR'/'en-US'): lo mapea únicamente
 *   i18n/request.ts; acá solo existe el colapso inverso (toAppLocale).
 *
 * Este módulo es puro salvo setLocaleCookie (client-only): puede importarse
 * desde server (i18n/request.ts) sin tocar document en scope de módulo.
 */

export type AppLocale = 'es' | 'en';

export const APP_LOCALES: readonly AppLocale[] = ['es', 'en'] as const;

export const DEFAULT_LOCALE: AppLocale = 'es';

/** Nombre de la cookie que toda la app (landing, /invite, /login y
 * dashboard) lee y escribe — la que i18n/request.ts consulta primero. */
export const LOCALE_COOKIE = 'NEXT_LOCALE';

/** Un año en segundos — la preferencia de idioma no expira "sola". */
const LOCALE_COOKIE_MAX_AGE = 31536000;

/** Type guard: ¿el valor es un locale soportado por la app? */
export function isAppLocale(value: unknown): value is AppLocale {
  return value === 'es' || value === 'en';
}

/**
 * Colapsa un tag BCP 47 al identificador de app: 'es-AR' -> 'es',
 * 'en-US' -> 'en', 'en' -> 'en'. Cualquier idioma no soportado (ej. 'fr')
 * cae al default 'es' — mismo default que backend y emails.
 */
export function toAppLocale(bcp47: string): AppLocale {
  const language = bcp47.toLowerCase().split('-')[0];
  return isAppLocale(language) ? language : DEFAULT_LOCALE;
}

/**
 * Lee la cookie de locale desde el cliente (client-only). Devuelve null si
 * no existe o su valor no es un locale soportado — para LocaleSync, "cookie
 * inválida" equivale a "sin cookie" (misma tolerancia que la cascada
 * server-side de i18n/request.ts).
 */
export function getLocaleCookie(): AppLocale | null {
  const match = document.cookie
    .split('; ')
    .find((entry) => entry.startsWith(`${LOCALE_COOKIE}=`));
  const value = match?.slice(LOCALE_COOKIE.length + 1);
  return isAppLocale(value) ? value : null;
}

/**
 * Escribe la cookie de locale desde el cliente. NO httpOnly a propósito:
 * la setea el navegador y es una preferencia de UI, no un secreto (a
 * diferencia de la cookie `session`, httpOnly en el backend).
 */
export function setLocaleCookie(locale: AppLocale): void {
  document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; max-age=${LOCALE_COOKIE_MAX_AGE}; SameSite=Lax`;
}

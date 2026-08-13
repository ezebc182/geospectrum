/**
 * Mapeo de los errores de login a mensajes traducidos.
 *
 * Vive en `lib/` y no en `app/login/page.tsx` porque un archivo de página
 * del App Router sólo puede exportar el default y los símbolos que Next
 * conoce (`metadata`, `generateStaticParams`, …): cualquier otro export
 * nombrado rompe el type-check de `.next/types`. Además, así el mapeo es
 * importable desde tests sin montar la página entera.
 *
 * Los códigos vienen como `?error=<código>` cuando el backend redirige a
 * `/login` tras un fallo del flujo OAuth de Google (ver `src/main.py`,
 * callback `GET /auth/google/callback`): `google_oauth_cancelled`,
 * `google_oauth_token_exchange_failed`, `google_oauth_invalid_id_token`,
 * `google_oauth_email_not_verified`, `google_no_invitation`,
 * `account_deactivated`, y cualquier `google_oauth_<valor-de-error-de-google>`
 * (ej. `access_denied`) que no matchee cae en el mensaje genérico.
 */

import type { useTranslations } from 'next-intl';

import { ApiStatusError } from './auth';

type AuthTranslator = ReturnType<typeof useTranslations<'auth'>>;

/**
 * Código con el que el backend marca una cuenta desactivada. Es el ÚNICO
 * sin prefijo `google_`: la causa no es del flujo de Google sino de la
 * cuenta, y por eso el mismo código (y el mismo copy) se reusa para el 403
 * de `POST /auth/login` por password — un solo mensaje para los dos
 * caminos (user-management, design.md Decision 5).
 */
export const ACCOUNT_DEACTIVATED_CODE = 'account_deactivated';

/** Resuelve el mensaje del código de error de OAuth en el locale ACTIVO
 * (el caller guarda el código en estado y llama a esto en el render, para
 * que un cambio de idioma en caliente re-traduzca el error visible). */
export function resolveGoogleOAuthError(code: string, t: AuthTranslator): string {
  switch (code) {
    case 'google_oauth_cancelled':
      return t('oauthErrors.cancelled');
    case 'google_oauth_token_exchange_failed':
      return t('oauthErrors.tokenExchangeFailed');
    case 'google_oauth_invalid_id_token':
      return t('oauthErrors.invalidIdToken');
    case 'google_oauth_email_not_verified':
      return t('oauthErrors.emailNotVerified');
    case 'google_no_invitation':
      return t('oauthErrors.noInvitation');
    case ACCOUNT_DEACTIVATED_CODE:
      return t('oauthErrors.accountDeactivated');
    default:
      // Cualquier otro `google_oauth_<algo>` no mapeado explícitamente
      // (ej. `google_oauth_access_denied`) es un rechazo de Google.
      return code.startsWith('google_oauth_')
        ? t('oauthErrors.googleRejected')
        : t('oauthErrors.generic');
  }
}

/**
 * Detecta el 403 por cuenta desactivada en el fallo de `POST /auth/login`
 * (login por password) y devuelve el MISMO código que usa el redirect de
 * Google, para que los dos caminos muestren idéntico copy. Cualquier otro
 * fallo devuelve `null`: el caller mantiene su propio mensaje de
 * credenciales inválidas, que NO debe ser el genérico de OAuth.
 *
 * El backend sólo responde 403 con la password YA verificada (design.md
 * Decision 3): con password incorrecta devuelve el 401 genérico, para no
 * convertir el endpoint en un oráculo de enumeración de cuentas.
 */
export function accountDeactivatedCodeFrom(err: unknown): string | null {
  return err instanceof ApiStatusError && err.status === 403 ? ACCOUNT_DEACTIVATED_CODE : null;
}

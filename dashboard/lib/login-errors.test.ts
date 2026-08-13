/**
 * Tests del mapeo de errores del login (tarea 2.7 de user-management).
 *
 * El translator se sustituye por una función que devuelve la CLAVE pedida:
 * lo que se verifica acá es a qué clave del diccionario cae cada código, no
 * el copy en sí (ese lo cubre el test de paridad ES/EN).
 */

import { describe, expect, it } from 'vitest';

import { ApiStatusError } from './auth';
import {
  ACCOUNT_DEACTIVATED_CODE,
  accountDeactivatedCodeFrom,
  resolveGoogleOAuthError,
} from './login-errors';

/** Doble del translator de next-intl: devuelve la clave tal cual. */
const t = ((key: string) => key) as unknown as Parameters<typeof resolveGoogleOAuthError>[1];

describe('resolveGoogleOAuthError', () => {
  it('mapea account_deactivated a su copy dedicado, no al genérico', () => {
    expect(resolveGoogleOAuthError(ACCOUNT_DEACTIVATED_CODE, t)).toBe(
      'oauthErrors.accountDeactivated',
    );
  });

  it('mantiene los códigos de Google preexistentes', () => {
    expect(resolveGoogleOAuthError('google_oauth_cancelled', t)).toBe('oauthErrors.cancelled');
    expect(resolveGoogleOAuthError('google_no_invitation', t)).toBe('oauthErrors.noInvitation');
  });

  it('un google_oauth_<algo> desconocido cae en el rechazo de Google', () => {
    expect(resolveGoogleOAuthError('google_oauth_access_denied', t)).toBe(
      'oauthErrors.googleRejected',
    );
  });

  it('un código totalmente desconocido cae en el genérico', () => {
    expect(resolveGoogleOAuthError('vaya-uno-a-saber', t)).toBe('oauthErrors.generic');
  });
});

describe('accountDeactivatedCodeFrom', () => {
  it('convierte el 403 del login password en el código compartido', () => {
    const err = new ApiStatusError(403, 'account deactivated');
    expect(accountDeactivatedCodeFrom(err)).toBe(ACCOUNT_DEACTIVATED_CODE);
  });

  it('el 401 de credenciales inválidas NO se confunde con desactivada', () => {
    expect(accountDeactivatedCodeFrom(new ApiStatusError(401, 'invalid credentials'))).toBeNull();
  });

  it('un error sin status (red caída) tampoco', () => {
    expect(accountDeactivatedCodeFrom(new Error('network down'))).toBeNull();
  });
});

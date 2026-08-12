'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';

import { getProfile } from '@/lib/auth';
import { getLocaleCookie, setLocaleCookie } from '@/lib/locale';

/**
 * Reconciliación users.locale → cookie (design i18n-dashboard, Decision 3),
 * montado en el layout de (app): en un dispositivo NUEVO (sin cookie
 * NEXT_LOCALE), la preferencia guardada en la cuenta decide el idioma desde
 * el primer paint post-login. Reglas:
 *
 * - Si la cookie EXISTE, no hace nada — ni siquiera pide el perfil: la
 *   elección explícita de este navegador gana sobre la preferencia de
 *   cuenta ("La cookie explícita gana sobre la preferencia de cuenta").
 * - Sin cookie, pide GET /account/profile UNA sola vez; si users.locale no
 *   es null (y la cookie sigue sin existir al resolver — el usuario pudo
 *   haber elegido en el medio), siembra la cookie y hace router.refresh().
 * - Best-effort: si el perfil falla, no pasa nada — la cascada
 *   cookie/Accept-Language/'es' de i18n/request.ts ya resolvió el idioma.
 *
 * No renderiza nada.
 */
export function LocaleSync() {
  const router = useRouter();
  // Guard de una sola corrida: sobrevive al doble-invoke de StrictMode y a
  // re-renders del layout — la reconciliación es "al hidratar sesión", no
  // un watcher permanente.
  const ranRef = React.useRef(false);

  React.useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;

    // Cookie presente (válida) = elección del dispositivo: no tocar nada.
    if (getLocaleCookie() !== null) return;

    getProfile()
      .then((profile) => {
        // Re-chequeo deliberado: si mientras respondía el perfil el usuario
        // eligió idioma (switcher escribe la cookie), su elección gana.
        if (profile.locale !== null && getLocaleCookie() === null) {
          setLocaleCookie(profile.locale);
          router.refresh();
        }
      })
      .catch(() => {
        // Sin perfil no hay reconciliación posible; la UI ya está renderizada
        // con la cascada server-side. Silencioso a propósito (best-effort).
      });
  }, [router]);

  return null;
}

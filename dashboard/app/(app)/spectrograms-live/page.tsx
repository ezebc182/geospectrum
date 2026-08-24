/**
 * Redirect de la ruta vieja.
 *
 * La pantalla se llamaba "spectrograms-live" cuando sólo mostraba señal en
 * vivo. Hoy el modo se elige por tarjeta (vivo o 24h), así que el nombre
 * comprometía la URL con un modo que ya no es el único. La ruta vieja queda
 * publicada —hay links guardados y toasts que apuntan ahí— así que redirige en
 * vez de dar 404, preservando los query params (por ejemplo ?tab=wall) para
 * no romper esos links guardados.
 *
 * Es un renombre definitivo de ruta, no algo transitorio: usamos
 * permanentRedirect (308) en vez de redirect (307) para que buscadores y
 * navegadores actualicen sus referencias.
 *
 * En Next 15 el page component recibe searchParams como Promise (mismo
 * patrón que params en app/invite/[token]/page.tsx).
 */

import { permanentRedirect } from 'next/navigation';

export default async function SpectrogramsLiveRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) query.append(key, v);
    } else {
      query.append(key, value);
    }
  }
  const queryString = query.toString();
  permanentRedirect(queryString ? `/spectrograms?${queryString}` : '/spectrograms');
}

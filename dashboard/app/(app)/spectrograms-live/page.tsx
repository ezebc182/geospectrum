/**
 * Redirect de la ruta vieja.
 *
 * La pantalla se llamaba "spectrograms-live" cuando sólo mostraba señal en
 * vivo. Hoy el modo se elige por tarjeta (vivo o 24h), así que el nombre
 * comprometía la URL con un modo que ya no es el único. La ruta vieja queda
 * publicada —hay links guardados y toasts que apuntan ahí— así que redirige en
 * vez de dar 404.
 */

import { redirect } from 'next/navigation';

export default function SpectrogramsLiveRedirect() {
  redirect('/spectrograms');
}

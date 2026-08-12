import { redirect } from 'next/navigation';

/**
 * Ruta legada: la administración de beta testers vive ahora en la pestaña
 * "Lista de espera" de /admin/access (unificación post-QA). Se mantiene el
 * redirect para bookmarks y links viejos.
 */
export default function BetaRedirect() {
  redirect('/admin/access?tab=waitlist');
}

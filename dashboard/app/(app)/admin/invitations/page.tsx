import { redirect } from 'next/navigation';

/**
 * Ruta legada: la gestión de invitaciones vive ahora en la pestaña
 * "Invitaciones" de /admin/access (unificación post-QA). Se mantiene el
 * redirect para bookmarks y links viejos.
 */
export default function InvitationsRedirect() {
  redirect('/admin/access?tab=invitations');
}

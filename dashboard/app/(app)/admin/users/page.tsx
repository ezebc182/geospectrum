import { redirect } from 'next/navigation';

/**
 * La gestión de usuarios vive como pestaña "Usuarios" de /admin/access
 * (user-management, design.md Decision 7): es la tercera etapa del mismo
 * embudo que la lista de espera y las invitaciones, no una sección aparte.
 *
 * Esta ruta existe igual porque /admin/users es la URL que la gente tipea
 * — mismo patrón de redirect que /beta y /admin/invitations.
 */
export default function UsersRedirect() {
  redirect('/admin/access?tab=users');
}

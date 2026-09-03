'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import {
  Activity,
  Antenna,
  Compass,
  Gauge,
  Globe2,
  LineChart,
  MessageSquare,
  MessageSquarePlus,
  RadioTower,
  UserCheck,
} from 'lucide-react';

import { FeedbackWidget } from '@/components/feedback/FeedbackWidget';
import { LiveIndicator } from '@/components/LiveIndicator';
import { useAuth } from '@/hooks/use-auth';
import { useLiveEvents } from '@/hooks/use-live-events';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';

interface NavRoute {
  href: string;
  label: string;
  icon: typeof Gauge;
  /** Ancla del tour de onboarding (Decision 7 de email-invitations):
   * atributo semántico propio sobre el elemento real, nunca clases CSS. */
  tourId?: string;
}

const ADMIN_ROLES = ['admin', 'superadmin'];

export function AppSidebar() {
  const pathname = usePathname();
  const { user } = useAuth();
  const t = useTranslations('nav');
  const tFeedback = useTranslations('feedback.widget');
  // Disparador del reporte: vive acá (base del sidebar) en vez de un botón
  // flotante propio del widget, que ahora es controlado desde afuera.
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  // Estado del stream compartido con la cartelera del globo. Fuera del
  // provider devuelve 'offline' en vez de romper (ver useLiveEvents).
  const { status: liveStatus } = useLiveEvents();
  const isAdmin = user !== null && ADMIN_ROLES.includes(user.role);

  // Labels resueltas por hook dentro del componente (design, Decision 5:
  // t() vive en componentes, nunca en constantes de módulo).
  const routes: NavRoute[] = [
    { href: '/', label: t('dashboard'), icon: Gauge },
    { href: '/explore', label: t('explore'), icon: Compass },
    { href: '/spectrograms', label: t('spectrograms'), icon: RadioTower },
    { href: '/stations', label: t('stations'), icon: Antenna },
    { href: '/globe', label: t('globe'), icon: Globe2, tourId: 'nav-globe' },
    { href: '/analytics', label: t('analytics'), icon: LineChart },
    // Tablero de feedback: para TODOS los autenticados (lo que cambia por rol
    // es la interactividad, no la visibilidad) — por eso NO va en adminRoutes.
    { href: '/feedback', label: t('feedback'), icon: MessageSquare },
  ];

  // Rutas de administración: sólo visibles para admin+. El gate real de
  // permisos vive en el backend (require_min_role); esto es no mostrar
  // puertas que la API va a cerrar igual. "Accesos" unifica lista de espera
  // e invitaciones en una sola página con pestañas (pulido post-QA).
  const adminRoutes: NavRoute[] = [{ href: '/admin/access', label: t('access'), icon: UserCheck }];

  /** La entrada queda marcada también en las subrutas (`/stations/CI.USC..BHZ`
   *  mantiene "Estaciones" activo). La comparación exacta se conserva para `/`,
   *  que si no quedaría activa en toda la app. */
  const isRouteActive = (href: string) =>
    href === '/' ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <div className="flex items-center gap-2 px-2 py-1.5">
          <Activity className="h-5 w-5 shrink-0 text-sidebar-primary" />
          <span className="font-heading text-sm font-semibold tracking-tight text-sidebar-foreground group-data-[collapsible=icon]:hidden">
            GeoSpectrum
          </span>
        </div>
        {/* Estado del stream de eventos (PR-W4). Va en el header y no en un
            grupo propio para que el punto siga visible con el sidebar
            colapsado; el texto se oculta con la misma utilidad de grupo que
            usa "GeoSpectrum" arriba, y el title del indicador lo cubre. */}
        <div className="px-2 pb-1.5">
          <LiveIndicator
            status={liveStatus}
            className="group-data-[collapsible=icon]:justify-center"
            labelClassName="group-data-[collapsible=icon]:hidden"
          />
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>{t('groupMonitoring')}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {routes.map((route) => (
                <SidebarMenuItem key={route.href}>
                  <SidebarMenuButton asChild isActive={isRouteActive(route.href)} tooltip={route.label}>
                    <Link href={route.href} data-tour-id={route.tourId}>
                      <route.icon />
                      <span>{route.label}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {isAdmin && (
          <SidebarGroup>
            <SidebarGroupLabel>{t('groupAdmin')}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {adminRoutes.map((route) => (
                  <SidebarMenuItem key={route.href}>
                    <SidebarMenuButton
                      asChild
                      isActive={isRouteActive(route.href)}
                      tooltip={route.label}
                    >
                      <Link href={route.href}>
                        <route.icon />
                        <span>{route.label}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={() => setFeedbackOpen(true)}
              tooltip={tFeedback('button')}
              className="bg-sidebar-primary text-sidebar-primary-foreground hover:bg-sidebar-primary/90 hover:text-sidebar-primary-foreground active:bg-sidebar-primary/90 active:text-sidebar-primary-foreground"
            >
              <MessageSquarePlus />
              <span>{tFeedback('button')}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <FeedbackWidget open={feedbackOpen} onOpenChange={setFeedbackOpen} />
    </Sidebar>
  );
}

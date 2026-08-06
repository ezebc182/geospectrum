'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Activity,
  Compass,
  Gauge,
  Globe2,
  LineChart,
  RadioTower,
  UserCheck,
} from 'lucide-react';

import { useAuth } from '@/hooks/use-auth';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';

const routes = [
  { href: '/', label: 'Dashboard', icon: Gauge },
  { href: '/explore', label: 'Explorador', icon: Compass },
  { href: '/spectrograms-live', label: 'Espectrogramas', icon: RadioTower },
  { href: '/globe', label: 'Globo 3D', icon: Globe2 },
  { href: '/analytics', label: 'Análisis', icon: LineChart },
];

// Rutas de administración: sólo visibles para admin+. El gate real de
// permisos vive en el backend (require_min_role); esto es no mostrar
// puertas que la API va a cerrar igual.
const ADMIN_ROUTES = [{ href: '/beta', label: 'Beta testers', icon: UserCheck }];
const ADMIN_ROLES = ['admin', 'superadmin'];

export function AppSidebar() {
  const pathname = usePathname();
  const { user } = useAuth();
  const isAdmin = user !== null && ADMIN_ROLES.includes(user.role);

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <div className="flex items-center gap-2 px-2 py-1.5">
          <Activity className="h-5 w-5 shrink-0 text-sidebar-primary" />
          <span className="font-heading text-sm font-semibold tracking-tight text-sidebar-foreground group-data-[collapsible=icon]:hidden">
            GeoSpectrum
          </span>
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Monitoreo</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {routes.map((route) => (
                <SidebarMenuItem key={route.href}>
                  <SidebarMenuButton asChild isActive={pathname === route.href} tooltip={route.label}>
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

        {isAdmin && (
          <SidebarGroup>
            <SidebarGroupLabel>Administración</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {ADMIN_ROUTES.map((route) => (
                  <SidebarMenuItem key={route.href}>
                    <SidebarMenuButton
                      asChild
                      isActive={pathname === route.href}
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
    </Sidebar>
  );
}

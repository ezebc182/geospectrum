import { AppSidebar } from '@/components/AppSidebar';
import { AreaHeader } from '@/components/AreaHeader';
import { StationQuickSearch } from '@/components/StationQuickSearch';
import { LocaleSwitcher } from '@/components/LocaleSwitcher';
import { LocaleSync } from '@/components/LocaleSync';
import { NotificationBell } from '@/components/NotificationBell';
import { OnboardingGate } from '@/components/onboarding/OnboardingGate';
import { UserMenu } from '@/components/UserMenu';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { Separator } from '@/components/ui/separator';
import { LiveEventsProvider } from '@/hooks/use-live-events';

export default function AppShellLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // El stream de eventos (PR-W4) va acá y no dentro de cada consumidor: cada
    // useEventStream() abre SU propio WebSocket, y el sidebar y la cartelera
    // del globo necesitan el mismo. Cubre a los dos aunque el overlay se monte
    // por portal a document.body — el portal mueve el DOM, no el árbol React.
    <LiveEventsProvider>
    <SidebarProvider>
      {/* Reconciliación users.locale → cookie en dispositivos sin cookie
          (Decision 3): corre una vez al hidratar la sesión, no renderiza. */}
      <LocaleSync />
      <AppSidebar />
      <SidebarInset>
        <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border px-4">
          <div className="flex items-center gap-2">
            <SidebarTrigger />
            <Separator orientation="vertical" className="h-5" />
            <AreaHeader />
            {/* Salto rápido entre estaciones, a mano como el área: pedido
                del 2026-08-26. Filtra el catálogo local; la búsqueda FDSN
                completa sigue en /stations. */}
            <StationQuickSearch />
          </div>
          <div className="flex items-center gap-2">
            {/* Acceso rápido al idioma, visible en toda la app autenticada
                (spec "Selector de idioma en el header y en Settings"). */}
            <LocaleSwitcher />
            <NotificationBell />
            <UserMenu />
          </div>
        </header>
        {/* min-w-0: sin esto, un hijo ancho (el tablero kanban de /feedback,
            una tabla, lo que sea) fuerza a este flex item a crecer con su
            contenido en vez de respetar el overflow-x-auto que ya tenga
            adentro — y arrastra consigo al header de arriba, que vive en el
            mismo contenedor flex. min-width:auto es el default de flexbox,
            no cero; hay que pedirlo explícito. */}
        <main className="min-w-0 flex-1 px-4 py-8 sm:px-6 lg:px-8">{children}</main>
        {/* Wizard de onboarding del primer login: se renderiza solo si
            /auth/me trae onboarding_completed_at null. Vive en el layout
            porque las anclas del tour (sidebar, header) también viven acá. */}
        <OnboardingGate />
      </SidebarInset>
    </SidebarProvider>
    </LiveEventsProvider>
  );
}

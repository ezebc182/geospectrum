import { AppSidebar } from '@/components/AppSidebar';
import { AreaHeader } from '@/components/AreaHeader';
import { NotificationBell } from '@/components/NotificationBell';
import { OnboardingGate } from '@/components/onboarding/OnboardingGate';
import { UserMenu } from '@/components/UserMenu';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { Separator } from '@/components/ui/separator';

export default function AppShellLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border px-4">
          <div className="flex items-center gap-2">
            <SidebarTrigger />
            <Separator orientation="vertical" className="h-5" />
            <AreaHeader />
          </div>
          <div className="flex items-center gap-2">
            <NotificationBell />
            <UserMenu />
          </div>
        </header>
        <main className="flex-1 px-4 py-8 sm:px-6 lg:px-8">{children}</main>
        {/* Wizard de onboarding del primer login: se renderiza solo si
            /auth/me trae onboarding_completed_at null. Vive en el layout
            porque las anclas del tour (sidebar, header) también viven acá. */}
        <OnboardingGate />
      </SidebarInset>
    </SidebarProvider>
  );
}

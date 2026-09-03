/**
 * Tests del sidebar (tarea 4.8 del change feedback-beta-testers): la entrada
 * "Feedback" vive en `routes` (para TODOS) y NO en `adminRoutes`. El caso
 * positivo con un `viewer` es la aserción que una mutación "mover a
 * adminRoutes" haría fallar; el de `/admin/access` fija el contraste.
 *
 * Mocks con la MISMA referencia siempre (`authState` se muta): un mock de
 * hook inestable cuelga los tests (lección del repo). `useIsMobile` se
 * mockea porque jsdom no trae `matchMedia`.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import es from '@/messages/es.json';
import type { UserPublic } from '@/lib/types';
import { SidebarProvider } from '@/components/ui/sidebar';
import { TooltipProvider } from '@/components/ui/tooltip';

import { AppSidebar } from './AppSidebar';

const N = es.nav;

const { authState, liveState } = vi.hoisted(() => ({
  authState: { user: null as UserPublic | null },
  liveState: { status: 'offline' as const },
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
}));

vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => authState,
}));

vi.mock('@/hooks/use-live-events', () => ({
  useLiveEvents: () => liveState,
}));

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => false,
}));

function renderSidebar(role: UserPublic['role']) {
  authState.user = { id: 'u1', email: 'yo@example.com', role };
  render(
    <NextIntlClientProvider locale="es-AR" messages={es}>
      <TooltipProvider>
        <SidebarProvider>
          <AppSidebar />
        </SidebarProvider>
      </TooltipProvider>
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe('AppSidebar — entrada Feedback para todos', () => {
  it('un viewer ve "Feedback" apuntando a /feedback, pero no "Accesos"', () => {
    renderSidebar('viewer');
    const link = screen.getByRole('link', { name: N.feedback });
    expect(link).toHaveAttribute('href', '/feedback');
    expect(screen.queryByRole('link', { name: N.access })).toBeNull();
  });

  it('un moderador también la ve', () => {
    renderSidebar('moderador');
    expect(screen.getByRole('link', { name: N.feedback })).toHaveAttribute('href', '/feedback');
  });

  it('un admin ve "Feedback" en Monitoreo y "Accesos" en Administración', () => {
    renderSidebar('admin');
    expect(screen.getByRole('link', { name: N.feedback })).toHaveAttribute('href', '/feedback');
    expect(screen.getByRole('link', { name: N.access })).toHaveAttribute('href', '/admin/access');
    // Feedback NO está en el grupo de administración.
    const adminGroupLabel = screen.getByText(N.groupAdmin);
    const adminGroup = adminGroupLabel.closest('[data-slot="sidebar-group"]') ?? adminGroupLabel.parentElement;
    expect(adminGroup).not.toBeNull();
    expect(adminGroup).not.toHaveTextContent(N.feedback);
    expect(adminGroup).toHaveTextContent(N.access);
  });
});

describe('AppSidebar — disparador de reporte en la base', () => {
  it('el botón destacado del footer abre el diálogo de FeedbackWidget', () => {
    renderSidebar('viewer');
    const F = es.feedback.widget;
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: F.button }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

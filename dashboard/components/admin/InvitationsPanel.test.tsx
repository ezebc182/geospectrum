/**
 * Tests de componente del InvitationsPanel (tarea 5.11 de role-management).
 *
 * Cubren SÓLO el filtro de roles otorgables del formulario de invitación, que
 * este change endureció de `<=` a `<` con UNA excepción deliberada (decisión
 * 9): un superadmin SÍ puede invitar a otro superadmin, porque es la única
 * puerta legítima para nombrar un segundo superadmin sin un UPDATE a mano
 * contra producción. Un superadmin NO puede, en cambio, cambiarle el rol a
 * otro superadmin — crear un par sí, degradar un par nunca.
 *
 * Mismo patrón que UsersPanel.test: `@/lib/auth` mockeado entero (el panel no
 * le pega a la red), `useAuth` mockeado para controlar el rol del actor, y SWR
 * con caché nueva por test para que no sobreviva entre casos.
 */

import * as React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { IntlTestProvider } from '@/lib/test-intl';
import { SWRConfig } from 'swr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import es from '@/messages/es.json';
import type { UserPublic } from '@/lib/types';

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth');
  return {
    ApiStatusError: actual.ApiStatusError,
    listInvitations: vi.fn(),
    createInvitation: vi.fn(),
    resendInvitation: vi.fn(),
    revokeInvitation: vi.fn(),
    sendInvitationEmail: vi.fn(),
  };
});

const mockedUseAuth = vi.fn();
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => mockedUseAuth(),
}));

import { listInvitations } from '@/lib/auth';

import { InvitationsPanel } from './InvitationsPanel';

const mockedListInvitations = vi.mocked(listInvitations);

const ADMIN_ACTOR: UserPublic = {
  id: 'actor-admin',
  email: 'admin@geospectrum.org',
  role: 'admin',
};

const SUPERADMIN_ACTOR: UserPublic = {
  id: 'actor-superadmin',
  email: 'boss@geospectrum.org',
  role: 'superadmin',
};

function renderPanel() {
  mockedListInvitations.mockResolvedValue([]);
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <IntlTestProvider>
        <InvitationsPanel />
      </IntlTestProvider>
    </SWRConfig>,
  );
}

/** Etiquetas visibles del selector de rol del formulario de invitación. */
function roleOptionLabels(): string[] {
  const select = document.getElementById('invitation-role') as HTMLSelectElement;
  return Array.from(select.options).map((option) => option.textContent ?? '');
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedUseAuth.mockReturnValue({ user: ADMIN_ACTOR });
});

afterEach(() => {
  cleanup();
});

describe('InvitationsPanel — roles otorgables al invitar', () => {
  it('un admin ya NO ve "admin" entre las opciones', async () => {
    renderPanel();
    await waitFor(() => {
      expect(document.getElementById('invitation-role')).toBeTruthy();
    });

    expect(roleOptionLabels().sort()).toEqual(['Moderador', 'Observador']);
  });

  it('un superadmin SÍ ve "superadmin" (excepción de la decisión 9)', async () => {
    mockedUseAuth.mockReturnValue({ user: SUPERADMIN_ACTOR });
    renderPanel();
    await waitFor(() => {
      expect(document.getElementById('invitation-role')).toBeTruthy();
    });

    expect(roleOptionLabels().sort()).toEqual([
      'Administrador',
      'Moderador',
      'Observador',
      'Superadmin',
    ]);
  });

  it('el rol preseleccionado pertenece al conjunto ofrecido', async () => {
    renderPanel();
    await waitFor(() => {
      expect(document.getElementById('invitation-role')).toBeTruthy();
    });

    // Si el default quedara fuera del conjunto, el submit mandaría un rol que
    // el backend rechaza con 403 sin que el usuario haya elegido nada.
    const select = document.getElementById('invitation-role') as HTMLSelectElement;
    const values = Array.from(select.options).map((option) => option.value);
    expect(values).toContain(select.value);
    expect(screen.getByRole('button', { name: 'Invitar' })).toBeTruthy();
  });
});

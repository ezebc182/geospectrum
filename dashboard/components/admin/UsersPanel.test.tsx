/**
 * Tests de componente del UsersPanel (tarea 2.8 de user-management).
 *
 * Lo que se verifica es el CONTRATO de la pantalla, no el estilo:
 * confirmar dispara la llamada, cancelar NO la dispara, los deshabilitados
 * por self y por jerarquía (con su explicación accesible), y que un error
 * del backend se muestre traducido sin romper la lista.
 *
 * `@/lib/auth` se mockea entero (mismo patrón que OnboardingWizard.test):
 * el panel no debe pegarle a la red. `useAuth` se mockea para controlar
 * quién es el actor — su rol es lo que define qué filas quedan bloqueadas.
 *
 * SWR se envuelve en un provider con caché nueva por test: sin eso, la
 * caché de módulo sobrevive entre tests y el segundo render ve datos viejos.
 */

import * as React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { SWRConfig } from 'swr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import en from '@/messages/en.json';
import es from '@/messages/es.json';
import type { UserListItem, UserPublic } from '@/lib/types';

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth');
  return {
    // ApiStatusError es real: el mapeo de status a copy depende de que el
    // instanceof funcione, y un doble de mentira lo volvería un test ciego.
    ApiStatusError: actual.ApiStatusError,
    listUsers: vi.fn(),
    deactivateUser: vi.fn(),
    reactivateUser: vi.fn(),
  };
});

const mockedUseAuth = vi.fn();
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => mockedUseAuth(),
}));

import { ApiStatusError, deactivateUser, listUsers, reactivateUser } from '@/lib/auth';

import { UsersPanel } from './UsersPanel';

const mockedListUsers = vi.mocked(listUsers);
const mockedDeactivateUser = vi.mocked(deactivateUser);
const mockedReactivateUser = vi.mocked(reactivateUser);

const ADMIN_ACTOR: UserPublic = {
  id: 'actor-admin',
  email: 'admin@geospectrum.org',
  role: 'admin',
};

function buildUser(overrides: Partial<UserListItem> = {}): UserListItem {
  return {
    id: 'user-viewer',
    email: 'viewer@example.com',
    role: 'viewer',
    name: null,
    avatar_url: null,
    has_google: true,
    has_password: false,
    created_at: '2026-08-01T10:00:00Z',
    deactivated_at: null,
    ...overrides,
  };
}

function renderPanel(users: UserListItem[], messages: typeof es = es, locale = 'es-AR') {
  mockedListUsers.mockResolvedValue(users);
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      {/* timeZone explícito: sin él next-intl avisa por cada fecha
          formateada y el output del test se vuelve ilegible. */}
      <NextIntlClientProvider locale={locale} messages={messages} timeZone="UTC">
        <UsersPanel />
      </NextIntlClientProvider>
    </SWRConfig>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedUseAuth.mockReturnValue({ user: ADMIN_ACTOR });
});

afterEach(() => {
  cleanup();
});

describe('UsersPanel — confirmación de desactivación', () => {
  it('confirmar en el diálogo dispara POST deactivate', async () => {
    mockedDeactivateUser.mockResolvedValue(undefined);
    renderPanel([buildUser()]);

    fireEvent.click(await screen.findByRole('button', { name: 'Desactivar' }));

    // El diálogo abierto nombra a QUÉ cuenta afecta.
    expect(await screen.findByText('¿Desactivar la cuenta?')).toBeTruthy();
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).toContain('viewer@example.com');

    // El botón de confirmar del footer, no el trigger de la fila.
    const confirm = screen
      .getAllByRole('button', { name: 'Desactivar' })
      .find((button) => button.textContent === 'Desactivar' && button.closest('[role="alertdialog"]'));
    fireEvent.click(confirm as HTMLElement);

    await waitFor(() => {
      expect(mockedDeactivateUser).toHaveBeenCalledWith('user-viewer');
    });
  });

  it('cancelar NO dispara ninguna llamada a la API', async () => {
    renderPanel([buildUser()]);

    fireEvent.click(await screen.findByRole('button', { name: 'Desactivar' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancelar' }));

    await waitFor(() => {
      expect(screen.queryByText('¿Desactivar la cuenta?')).toBeNull();
    });
    expect(mockedDeactivateUser).not.toHaveBeenCalled();
  });

  it('reactivar es directo: sin diálogo de confirmación', async () => {
    mockedReactivateUser.mockResolvedValue(undefined);
    renderPanel([buildUser({ deactivated_at: '2026-08-10T12:00:00Z' })]);

    fireEvent.click(await screen.findByRole('button', { name: 'Reactivar' }));

    await waitFor(() => {
      expect(mockedReactivateUser).toHaveBeenCalledWith('user-viewer');
    });
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});

describe('UsersPanel — guards de jerarquía reflejados en la UI', () => {
  it('deshabilita la acción sobre la propia cuenta, con la razón accesible', async () => {
    renderPanel([
      buildUser({ id: ADMIN_ACTOR.id, email: ADMIN_ACTOR.email, role: 'admin' }),
    ]);

    const button = await screen.findByRole('button', { name: 'Desactivar' });
    expect((button as HTMLButtonElement).disabled).toBe(true);

    // La explicación no es solo el gris: viaja en title y en el elemento
    // asociado por aria-describedby.
    expect(button.getAttribute('title')).toBe('No podés desactivar tu propia cuenta.');
    const describedBy = button.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy as string)?.textContent).toBe(
      'No podés desactivar tu propia cuenta.',
    );
  });

  it('deshabilita la acción de un admin sobre otro admin (rol igual)', async () => {
    renderPanel([buildUser({ id: 'other-admin', email: 'otro@example.com', role: 'admin' })]);

    const button = await screen.findByRole('button', { name: 'Desactivar' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute('title')).toBe(
      'No podés gestionar una cuenta con un rol igual o superior al tuyo.',
    );
  });

  it('deshabilita la acción de un admin sobre un superadmin (rol superior)', async () => {
    renderPanel([buildUser({ id: 'boss', email: 'boss@example.com', role: 'superadmin' })]);

    const button = await screen.findByRole('button', { name: 'Desactivar' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it('habilita la acción sobre un rol estrictamente menor', async () => {
    renderPanel([buildUser({ role: 'moderador' })]);

    const button = await screen.findByRole('button', { name: 'Desactivar' });
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('UsersPanel — errores del backend', () => {
  it('traduce el 403 de jerarquía y deja la lista utilizable', async () => {
    mockedDeactivateUser.mockRejectedValue(
      new ApiStatusError(403, 'cannot manage a user with an equal or higher role'),
    );
    renderPanel([buildUser()]);

    fireEvent.click(await screen.findByRole('button', { name: 'Desactivar' }));
    const confirm = screen
      .getAllByRole('button', { name: 'Desactivar' })
      .find((button) => button.closest('[role="alertdialog"]'));
    fireEvent.click(confirm as HTMLElement);

    expect(
      await screen.findByText('No podés gestionar una cuenta con un rol igual o superior al tuyo.'),
    ).toBeTruthy();
    // La lista sigue en pantalla: el error no la reemplaza.
    expect(screen.getByRole('list').textContent).toContain('viewer@example.com');
  });

  it('distingue el 409 de auto-gestión del 409 de estado ya alcanzado', async () => {
    mockedReactivateUser.mockRejectedValue(new ApiStatusError(409, 'user is not deactivated'));
    renderPanel([buildUser({ deactivated_at: '2026-08-10T12:00:00Z' })]);

    fireEvent.click(await screen.findByRole('button', { name: 'Reactivar' }));

    expect(
      await screen.findByText('Esa cuenta ya está en ese estado. Actualizá el listado.'),
    ).toBeTruthy();
  });

  it('traduce el 404 de cuenta inexistente', async () => {
    mockedReactivateUser.mockRejectedValue(new ApiStatusError(404, 'user not found'));
    renderPanel([buildUser({ deactivated_at: '2026-08-10T12:00:00Z' })]);

    fireEvent.click(await screen.findByRole('button', { name: 'Reactivar' }));

    expect(
      await screen.findByText('Esa cuenta ya no existe. Actualizá el listado.'),
    ).toBeTruthy();
  });

  it('un fallo sin status cae al mensaje genérico con el email interpolado', async () => {
    mockedDeactivateUser.mockRejectedValue(new Error('network down'));
    renderPanel([buildUser()]);

    fireEvent.click(await screen.findByRole('button', { name: 'Desactivar' }));
    const confirm = screen
      .getAllByRole('button', { name: 'Desactivar' })
      .find((button) => button.closest('[role="alertdialog"]'));
    fireEvent.click(confirm as HTMLElement);

    expect(
      await screen.findByText(
        'No se pudo desactivar la cuenta de viewer@example.com. Intentá de nuevo en unos segundos.',
      ),
    ).toBeTruthy();
  });

  it('muestra el error de carga cuando el listado falla', async () => {
    mockedListUsers.mockRejectedValue(new ApiStatusError(500, 'boom'));
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
        <NextIntlClientProvider locale="es-AR" messages={es} timeZone="UTC">
          <UsersPanel />
        </NextIntlClientProvider>
      </SWRConfig>,
    );

    expect(
      await screen.findByText('No se pudo cargar el listado. Verificá tu sesión e intentá de nuevo.'),
    ).toBeTruthy();
  });
});

describe('UsersPanel — i18n', () => {
  it('renderiza estados y acciones en inglés con el mismo dataset', async () => {
    renderPanel([buildUser({ deactivated_at: '2026-08-10T12:00:00Z' })], en, 'en-US');

    expect(await screen.findByText('Deactivated')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reactivate' })).toBeTruthy();
  });

  it('muestra la razón de deshabilitado en inglés', async () => {
    renderPanel(
      [buildUser({ id: ADMIN_ACTOR.id, email: ADMIN_ACTOR.email, role: 'admin' })],
      en,
      'en-US',
    );

    const button = await screen.findByRole('button', { name: 'Deactivate' });
    expect(button.getAttribute('title')).toBe('You cannot deactivate your own account.');
  });
});

/**
 * Tests de componente del LocaleSwitcher (tarea 2.8 de i18n-dashboard):
 * escribe la cookie NEXT_LOCALE + router.refresh(); con sesión dispara el
 * PATCH de perfil best-effort; sin sesión NO llama a ninguna API de cuenta.
 *
 * Se mockea `@/lib/auth` (la capa fetch, mismo patrón que
 * app/invite/[token]/page.test.tsx) y `@/hooks/use-auth` (el switcher solo
 * lee `user` para decidir si persiste en cuenta).
 */

import * as React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
// El hook useToast exige el provider: montar un componente que notifica
// sin él tira a propósito, para que el fallo se vea en el test y no en prod.
import { ToastProvider } from '@/components/ui/toast';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import es from '@/messages/es.json';
import type { UserPublic } from '@/lib/types';

const { refreshMock, useAuthMock } = vi.hoisted(() => ({
  refreshMock: vi.fn(),
  useAuthMock: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: refreshMock, push: vi.fn() }),
}));

vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => useAuthMock(),
}));

vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return { ...actual, updateProfile: vi.fn() };
});

import { updateProfile } from '@/lib/auth';

import { LocaleSwitcher } from './LocaleSwitcher';

const mockedUpdateProfile = vi.mocked(updateProfile);

const USER: UserPublic = {
  id: 'u1',
  email: 'ana@example.com',
  name: 'Ana',
  role: 'viewer',
  avatar_url: null,
};

function renderSwitcher(user: UserPublic | null) {
  useAuthMock.mockReturnValue({ user });
  render(
    <NextIntlClientProvider locale="es-AR" messages={es}>
      <ToastProvider>
        <LocaleSwitcher />
    </ToastProvider>
    </NextIntlClientProvider>,
  );
}

/** Abre el dropdown de Radix (responde a keydown Enter en jsdom, donde no
 * hay PointerEvent real) y devuelve el item del idioma pedido. */
function openAndGetOption(name: string): HTMLElement {
  const trigger = screen.getByRole('button', { name: 'Idioma' });
  fireEvent.keyDown(trigger, { key: 'Enter' });
  return screen.getByText(name);
}

beforeEach(() => {
  // Cookie limpia entre tests: jsdom conserva document.cookie por archivo.
  document.cookie = 'NEXT_LOCALE=; path=/; max-age=0';
  mockedUpdateProfile.mockResolvedValue({
    full_name: null,
    address: null,
    phone: null,
    locale: 'en',
    totp_enabled: false,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('LocaleSwitcher — cambio de idioma', () => {
  it('escribe la cookie NEXT_LOCALE y llama router.refresh()', () => {
    renderSwitcher(null);

    fireEvent.click(openAndGetOption('English'));

    expect(document.cookie).toContain('NEXT_LOCALE=en');
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it('con sesión dispara el PATCH best-effort con el locale nuevo', async () => {
    renderSwitcher(USER);

    fireEvent.click(openAndGetOption('English'));

    await waitFor(() => {
      expect(mockedUpdateProfile).toHaveBeenCalledWith({ locale: 'en' });
    });
    expect(document.cookie).toContain('NEXT_LOCALE=en');
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it('sin sesión NO llama a ninguna API de cuenta', () => {
    renderSwitcher(null);

    fireEvent.click(openAndGetOption('English'));

    expect(mockedUpdateProfile).not.toHaveBeenCalled();
  });

  it('la falla del PATCH no bloquea el cambio visual (cookie y refresh igual)', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockedUpdateProfile.mockRejectedValue(new Error('backend caído'));
    renderSwitcher(USER);

    fireEvent.click(openAndGetOption('English'));

    expect(document.cookie).toContain('NEXT_LOCALE=en');
    expect(refreshMock).toHaveBeenCalledTimes(1);
    // La falla se loguea (no se silencia) y no revienta el componente.
    await waitFor(() => {
      expect(consoleError).toHaveBeenCalled();
    });
    consoleError.mockRestore();
  });

  it('elegir el idioma ya activo es un no-op (ni cookie ni refresh ni PATCH)', () => {
    renderSwitcher(USER);

    fireEvent.click(openAndGetOption('Español'));

    expect(document.cookie).not.toContain('NEXT_LOCALE=es');
    expect(refreshMock).not.toHaveBeenCalled();
    expect(mockedUpdateProfile).not.toHaveBeenCalled();
  });
});

/**
 * Tests del toggle de tema del UserMenu.
 *
 * El bug que motivó estos tests: el componente decidía con `theme`, que con
 * `enableSystem` vale 'system' hasta que el usuario elige explícitamente. Con
 * el SO en oscuro la pantalla se ve oscura pero `theme === 'dark'` da false,
 * así que el primer clic pedía 'dark' —lo que ya estaba— y no pasaba nada
 * visible. La etiqueta sufría lo mismo: decía "Modo oscuro" estando oscuro.
 *
 * La respuesta correcta es `resolvedTheme`, que next-themes garantiza que sea
 * siempre 'dark' o 'light', nunca 'system'.
 */

import * as React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import es from '@/messages/es.json';
import type { UserPublic } from '@/lib/types';

const { setThemeMock, useThemeMock, useAuthMock, pushMock } = vi.hoisted(() => ({
  setThemeMock: vi.fn(),
  useThemeMock: vi.fn(),
  useAuthMock: vi.fn(),
  pushMock: vi.fn(),
}));

// La identidad del objeto que devuelve useRouter tiene que ser estable entre
// renders: un objeto nuevo por render puede colgar el test (ver la trampa ya
// documentada en el proyecto con mocks de router inestables).
const ROUTER = { push: pushMock, refresh: vi.fn() };

vi.mock('next/navigation', () => ({
  useRouter: () => ROUTER,
}));

vi.mock('next-themes', () => ({
  useTheme: () => useThemeMock(),
}));

vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => useAuthMock(),
}));

import { UserMenu } from './UserMenu';

const USER: UserPublic = {
  id: 'u1',
  email: 'ana@example.com',
  name: 'Ana',
  role: 'viewer',
} as UserPublic;

/**
 * Monta el menú con el dropdown ya abierto. Radix sólo renderiza el contenido
 * después de activar el trigger, así que el clic es parte del arranque.
 */
function renderOpenMenu() {
  render(
    <NextIntlClientProvider locale="es" messages={es}>
      <UserMenu />
    </NextIntlClientProvider>
  );

  // Radix no abre el menú con un click sintético (escucha eventos de puntero,
  // que jsdom no emite). La tecla Enter sobre el trigger sí lo abre.
  fireEvent.keyDown(screen.getByRole('button'), { key: 'Enter' });
}

beforeEach(() => {
  vi.clearAllMocks();
  useAuthMock.mockReturnValue({ user: USER, logout: vi.fn() });
});

afterEach(cleanup);

describe('UserMenu — toggle de tema', () => {
  it('pasa a claro cuando el sistema resolvió oscuro y el usuario nunca eligió', () => {
    // El caso que rompía: theme='system' (nadie eligió todavía) pero la
    // pantalla se ve oscura porque el SO está en oscuro.
    useThemeMock.mockReturnValue({
      theme: 'system',
      resolvedTheme: 'dark',
      setTheme: setThemeMock,
    });

    renderOpenMenu();
    fireEvent.click(screen.getByText(es.nav.userMenu.lightMode));

    // Decidiendo por `theme` esto pedía 'dark' —lo que ya estaba— y el clic
    // no producía ningún cambio visible.
    expect(setThemeMock).toHaveBeenCalledWith('light');
  });

  it('ofrece "Modo claro" cuando lo resuelto es oscuro, aunque theme sea system', () => {
    // La etiqueta tiene que describir a dónde va el clic, no el string interno.
    useThemeMock.mockReturnValue({
      theme: 'system',
      resolvedTheme: 'dark',
      setTheme: setThemeMock,
    });

    renderOpenMenu();

    // `getByText` ya lanza si no encuentra el nodo; el queryBy confirma que la
    // etiqueta contraria NO está, que es la mitad que fallaba antes del fix.
    expect(screen.getByText(es.nav.userMenu.lightMode)).toBeTruthy();
    expect(screen.queryByText(es.nav.userMenu.darkMode)).toBeNull();
  });

  it('vuelve a oscuro cuando lo resuelto es claro', () => {
    useThemeMock.mockReturnValue({
      theme: 'system',
      resolvedTheme: 'light',
      setTheme: setThemeMock,
    });

    renderOpenMenu();
    fireEvent.click(screen.getByText(es.nav.userMenu.darkMode));

    expect(setThemeMock).toHaveBeenCalledWith('dark');
  });

  it('sigue funcionando con una elección explícita del usuario', () => {
    // Cuando el usuario ya eligió, theme y resolvedTheme coinciden: el
    // comportamiento no cambia respecto de antes del arreglo.
    useThemeMock.mockReturnValue({
      theme: 'dark',
      resolvedTheme: 'dark',
      setTheme: setThemeMock,
    });

    renderOpenMenu();
    fireEvent.click(screen.getByText(es.nav.userMenu.lightMode));

    expect(setThemeMock).toHaveBeenCalledWith('light');
  });
});

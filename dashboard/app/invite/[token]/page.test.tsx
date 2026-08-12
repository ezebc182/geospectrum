/**
 * Tests de la página pública de aceptación `/invite/[token]` (tarea 8.4 +
 * pulido post-QA: i18n ES/EN y UX de password).
 *
 * Se mockea el módulo `@/lib/auth` (la capa fetch), NO fetch global: es el
 * contrato que la página realmente consume, y `ApiStatusError` se conserva
 * REAL (importOriginal) porque la página decide por `instanceof` — un mock
 * de la clase rompería esa rama silenciosamente.
 *
 * La página usa `React.use(params)` (Next 15: params es Promise), así que se
 * renderiza dentro de un `<Suspense>` y se asserta con `findBy*` (async).
 *
 * OJO: el toggle de idioma (ES/EN) está SIEMPRE presente — incluso en los
 * estados de error — así que "no hay formulario" se asserta contra los
 * botones del flujo de alta, no contra "no hay ningún botón".
 */

import * as React from 'react';
import { act } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return {
    ...actual,
    validateInvitationToken: vi.fn(),
    registerWithInvitation: vi.fn(),
    login: vi.fn(),
  };
});

import { ApiStatusError, validateInvitationToken } from '@/lib/auth';
import type { InvitationValidation } from '@/lib/types';

import InvitePage from './page';

const mockedValidate = vi.mocked(validateInvitationToken);

const VALID_INVITATION: InvitationValidation = {
  email: 'invitada@example.com',
  role: 'moderador',
  // Idioma de la invitación (migración 010): validate siempre lo devuelve.
  locale: 'es',
  expires_at: '2026-08-17T12:00:00Z',
};

async function renderPage(token = 'tok_ABC123') {
  // `React.use(params)` suspende en el primer render: en React 19 el render
  // que suspende tiene que correr dentro de un `act` AWAITEADO para que la
  // promesa resuelva y el árbol real reemplace el fallback del Suspense.
  await act(async () => {
    render(
      <React.Suspense fallback={null}>
        <InvitePage params={Promise.resolve({ token })} />
      </React.Suspense>,
    );
  });
}

/** Llena password + confirmación (el submit está deshabilitado hasta que
 * coincidan) — helper para los tests del flujo de alta. */
async function fillPasswords(password: string, confirm = password) {
  fireEvent.change(await screen.findByLabelText(/elegí una contraseña/i), {
    target: { value: password },
  });
  fireEvent.change(screen.getByLabelText(/confirmar contraseña/i), {
    target: { value: confirm },
  });
}

beforeEach(() => {
  mockedValidate.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('InvitePage — token válido (200)', () => {
  beforeEach(() => {
    mockedValidate.mockResolvedValue(VALID_INVITATION);
  });

  it('muestra email y rol de la invitación, read-only', async () => {
    await renderPage();

    expect((await screen.findAllByText('invitada@example.com')).length).toBeGreaterThan(0);
    expect(screen.getByText('Moderador')).toBeDefined();
    // Read-only de verdad: sin selector de rol ni ningún control para
    // cambiarlo (el rol viene de la invitación, server-side). El único
    // select-like permitido es el toggle de idioma, que son botones.
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(document.querySelector('select')).toBeNull();
  });

  it('ofrece los dos caminos de alta: password y Google', async () => {
    await renderPage();

    expect(await screen.findByRole('button', { name: /crear cuenta y entrar/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /continuar con google/i })).toBeDefined();
    expect(screen.getByLabelText(/elegí una contraseña/i)).toBeDefined();
    expect(screen.getByLabelText(/confirmar contraseña/i)).toBeDefined();
  });

  it('valida con el token de la URL (y la validación no consume: solo GET validate)', async () => {
    await renderPage('tok_de_la_url');

    await screen.findAllByText('invitada@example.com');
    expect(mockedValidate).toHaveBeenCalledWith('tok_de_la_url');
  });

  it('tiene el selector de idioma ES/EN visible', async () => {
    await renderPage();

    await screen.findAllByText('invitada@example.com');
    const switcher = screen.getByRole('group', { name: /idioma/i });
    expect(switcher).toBeDefined();
    expect(screen.getByRole('button', { name: 'ES' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'EN' })).toBeDefined();
    // La invitación es locale 'es' → ES arranca activo.
    expect(screen.getByRole('button', { name: 'ES' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('cambiar a EN traduce el copy en caliente', async () => {
    await renderPage();

    await screen.findAllByText('invitada@example.com');
    fireEvent.click(screen.getByRole('button', { name: 'EN' }));

    expect(screen.getByText("You've been invited to GeoSpectrum")).toBeDefined();
    expect(screen.getByRole('button', { name: /create account and sign in/i })).toBeDefined();
    expect(screen.getByLabelText(/choose a password/i)).toBeDefined();
  });

  it('deshabilita el submit y muestra error inline si la confirmación no coincide', async () => {
    await renderPage();

    await fillPasswords('password-segura-123', 'otra-cosa-distinta');

    const submit = screen.getByRole('button', { name: /crear cuenta y entrar/i });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/las contraseñas no coinciden/i)).toBeDefined();

    // Al igualar la confirmación, el error desaparece y el submit se habilita.
    fireEvent.change(screen.getByLabelText(/confirmar contraseña/i), {
      target: { value: 'password-segura-123' },
    });
    expect(screen.queryByText(/las contraseñas no coinciden/i)).toBeNull();
    expect((submit as HTMLButtonElement).disabled).toBe(false);
  });

  it('el ojito alterna la visibilidad de las contraseñas', async () => {
    await renderPage();

    const passwordInput = await screen.findByLabelText(/elegí una contraseña/i);
    expect(passwordInput.getAttribute('type')).toBe('password');

    fireEvent.click(screen.getAllByRole('button', { name: /mostrar contraseña/i })[0]);
    expect(passwordInput.getAttribute('type')).toBe('text');
    expect(screen.getByLabelText(/confirmar contraseña/i).getAttribute('type')).toBe('text');
  });

  it('muestra el medidor de fuerza al tipear', async () => {
    await renderPage();

    const passwordInput = await screen.findByLabelText(/elegí una contraseña/i);
    fireEvent.change(passwordInput, { target: { value: 'abc' } });
    expect(screen.getByText(/fuerza/i).textContent).toMatch(/muy débil/i);

    fireEvent.change(passwordInput, { target: { value: 'Password-Larga-123!' } });
    expect(screen.getByText(/fuerza/i).textContent).toMatch(/fuerte/i);
  });
});

describe('InvitePage — invitación con locale en', () => {
  it('arranca con el copy en inglés', async () => {
    mockedValidate.mockResolvedValue({ ...VALID_INVITATION, locale: 'en' });

    await renderPage();

    expect(await screen.findByText("You've been invited to GeoSpectrum")).toBeDefined();
    expect(screen.getByRole('button', { name: /continue with google/i })).toBeDefined();
    expect(screen.getByRole('button', { name: 'EN' }).getAttribute('aria-pressed')).toBe('true');
    // El rol también sale traducido.
    expect(screen.getByText('Moderator')).toBeDefined();
  });
});

describe('InvitePage — token desconocido (404)', () => {
  it('muestra el error y NO renderiza formulario ni botón de Google', async () => {
    mockedValidate.mockRejectedValue(new ApiStatusError(404, 'unknown invitation'));

    await renderPage();

    expect(await screen.findByText('Invitación no válida')).toBeDefined();
    expect(screen.queryByRole('button', { name: /crear cuenta/i })).toBeNull();
    expect(screen.queryByLabelText(/contraseña/i)).toBeNull();
    expect(document.querySelector('form')).toBeNull();
    expect(screen.queryByText(/google/i)).toBeNull();
  });

  it('el toggle de idioma sigue disponible y traduce el error', async () => {
    mockedValidate.mockRejectedValue(new ApiStatusError(404, 'unknown invitation'));

    await renderPage();

    await screen.findByText('Invitación no válida');
    fireEvent.click(screen.getByRole('button', { name: 'EN' }));
    expect(screen.getByText('Invalid invitation')).toBeDefined();
  });
});

describe('InvitePage — token conocido pero no pendiente (410)', () => {
  it('muestra vencida/revocada y NO renderiza formulario ni botón de Google', async () => {
    mockedValidate.mockRejectedValue(new ApiStatusError(410, 'invitation gone'));

    await renderPage();

    expect(await screen.findByText('Invitación vencida o revocada')).toBeDefined();
    expect(screen.queryByRole('button', { name: /crear cuenta/i })).toBeNull();
    expect(screen.queryByLabelText(/contraseña/i)).toBeNull();
    expect(document.querySelector('form')).toBeNull();
    expect(screen.queryByText(/google/i)).toBeNull();
  });
});

describe('InvitePage — fallo de red (sin status HTTP)', () => {
  it('muestra un error genérico sin formulario', async () => {
    mockedValidate.mockRejectedValue(new TypeError('fetch failed'));

    await renderPage();

    expect(await screen.findByText('No se pudo validar la invitación')).toBeDefined();
    expect(document.querySelector('form')).toBeNull();
  });
});

describe('InvitePage — carrera: el token muere entre validate y register', () => {
  it('un 410 en pleno submit muestra el error y pide reenvío', async () => {
    const { registerWithInvitation } = await import('@/lib/auth');
    mockedValidate.mockResolvedValue(VALID_INVITATION);
    vi.mocked(registerWithInvitation).mockRejectedValue(
      new ApiStatusError(410, 'invitation gone'),
    );

    await renderPage();
    await fillPasswords('password-segura-123');

    fireEvent.click(screen.getByRole('button', { name: /crear cuenta y entrar/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/dejó de ser válida/i);
    });
  });
});

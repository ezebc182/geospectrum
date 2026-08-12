/**
 * Tests de la página pública de aceptación `/invite/[token]` (tarea 8.4).
 *
 * Se mockea el módulo `@/lib/auth` (la capa fetch), NO fetch global: es el
 * contrato que la página realmente consume, y `ApiStatusError` se conserva
 * REAL (importOriginal) porque la página decide por `instanceof` — un mock
 * de la clase rompería esa rama silenciosamente.
 *
 * La página usa `React.use(params)` (Next 15: params es Promise), así que se
 * renderiza dentro de un `<Suspense>` y se asserta con `findBy*` (async).
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
    // cambiarlo (el rol viene de la invitación, server-side).
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(document.querySelector('select')).toBeNull();
  });

  it('ofrece los dos caminos de alta: password y Google', async () => {
    await renderPage();

    expect(await screen.findByRole('button', { name: /crear cuenta y entrar/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /continuar con google/i })).toBeDefined();
    expect(screen.getByLabelText(/elegí una contraseña/i)).toBeDefined();
  });

  it('valida con el token de la URL (y la validación no consume: solo GET validate)', async () => {
    await renderPage('tok_de_la_url');

    await screen.findAllByText('invitada@example.com');
    expect(mockedValidate).toHaveBeenCalledWith('tok_de_la_url');
  });
});

describe('InvitePage — token desconocido (404)', () => {
  it('muestra el error y NO renderiza formulario ni botón de Google', async () => {
    mockedValidate.mockRejectedValue(new ApiStatusError(404, 'unknown invitation'));

    await renderPage();

    expect(await screen.findByText('Invitación no válida')).toBeDefined();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByLabelText(/contraseña/i)).toBeNull();
    expect(document.querySelector('form')).toBeNull();
    expect(screen.queryByText(/google/i)).toBeNull();
  });
});

describe('InvitePage — token conocido pero no pendiente (410)', () => {
  it('muestra vencida/revocada y NO renderiza formulario ni botón de Google', async () => {
    mockedValidate.mockRejectedValue(new ApiStatusError(410, 'invitation gone'));

    await renderPage();

    expect(await screen.findByText('Invitación vencida o revocada')).toBeDefined();
    expect(screen.queryByRole('button')).toBeNull();
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
    const passwordInput = await screen.findByLabelText(/elegí una contraseña/i);

    fireEvent.change(passwordInput, { target: { value: 'password-segura-123' } });
    fireEvent.click(screen.getByRole('button', { name: /crear cuenta y entrar/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/dejó de ser válida/i);
    });
  });
});

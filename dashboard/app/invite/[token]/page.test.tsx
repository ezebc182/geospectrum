/**
 * Tests de la página pública de aceptación `/invite/[token]` (tarea 8.4 de
 * email-invitations + Fase 7 de i18n-dashboard: copy en el ns `invite` de
 * next-intl, siembra de cookie desde validate.locale y switcher global).
 *
 * Se mockea el módulo `@/lib/auth` (la capa fetch), NO fetch global: es el
 * contrato que la página realmente consume, y `ApiStatusError` se conserva
 * REAL (importOriginal) porque la página decide por `instanceof` — un mock
 * de la clase rompería esa rama silenciosamente. `next/navigation` se mockea
 * para capturar el router.refresh() de la siembra, y `@/hooks/use-auth`
 * porque el LocaleSwitcher global lo consume (acá siempre sin sesión).
 *
 * El idioma ya NO es estado de la página: viene del NextIntlClientProvider
 * (en la app real, de la cascada server-side). Por eso "la página en EN" se
 * testea renderizando con el provider en en-US + mensajes EN, y el "cambio
 * en caliente" (cookie + refresh del switcher) tiene su suite propia en
 * components/LocaleSwitcher.test.tsx — acá se testea la SIEMBRA.
 *
 * La página usa `React.use(params)` (Next 15: params es Promise), así que se
 * renderiza dentro de un `<Suspense>` y se asserta con `findBy*` (async).
 */

import * as React from 'react';
import { act } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
// El hook useToast exige el provider: montar un componente que notifica
// sin él tira a propósito, para que el fallo se vea en el test y no en prod.
import { ToastProvider } from '@/components/ui/toast';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import en from '@/messages/en.json';
import es from '@/messages/es.json';

// El router mockeado es UN objeto estable (como el useRouter real de Next):
// la página lo tiene en las deps del efecto de validate — un mock que
// devuelve un objeto nuevo por render arma un loop infinito de re-renders.
const { refreshMock, routerMock } = vi.hoisted(() => {
  const refreshMock = vi.fn();
  return { refreshMock, routerMock: { refresh: refreshMock, push: vi.fn() } };
});

vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
}));

// El switcher global solo lee `user` para decidir si persiste en cuenta;
// en /invite el visitante nunca tiene sesión.
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ user: null }),
}));

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
import type { AppLocale } from '@/lib/locale';
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

const MESSAGES = { es, en } as const;
const FORMAT_LOCALES = { es: 'es-AR', en: 'en-US' } as const;

async function renderPage(token = 'tok_ABC123', locale: AppLocale = 'es') {
  // `React.use(params)` suspende en el primer render: en React 19 el render
  // que suspende tiene que correr dentro de un `act` AWAITEADO para que la
  // promesa resuelva y el árbol real reemplace el fallback del Suspense.
  await act(async () => {
    render(
      <NextIntlClientProvider locale={FORMAT_LOCALES[locale]} messages={MESSAGES[locale]}>
        <ToastProvider>
          <React.Suspense fallback={null}>
          <InvitePage params={Promise.resolve({ token })} />
        </React.Suspense>
      </ToastProvider>
      </NextIntlClientProvider>,
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
  // Cookie limpia entre tests: jsdom conserva document.cookie por archivo y
  // la siembra de la página la escribe.
  document.cookie = 'NEXT_LOCALE=; path=/; max-age=0';
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
    // cambiarlo (el rol viene de la invitación, server-side). El switcher
    // de idioma es un dropdown (button), no un select.
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

  it('tiene el switcher de idioma global visible', async () => {
    await renderPage();

    await screen.findAllByText('invitada@example.com');
    expect(screen.getByRole('button', { name: 'Idioma' })).toBeDefined();
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

describe('InvitePage — siembra del idioma desde validate.locale (tarea 7.4)', () => {
  it('sin cookie previa, siembra la cookie con el locale de la invitación y refresca', async () => {
    mockedValidate.mockResolvedValue({ ...VALID_INVITATION, locale: 'en' });

    await renderPage();

    await waitFor(() => {
      expect(document.cookie).toContain('NEXT_LOCALE=en');
    });
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it('con cookie previa, la elección explícita del visitante gana (ni pisa ni refresca)', async () => {
    document.cookie = 'NEXT_LOCALE=es; path=/';
    mockedValidate.mockResolvedValue({ ...VALID_INVITATION, locale: 'en' });

    await renderPage();

    await screen.findAllByText('invitada@example.com');
    expect(document.cookie).toContain('NEXT_LOCALE=es');
    expect(document.cookie).not.toContain('NEXT_LOCALE=en');
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('una cookie inválida cuenta como ausente y la siembra corrige', async () => {
    document.cookie = 'NEXT_LOCALE=xx; path=/';
    mockedValidate.mockResolvedValue({ ...VALID_INVITATION, locale: 'en' });

    await renderPage();

    await waitFor(() => {
      expect(document.cookie).toContain('NEXT_LOCALE=en');
    });
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });
});

describe('InvitePage — render con el provider en EN (post-siembra o cookie en)', () => {
  it('todo el copy sale en inglés, incluidos rol y fecha en-US', async () => {
    mockedValidate.mockResolvedValue({ ...VALID_INVITATION, locale: 'en' });

    await renderPage('tok_ABC123', 'en');

    expect(await screen.findByText("You've been invited to GeoSpectrum")).toBeDefined();
    expect(screen.getByRole('button', { name: /create account and sign in/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /continue with google/i })).toBeDefined();
    expect(screen.getByLabelText(/choose a password/i)).toBeDefined();
    // El rol también sale traducido.
    expect(screen.getByText('Moderator')).toBeDefined();
    // formatExpiry migró a useFormatter: con el provider en-US la fecha es
    // "August 17, 2026", no "17 de agosto de 2026".
    expect(screen.getByText(/august 17, 2026/i)).toBeDefined();
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

  it('el switcher global sigue disponible en el estado de error', async () => {
    mockedValidate.mockRejectedValue(new ApiStatusError(404, 'unknown invitation'));

    await renderPage();

    await screen.findByText('Invitación no válida');
    expect(screen.getByRole('button', { name: 'Idioma' })).toBeDefined();
  });

  it('con el provider en EN el error sale en inglés', async () => {
    mockedValidate.mockRejectedValue(new ApiStatusError(404, 'unknown invitation'));

    await renderPage('tok_ABC123', 'en');

    expect(await screen.findByText('Invalid invitation')).toBeDefined();
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
      // Hay dos role="alert" posibles (mismatch + error de submit): se busca
      // el del error de invitación por su texto.
      expect(screen.getByText(/dejó de ser válida/i)).toBeDefined();
    });
  });
});

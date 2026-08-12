/**
 * Tests de componente del OnboardingWizard (tarea 6.1/6.4 de i18n-dashboard):
 * el wizard sale del diccionario `onboarding` en ambos idiomas y "Saltar"
 * sigue convergiendo en onFinished() (la persistencia vive en el gate).
 *
 * El tour de driver.js NO se dispara acá (manipula el DOM real): el smoke
 * completo con tour es del e2e (onboarding.spec.ts) y de la checklist 8.3.
 * Se mockea `@/lib/auth` (prefill del nombre), mismo patrón que el resto.
 */

import * as React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import en from '@/messages/en.json';
import es from '@/messages/es.json';

vi.mock('@/lib/auth', () => ({
  getProfile: vi.fn(),
  updateProfile: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

// El AreaSelector real dispara fetches propios: acá solo importa que el paso 2
// lo monte, no su comportamiento (ya cubierto por AreaSelector.test.tsx).
vi.mock('@/components/AreaSelector', () => ({
  AreaSelector: () => <div data-testid="area-selector-stub" />,
}));

import { getProfile } from '@/lib/auth';

import { OnboardingWizard } from './OnboardingWizard';

const mockedGetProfile = vi.mocked(getProfile);

beforeEach(() => {
  vi.clearAllMocks();
  mockedGetProfile.mockResolvedValue({
    full_name: null,
    address: null,
    phone: null,
    locale: null,
    totp_enabled: false,
  });
});

afterEach(() => {
  cleanup();
});

function renderWizard(locale: 'es-AR' | 'en-US', messages: typeof es, onFinished = vi.fn()) {
  render(
    <NextIntlClientProvider locale={locale} messages={messages}>
      <OnboardingWizard onFinished={onFinished} />
    </NextIntlClientProvider>,
  );
  return onFinished;
}

describe('OnboardingWizard — i18n', () => {
  it('renderiza el paso 1 en español (copy idéntico al que asserta el e2e)', async () => {
    renderWizard('es-AR', es);

    expect(await screen.findByText('¡Bienvenido a GeoSpectrum!')).toBeTruthy();
    expect(screen.getByText('Tu nombre')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Saltar' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Continuar' })).toBeTruthy();
  });

  it('renderiza el paso 1 en inglés con el mismo markup', async () => {
    renderWizard('en-US', en);

    expect(await screen.findByText('Welcome to GeoSpectrum!')).toBeTruthy();
    expect(screen.getByText('Your name')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Skip' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy();
  });

  it('avanza al paso 2 traducido y "Start the tour" está presente (EN)', async () => {
    renderWizard('en-US', en);

    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));

    expect(await screen.findByText('Choose your area of interest')).toBeTruthy();
    expect(screen.getByTestId('area-selector-stub')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Start the tour' })).toBeTruthy();
  });

  it('saltar en cualquier idioma llama onFinished (el gate persiste)', async () => {
    const onFinished = renderWizard('en-US', en);

    fireEvent.click(await screen.findByRole('button', { name: 'Skip' }));

    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
  });
});

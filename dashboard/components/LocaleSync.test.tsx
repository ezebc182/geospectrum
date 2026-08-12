/**
 * Tests de componente de LocaleSync (tarea 5.5 de i18n-dashboard): actúa
 * SOLO sin cookie NEXT_LOCALE — con cookie presente no toca nada, no pide
 * el perfil y no refresca (la elección del dispositivo gana, Decision 3).
 *
 * Se mockea `@/lib/auth` (getProfile) y `next/navigation` (router.refresh),
 * mismo patrón que LocaleSwitcher.test.tsx.
 */

import * as React from 'react';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserProfile } from '@/lib/types';

const { refreshMock } = vi.hoisted(() => ({
  refreshMock: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: refreshMock, push: vi.fn() }),
}));

vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return { ...actual, getProfile: vi.fn() };
});

import { getProfile } from '@/lib/auth';

import { LocaleSync } from './LocaleSync';

const mockedGetProfile = vi.mocked(getProfile);

function profileWithLocale(locale: UserProfile['locale']): UserProfile {
  return {
    full_name: null,
    address: null,
    phone: null,
    locale,
    totp_enabled: false,
  };
}

beforeEach(() => {
  // Cookie limpia entre tests: jsdom conserva document.cookie por archivo.
  document.cookie = 'NEXT_LOCALE=; path=/; max-age=0';
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('LocaleSync — reconciliación users.locale → cookie', () => {
  it('sin cookie y con preferencia guardada, siembra la cookie y refresca una vez', async () => {
    mockedGetProfile.mockResolvedValue(profileWithLocale('en'));

    render(<LocaleSync />);

    await waitFor(() => {
      expect(document.cookie).toContain('NEXT_LOCALE=en');
    });
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it('con cookie presente NO pide el perfil, no toca la cookie y no refresca', () => {
    document.cookie = 'NEXT_LOCALE=es; path=/';
    mockedGetProfile.mockResolvedValue(profileWithLocale('en'));

    render(<LocaleSync />);

    expect(mockedGetProfile).not.toHaveBeenCalled();
    expect(refreshMock).not.toHaveBeenCalled();
    // La cookie del dispositivo queda intacta: es ganó, en no la pisa.
    expect(document.cookie).toContain('NEXT_LOCALE=es');
  });

  it('sin cookie y con locale null en la cuenta ("nunca eligió"), no hace nada', async () => {
    mockedGetProfile.mockResolvedValue(profileWithLocale(null));

    render(<LocaleSync />);

    await waitFor(() => {
      expect(mockedGetProfile).toHaveBeenCalledTimes(1);
    });
    expect(document.cookie).not.toContain('NEXT_LOCALE=');
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('cookie inválida se trata como ausente: la preferencia de cuenta reconcilia', async () => {
    document.cookie = 'NEXT_LOCALE=xx; path=/';
    mockedGetProfile.mockResolvedValue(profileWithLocale('en'));

    render(<LocaleSync />);

    await waitFor(() => {
      expect(document.cookie).toContain('NEXT_LOCALE=en');
    });
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it('la falla del perfil es silenciosa: sin cookie sembrada ni refresh ni error', async () => {
    mockedGetProfile.mockRejectedValue(new Error('backend caído'));

    render(<LocaleSync />);

    await waitFor(() => {
      expect(mockedGetProfile).toHaveBeenCalledTimes(1);
    });
    expect(document.cookie).not.toContain('NEXT_LOCALE=');
    expect(refreshMock).not.toHaveBeenCalled();
  });
});

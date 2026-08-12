/**
 * Tests de componente del AreaSelector (tarea 3.4 de i18n-dashboard): las
 * etiquetas de grupo salen del diccionario (`areas.groups.*`) y los NOMBRES de
 * las áreas —que vienen del backend— NO se traducen.
 *
 * Se mockea `@/lib/areas` (la capa fetch), mismo patrón que el resto de los
 * tests de componente del proyecto.
 */

import * as React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import en from '@/messages/en.json';
import es from '@/messages/es.json';
import type { Area } from '@/lib/types';

vi.mock('@/lib/areas', () => ({
  listAreas: vi.fn(),
  getActiveArea: vi.fn(),
  setActiveArea: vi.fn(),
}));

import { getActiveArea, listAreas } from '@/lib/areas';

import { AreaSelector } from './AreaSelector';

const mockedListAreas = vi.mocked(listAreas);
const mockedGetActiveArea = vi.mocked(getActiveArea);

function makeArea(slug: string, name: string): Area {
  return {
    id: `id-${slug}`,
    slug,
    name,
    is_system: true,
    geometry: { type: 'Polygon', coordinates: [] } as unknown as Area['geometry'],
    bbox: { minlat: 0, minlon: 0, maxlat: 1, maxlon: 1 } as unknown as Area['bbox'],
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
  };
}

const AREAS = [
  makeArea('chile', 'Chile y fosa Perú-Chile'),
  makeArea('san_andres', 'Falla de San Andrés (California)'),
];

beforeEach(() => {
  vi.clearAllMocks();
  mockedListAreas.mockResolvedValue(AREAS);
  mockedGetActiveArea.mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
});

function renderSelector(locale: 'es-AR' | 'en-US', messages: typeof es) {
  render(
    <NextIntlClientProvider locale={locale} messages={messages}>
      <AreaSelector />
    </NextIntlClientProvider>,
  );
}

describe('AreaSelector — i18n', () => {
  it('usa el idioma activo en el trigger y en la opción por defecto', async () => {
    renderSelector('en-US', en);

    await waitFor(() =>
      expect(screen.getByLabelText('Area of interest: Default area')).toBeTruthy(),
    );
  });

  it('con locale ES el mismo control sale en español', async () => {
    renderSelector('es-AR', es);

    await waitFor(() =>
      expect(screen.getByLabelText('Área de interés: Área por defecto')).toBeTruthy(),
    );
  });

  it('traduce las etiquetas de grupo pero NO los nombres de las áreas', async () => {
    renderSelector('en-US', en);

    const trigger = await screen.findByLabelText('Area of interest: Default area');
    // Radix responde a keydown Enter en jsdom, donde no hay PointerEvent real.
    fireEvent.keyDown(trigger, { key: 'Enter' });

    // Grupos: del diccionario (AREA_GROUP_LABELS ya no existe).
    expect(screen.getByText('Subduction zones')).toBeTruthy();
    expect(screen.getByText('Faults')).toBeTruthy();
    // Áreas: tal cual las manda el backend, en cualquier idioma de la UI.
    expect(screen.getByText('Chile y fosa Perú-Chile')).toBeTruthy();
    expect(screen.getByText('Falla de San Andrés (California)')).toBeTruthy();
  });
});

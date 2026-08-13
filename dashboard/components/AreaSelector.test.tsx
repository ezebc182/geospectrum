/**
 * Tests de componente del AreaSelector (tareas 3.4 y 8.5 de i18n-dashboard):
 * las etiquetas de grupo salen del diccionario (`areas.groups.*`) y los
 * nombres de las áreas del SISTEMA se traducen por slug (`areas.names.*`,
 * hallazgo del QA: los nombres seedeados salían en español con la UI en
 * inglés). Un slug sin clave —área custom o catálogo nuevo— cae al nombre de
 * la base, y la búsqueda matchea contra el nombre TRADUCIDO que se ve.
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

function makeArea(slug: string, name: string, isSystem = true): Area {
  return {
    id: `id-${slug}`,
    slug,
    name,
    is_system: isSystem,
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

  it('traduce las etiquetas de grupo Y los nombres de las áreas del sistema', async () => {
    renderSelector('en-US', en);

    const trigger = await screen.findByLabelText('Area of interest: Default area');
    // Radix responde a keydown Enter en jsdom, donde no hay PointerEvent real.
    fireEvent.keyDown(trigger, { key: 'Enter' });

    // Grupos: del diccionario (AREA_GROUP_LABELS ya no existe).
    expect(screen.getByText('Subduction zones')).toBeTruthy();
    expect(screen.getByText('Faults')).toBeTruthy();
    // Áreas del sistema: traducidas por slug (areas.names.*), no como las
    // manda el backend (que seedea en español).
    expect(screen.getByText('Chile and the Peru-Chile Trench')).toBeTruthy();
    expect(screen.getByText('San Andreas Fault (California)')).toBeTruthy();
    expect(screen.queryByText('Chile y fosa Perú-Chile')).toBeNull();
  });

  it('en ES los nombres salen EXACTAMENTE como en la base', async () => {
    renderSelector('es-AR', es);

    const trigger = await screen.findByLabelText('Área de interés: Área por defecto');
    fireEvent.keyDown(trigger, { key: 'Enter' });

    expect(screen.getByText('Chile y fosa Perú-Chile')).toBeTruthy();
    expect(screen.getByText('Falla de San Andrés (California)')).toBeTruthy();
  });

  it('slug sin clave y área custom caen al nombre de la base (fallback)', async () => {
    mockedListAreas.mockResolvedValue([
      ...AREAS,
      // Área del catálogo hipotética que aún no tiene traducción.
      makeArea('atacama_norte', 'Atacama Norte'),
      // Área custom del usuario: su nombre no se toca nunca.
      makeArea('mi_patio', 'Mi patio trasero', false),
    ]);

    renderSelector('en-US', en);

    const trigger = await screen.findByLabelText('Area of interest: Default area');
    fireEvent.keyDown(trigger, { key: 'Enter' });

    expect(screen.getByText('Atacama Norte')).toBeTruthy();
    expect(screen.getByText('Mi patio trasero')).toBeTruthy();
  });

  it('la búsqueda matchea contra el nombre traducido que el usuario ve', async () => {
    // El buscador recién aparece con SEARCH_THRESHOLD (8) áreas o más.
    mockedListAreas.mockResolvedValue([
      ...AREAS,
      makeArea('anillo_de_fuego', 'Cinturón — Anillo de Fuego'),
      makeArea('japon', 'Japón y fosa de Japón'),
      makeArea('indonesia', 'Indonesia y fosa de la Sonda'),
      makeArea('mexico', 'México y fosa Mesoamericana'),
      makeArea('peru', 'Perú y fosa Perú-Chile (norte)'),
      makeArea('cascadia', 'Zona de subducción de Cascadia'),
    ]);

    renderSelector('en-US', en);

    const trigger = await screen.findByLabelText('Area of interest: Default area');
    fireEvent.keyDown(trigger, { key: 'Enter' });

    const searchInput = screen.getByLabelText('Search area of interest');
    // "ring" solo existe en el nombre EN ("Belt — Ring of Fire"); ni el nombre
    // de la base ("Cinturón — Anillo de Fuego") ni el slug lo contienen.
    fireEvent.change(searchInput, { target: { value: 'ring' } });

    expect(screen.getByText('Belt — Ring of Fire')).toBeTruthy();
    expect(screen.queryByText('Japan and the Japan Trench')).toBeNull();
    expect(screen.queryByText('Cascadia Subduction Zone')).toBeNull();
  });
});

/**
 * Tests del salto lista→mapa del Explorador.
 *
 * El bug: en el Explorador el clic en una fila no hacía nada, mientras que en
 * el Dashboard sí resaltaba. Es la misma EventsTable, pero acá el callsite
 * nunca cableó `onRowClick`, y sin esa prop la fila ni siquiera es clickeable.
 *
 * A diferencia del Dashboard —donde mapa y tabla conviven— acá las vistas son
 * excluyentes, así que seleccionar sin cambiar de vista no mostraría nada: el
 * clic tiene que saltar al mapa además de marcar el evento.
 */

import * as React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import es from '@/messages/es.json';
import type { SeismicEvent } from '@/lib/types';

const { mapPropsSpy, searchMock } = vi.hoisted(() => ({
  mapPropsSpy: vi.fn(),
  searchMock: vi.fn(),
}));

// El mapa se reemplaza por un doble que sólo registra las props recibidas: lo
// que se verifica acá es el CABLEADO (que el id llegue al mapa), no el
// comportamiento de Leaflet.
vi.mock('@/components/AdvancedSeismicMap', () => ({
  AdvancedSeismicMap: (props: Record<string, unknown>) => {
    mapPropsSpy(props);
    return <div data-testid="mapa" />;
  },
}));

vi.mock('@/lib/api', () => ({
  seismicAPI: { searchEvents: searchMock },
}));

import ExplorePage from './page';

const EVENTO: SeismicEvent = {
  id: 'evt-1',
  fuentes: ['USGS'],
  hora_utc: '2026-08-18T10:00:00Z',
  lat: -33.4,
  lon: -70.6,
  prof_km: 30,
  mag: 5.5,
  mag_tipo: 'ml',
  lugar: 'Santiago, Chile',
  sentido: false,
  revisado: true,
};

function renderExplore() {
  return render(
    <NextIntlClientProvider locale="es" messages={es}>
      <ExplorePage />
    </NextIntlClientProvider>
  );
}

/** Últimas props que recibió el mapa. */
function ultimasPropsDelMapa(): Record<string, unknown> {
  return mapPropsSpy.mock.calls.at(-1)?.[0] ?? {};
}

beforeEach(() => {
  vi.clearAllMocks();
  // `searchEvents` devuelve el array directo, no un objeto envolvente.
  searchMock.mockResolvedValue([EVENTO]);
});

afterEach(cleanup);

/** Dispara la búsqueda y espera a que aparezcan los resultados. */
async function buscar() {
  fireEvent.click(screen.getByRole('button', { name: es.filters.searchEvents }));
  await screen.findByTestId('mapa');
}

describe('Explorador — selección de evento desde la lista', () => {
  it('arranca sin ningún evento seleccionado', async () => {
    renderExplore();
    await buscar();

    expect(ultimasPropsDelMapa().selectedEventId).toBeNull();
  });

  it('al clickear una fila de la lista salta al mapa con ese evento', async () => {
    // El bug: sin `onRowClick` la fila ni siquiera era clickeable, así que el
    // clic no hacía absolutamente nada. Y como acá las vistas son excluyentes,
    // marcar el evento sin cambiar de vista tampoco se vería.
    renderExplore();
    await buscar();

    fireEvent.click(screen.getByRole('button', { name: es.explore.viewList }));
    fireEvent.click(screen.getByText('Santiago, Chile'));

    // Volvió al mapa...
    expect(screen.getByTestId('mapa')).toBeTruthy();
    // ...y con el evento clickeado marcado.
    expect(ultimasPropsDelMapa().selectedEventId).toBe('evt-1');
  });
});

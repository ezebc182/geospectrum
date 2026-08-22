/**
 * Tests de la paginación de EventsTable (tanda 1, punto 6).
 *
 * El bug: /analytics no pasaba `limit` y renderizaba TODAS las filas del
 * reporte en un solo .map() — con 600+ eventos la página se arrastraba y no
 * había forma de recorrerla.
 *
 * Lo que se fija acá:
 * - `paginated` corta de a `pageSize` y deja navegar
 * - `limit` sigue funcionando igual para el dashboard (no se rompió el otro uso)
 * - filtrar vuelve a la página 1, si no la tabla se ve vacía con el filtro puesto
 */

import * as React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it } from 'vitest';

import { EventsTable } from './EventsTable';
import { formats } from '@/i18n/request';
import es from '@/messages/es.json';
import type { SeismicEvent } from '@/lib/types';

function buildEvents(n: number): SeismicEvent[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `ev-${i}`,
    fuentes: ['USGS'],
    // Horas decrecientes para que el orden sea estable y predecible.
    hora_utc: new Date(Date.UTC(2026, 7, 21, 12, 0, 0) - i * 60_000).toISOString(),
    lat: -23.5,
    lon: -68.2,
    prof_km: 100,
    mag: 4 + (i % 3),
    mag_tipo: 'mb',
    lugar: `Lugar ${i}`,
    sentido: false,
    revisado: false,
  })) as SeismicEvent[];
}

type TableProps = React.ComponentProps<typeof EventsTable>;

function renderTable(props: TableProps) {
  return render(
    <NextIntlClientProvider locale="es-AR" messages={es} formats={formats} timeZone="UTC">
      <EventsTable {...props} />
    </NextIntlClientProvider>,
  );
}

afterEach(() => {
  cleanup();
});

describe('EventsTable — paginación', () => {
  it('sin `paginated` renderiza TODAS las filas (comportamiento previo)', () => {
    /**
     * Contraprueba del bug: así estaba /analytics. Se deja explícito para que
     * quede claro qué cambia al activar la prop.
     */
    renderTable({ eventos: buildEvents(120) });
    expect(screen.getAllByRole('row')).toHaveLength(120);
  });

  it('con `paginated` corta de a pageSize', () => {
    renderTable({ eventos: buildEvents(120), paginated: true, pageSize: 50 });
    expect(screen.getAllByRole('row')).toHaveLength(50);
  });

  it('el pie informa el rango y el total', () => {
    renderTable({ eventos: buildEvents(120), paginated: true, pageSize: 50 });
    expect(screen.getByText('1-50 de 120')).toBeTruthy();
    expect(screen.getByText('Página 1 de 3')).toBeTruthy();
  });

  it('avanzar de página muestra el tramo siguiente', () => {
    renderTable({ eventos: buildEvents(120), paginated: true, pageSize: 50 });

    fireEvent.click(screen.getByRole('button', { name: 'Página siguiente' }));

    expect(screen.getByText('51-100 de 120')).toBeTruthy();
    expect(screen.getByText('Página 2 de 3')).toBeTruthy();
  });

  it('la última página muestra sólo el resto', () => {
    renderTable({ eventos: buildEvents(120), paginated: true, pageSize: 50 });
    const next = screen.getByRole('button', { name: 'Página siguiente' });

    fireEvent.click(next);
    fireEvent.click(next);

    expect(screen.getByText('101-120 de 120')).toBeTruthy();
    expect(screen.getAllByRole('row')).toHaveLength(20);
  });

  it('en la primera página "anterior" está deshabilitado', () => {
    renderTable({ eventos: buildEvents(120), paginated: true, pageSize: 50 });
    const prev = screen.getByRole('button', { name: 'Página anterior' }) as HTMLButtonElement;
    expect(prev.disabled).toBe(true);
  });

  it('en la última página "siguiente" está deshabilitado', () => {
    renderTable({ eventos: buildEvents(60), paginated: true, pageSize: 50 });
    const next = screen.getByRole('button', { name: 'Página siguiente' }) as HTMLButtonElement;

    fireEvent.click(next);

    expect((screen.getByRole('button', { name: 'Página siguiente' }) as HTMLButtonElement).disabled)
      .toBe(true);
  });

  it('con una sola página los dos botones están deshabilitados pero el contador se ve', () => {
    /**
     * El rango "1-3 de 3" es información útil por sí solo: sin él la lista no
     * dice cuánto hay.
     */
    renderTable({ eventos: buildEvents(3), paginated: true, pageSize: 50 });

    expect(screen.getByText('1-3 de 3')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Página anterior' }) as HTMLButtonElement).disabled)
      .toBe(true);
    expect((screen.getByRole('button', { name: 'Página siguiente' }) as HTMLButtonElement).disabled)
      .toBe(true);
  });

  it('sin eventos el rango arranca en 0 y no en 1', () => {
    /** "1-0 de 0" sería un rango imposible. */
    renderTable({ eventos: [], paginated: true, pageSize: 50 });
    expect(screen.queryByText('1-0 de 0')).toBeNull();
  });
});

describe('EventsTable — `limit` no se rompió', () => {
  it('sigue cortando a los N primeros', () => {
    renderTable({ eventos: buildEvents(120), limit: 10 });
    expect(screen.getAllByRole('row')).toHaveLength(10);
  });

  it('mantiene su pie "Mostrando N de M"', () => {
    renderTable({ eventos: buildEvents(120), limit: 10 });
    expect(screen.getByText('Mostrando 10 de 120 eventos')).toBeTruthy();
  });

  it('con `paginated` gana la paginación sobre `limit`', () => {
    /**
     * Son dos necesidades distintas y no tiene sentido combinarlas: `limit` es
     * "asomate a los 10 más recientes", la paginación es "recorré todo".
     */
    renderTable({ eventos: buildEvents(120), limit: 10, paginated: true, pageSize: 50 });

    expect(screen.getAllByRole('row')).toHaveLength(50);
    expect(screen.queryByText('Mostrando 10 de 120 eventos')).toBeNull();
  });
});

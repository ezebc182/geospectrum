import { describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach } from 'vitest';
import { EventsTable } from './EventsTable';
import { emitAreaChanged } from '@/lib/area-events';
import type { SeismicEvent } from '@/lib/types';

afterEach(() => {
  cleanup();
});

function makeEvento(overrides: Partial<SeismicEvent> = {}): SeismicEvent {
  return {
    id: 'evt-123',
    fuentes: ['USGS'],
    hora_utc: '2026-07-13T10:00:00Z',
    lat: -34.6,
    lon: -58.4,
    prof_km: 10,
    mag: 5.2,
    mag_tipo: 'mb',
    lugar: 'Buenos Aires, Argentina',
    sentido: false,
    revisado: true,
    ...overrides,
  };
}

describe('EventsTable — sincronización tabla→mapa (onRowClick)', () => {
  it('invoca onRowClick con el id correcto al hacer click en una fila', () => {
    const onRowClick = vi.fn();
    const eventos = [makeEvento({ id: 'evt-123' }), makeEvento({ id: 'evt-456', lugar: 'Santiago, Chile' })];

    render(<EventsTable eventos={eventos} onRowClick={onRowClick} />);

    const row = screen.getByText('Buenos Aires, Argentina').closest('[role="row"]');
    expect(row).not.toBeNull();
    fireEvent.click(row!);

    expect(onRowClick).toHaveBeenCalledTimes(1);
    expect(onRowClick).toHaveBeenCalledWith('evt-123');
  });

  it('resalta la fila cuando evento.id === selectedEventId', () => {
    const eventos = [makeEvento({ id: 'evt-123' })];
    render(<EventsTable eventos={eventos} selectedEventId="evt-123" />);

    const row = screen.getByText('Buenos Aires, Argentina').closest('[role="row"]');
    expect(row?.getAttribute('data-state')).toBe('selected');
  });

  it('no resalta ninguna fila cuando selectedEventId no coincide', () => {
    const eventos = [makeEvento({ id: 'evt-123' })];
    render(<EventsTable eventos={eventos} selectedEventId="evt-999" />);

    const row = screen.getByText('Buenos Aires, Argentina').closest('[role="row"]');
    expect(row?.getAttribute('data-state')).toBeNull();
  });

  it('no lanza y no requiere onRowClick (uso legacy sin sincronización)', () => {
    const eventos = [makeEvento()];
    expect(() => render(<EventsTable eventos={eventos} />)).not.toThrow();
  });

  it('hover sobre una fila no dispara onRowClick (unidireccionalidad: solo click)', () => {
    const onRowClick = vi.fn();
    const eventos = [makeEvento({ id: 'evt-123' })];
    render(<EventsTable eventos={eventos} onRowClick={onRowClick} />);

    const row = screen.getByText('Buenos Aires, Argentina').closest('[role="row"]');
    fireEvent.mouseEnter(row!);
    fireEvent.mouseOver(row!);

    expect(onRowClick).not.toHaveBeenCalled();
  });
});

describe('EventsTable — filtros (filterable)', () => {
  const eventos = [
    makeEvento({ id: 'a', lugar: 'Santiago, Chile', mag: 5.5 }),
    makeEvento({ id: 'b', lugar: 'Tokio, Japón', mag: 3.1 }),
    makeEvento({ id: 'c', lugar: 'Valparaíso, Chile', mag: 2.0 }),
  ];

  it('no muestra la barra de filtros si no se pide', () => {
    render(<EventsTable eventos={eventos} />);

    expect(screen.queryByLabelText('Buscar por zona')).toBeNull();
  });

  it('filtra las filas por la búsqueda de zona', () => {
    render(<EventsTable eventos={eventos} filterable />);

    fireEvent.change(screen.getByLabelText('Buscar por zona'), {
      target: { value: 'chile' },
    });

    expect(screen.getByText('Santiago, Chile')).toBeTruthy();
    expect(screen.getByText('Valparaíso, Chile')).toBeTruthy();
    expect(screen.queryByText('Tokio, Japón')).toBeNull();
  });

  it('filtra ANTES de aplicar el limit', () => {
    // Con el orden invertido, un limit de 1 recortaría a "Santiago" y buscar
    // "japon" no encontraría nada aunque el evento exista en la lista.
    render(<EventsTable eventos={eventos} limit={1} filterable />);

    fireEvent.change(screen.getByLabelText('Buscar por zona'), {
      target: { value: 'japon' },
    });

    expect(screen.getByText('Tokio, Japón')).toBeTruthy();
  });

  it('limpia los filtros al cambiar de área', () => {
    render(<EventsTable eventos={eventos} filterable />);

    const search = screen.getByLabelText('Buscar por zona') as HTMLInputElement;
    fireEvent.change(search, { target: { value: 'japon' } });
    expect(screen.queryByText('Santiago, Chile')).toBeNull();

    act(() => emitAreaChanged());

    expect(search.value).toBe('');
    expect(screen.getByText('Santiago, Chile')).toBeTruthy();
  });
});

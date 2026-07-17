import { describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach } from 'vitest';
import { EventsTable } from './EventsTable';
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

    const row = screen.getByText('Buenos Aires, Argentina').closest('tr');
    expect(row).not.toBeNull();
    fireEvent.click(row!);

    expect(onRowClick).toHaveBeenCalledTimes(1);
    expect(onRowClick).toHaveBeenCalledWith('evt-123');
  });

  it('resalta la fila cuando evento.id === selectedEventId', () => {
    const eventos = [makeEvento({ id: 'evt-123' })];
    render(<EventsTable eventos={eventos} selectedEventId="evt-123" />);

    const row = screen.getByText('Buenos Aires, Argentina').closest('tr');
    expect(row?.getAttribute('data-state')).toBe('selected');
  });

  it('no resalta ninguna fila cuando selectedEventId no coincide', () => {
    const eventos = [makeEvento({ id: 'evt-123' })];
    render(<EventsTable eventos={eventos} selectedEventId="evt-999" />);

    const row = screen.getByText('Buenos Aires, Argentina').closest('tr');
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

    const row = screen.getByText('Buenos Aires, Argentina').closest('tr');
    fireEvent.mouseEnter(row!);
    fireEvent.mouseOver(row!);

    expect(onRowClick).not.toHaveBeenCalled();
  });
});

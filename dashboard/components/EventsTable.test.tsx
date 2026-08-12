import { describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach } from 'vitest';
import { NextIntlClientProvider } from 'next-intl';
import { EventsTable } from './EventsTable';
import { emitAreaChanged } from '@/lib/area-events';
import en from '@/messages/en.json';
import es from '@/messages/es.json';
import type { SeismicEvent } from '@/lib/types';

afterEach(() => {
  cleanup();
});

/**
 * La tabla y su barra de filtros usan useTranslations, así que necesitan el
 * provider. Se monta con los mensajes ES reales (no un stub): así los asserts
 * siguen buscando el texto que ve el usuario y un cambio de copy que rompa una
 * clave falla acá.
 */
function renderTable(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="es-AR" messages={es}>
      {ui}
    </NextIntlClientProvider>,
  );
}

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

    renderTable(<EventsTable eventos={eventos} onRowClick={onRowClick} />);

    const row = screen.getByText('Buenos Aires, Argentina').closest('[role="row"]');
    expect(row).not.toBeNull();
    fireEvent.click(row!);

    expect(onRowClick).toHaveBeenCalledTimes(1);
    expect(onRowClick).toHaveBeenCalledWith('evt-123');
  });

  it('resalta la fila cuando evento.id === selectedEventId', () => {
    const eventos = [makeEvento({ id: 'evt-123' })];
    renderTable(<EventsTable eventos={eventos} selectedEventId="evt-123" />);

    const row = screen.getByText('Buenos Aires, Argentina').closest('[role="row"]');
    expect(row?.getAttribute('data-state')).toBe('selected');
  });

  it('no resalta ninguna fila cuando selectedEventId no coincide', () => {
    const eventos = [makeEvento({ id: 'evt-123' })];
    renderTable(<EventsTable eventos={eventos} selectedEventId="evt-999" />);

    const row = screen.getByText('Buenos Aires, Argentina').closest('[role="row"]');
    expect(row?.getAttribute('data-state')).toBeNull();
  });

  it('no lanza y no requiere onRowClick (uso legacy sin sincronización)', () => {
    const eventos = [makeEvento()];
    expect(() => renderTable(<EventsTable eventos={eventos} />)).not.toThrow();
  });

  it('hover sobre una fila no dispara onRowClick (unidireccionalidad: solo click)', () => {
    const onRowClick = vi.fn();
    const eventos = [makeEvento({ id: 'evt-123' })];
    renderTable(<EventsTable eventos={eventos} onRowClick={onRowClick} />);

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
    renderTable(<EventsTable eventos={eventos} />);

    expect(screen.queryByLabelText('Buscar por zona')).toBeNull();
  });

  it('filtra las filas por la búsqueda de zona', () => {
    renderTable(<EventsTable eventos={eventos} filterable />);

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
    renderTable(<EventsTable eventos={eventos} limit={1} filterable />);

    fireEvent.change(screen.getByLabelText('Buscar por zona'), {
      target: { value: 'japon' },
    });

    expect(screen.getByText('Tokio, Japón')).toBeTruthy();
  });

  it('limpia los filtros al cambiar de área', () => {
    renderTable(<EventsTable eventos={eventos} filterable />);

    const search = screen.getByLabelText('Buscar por zona') as HTMLInputElement;
    fireEvent.change(search, { target: { value: 'japon' } });
    expect(screen.queryByText('Santiago, Chile')).toBeNull();

    act(() => emitAreaChanged());

    expect(search.value).toBe('');
    expect(screen.getByText('Santiago, Chile')).toBeTruthy();
  });
});

describe('EventsTable — i18n (Fase 3 de i18n-dashboard)', () => {
  const eventos = [makeEvento({ id: 'a', lugar: 'Santiago, Chile' })];

  function renderIn(locale: 'es-AR' | 'en-US', messages: typeof es) {
    return render(
      <NextIntlClientProvider locale={locale} messages={messages}>
        <EventsTable eventos={eventos} filterable />
      </NextIntlClientProvider>,
    );
  }

  it('muestra los filtros y los períodos en inglés con el locale EN', () => {
    renderIn('en-US', en);

    expect(screen.getByLabelText('Search by zone')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /More filters/ }));
    // Los períodos salen del diccionario: TIME_PERIODS ya no trae label.
    expect(screen.getByRole('button', { name: 'Yesterday' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Last 6 h' })).toBeTruthy();
  });

  it('muestra los mismos controles en español con el locale ES', () => {
    renderIn('es-AR', es);

    expect(screen.getByLabelText('Buscar por zona')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Más filtros/ }));
    expect(screen.getByRole('button', { name: 'Ayer' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Últimas 6 h' })).toBeTruthy();
  });

  it('no traduce los nombres de lugar: son datos del backend', () => {
    renderIn('en-US', en);

    expect(screen.getByText('Santiago, Chile')).toBeTruthy();
  });
});

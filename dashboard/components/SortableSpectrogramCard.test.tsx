/**
 * Fila de métricas de dominio en la tarjeta (PR-W3, Task 7).
 *
 * La decisión que verifican estos tests: en modo live CON métricas la fila
 * reemplaza al badge de riesgo (el estado de la SEÑAL le gana a la
 * clasificación estática de la zona); sin métricas el badge queda como
 * fallback para que un canal caído no deje la tarjeta muda.
 */

import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

import es from '@/messages/es.json';
import type { SeismicCity } from '@/lib/seismic-cities';
import type { StationMetrics } from '@/lib/station-metrics';
import { SortableSpectrogramCard } from './SortableSpectrogramCard';

const TOKYO: SeismicCity = {
  id: 'tokyo',
  name: 'Tokyo',
  country: 'Japan',
  lat: 35.6762,
  lon: 139.6503,
  population: 37400000,
  riskLevel: 'extreme',
  network: 'JP',
};

const METRICS: StationMetrics = {
  channel: 'JP.JYT..BHZ',
  endtime: new Date().toISOString(),
  rsam: 123.4,
  freq_hz: 2.4,
  fi: -0.12,
  peak_db: 87.3,
  events_hour: 3,
};

/** Stub mínimo de WebSocket: LiveSpectrogramCanvas abre uno al montar. */
class MockWebSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public url: string) {}
  close() {}
}

beforeEach(() => {
  vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    fillStyle: '',
    fillRect: vi.fn(),
    getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(0) })),
    putImageData: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ columns: [] }),
      })
    ) as unknown as typeof fetch
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderCard(props: { liveChannel?: string; metrics?: StationMetrics }) {
  return render(
    <NextIntlClientProvider locale="es" messages={es}>
      <SortableSpectrogramCard
        city={TOKYO}
        liveChannel={props.liveChannel}
        metrics={props.metrics}
        onRemove={() => {}}
      />
    </NextIntlClientProvider>
  );
}

describe('SortableSpectrogramCard — modo inicial', () => {
  it('arranca en vivo cuando el canal llega DESPUÉS del primer render', () => {
    // El caso real: /spectrograms-live pide los canales en vivo en un
    // useEffect asíncrono, así que el primer render de la tarjeta siempre ve
    // liveChannel=undefined. Con el modo resuelto sólo en el useState inicial,
    // la tarjeta quedaba clavada en "24h" para siempre — y pedía un PNG a FDSN
    // en ciudades que tenían dato vivo esperando en TimescaleDB (Port-au-Prince
    // mostraba "sin estación cercana" con 456 columnas frescas en la base).
    const { rerender } = renderCard({ liveChannel: undefined, metrics: METRICS });

    // Sin canal todavía: modo estático, sin fila de métricas.
    expect(screen.queryByTestId('card-metrics-row')).toBeNull();

    rerender(
      <NextIntlClientProvider locale="es" messages={es}>
        <SortableSpectrogramCard
          city={TOKYO}
          liveChannel="JP.JYT..BHZ"
          metrics={METRICS}
          onRemove={() => {}}
        />
      </NextIntlClientProvider>
    );

    // La fila de métricas sólo se pinta en modo 'live': es la prueba de que
    // la tarjeta pasó a vivo sola, sin que el usuario tocara el toggle.
    expect(screen.getByTestId('card-metrics-row')).not.toBeNull();
  });
});

describe('SortableSpectrogramCard — fila de métricas', () => {
  it('en modo live con métricas muestra la fila y oculta el badge de riesgo', () => {
    renderCard({ liveChannel: 'JP.JYT..BHZ', metrics: METRICS });

    const row = screen.getByTestId('card-metrics-row');
    expect(row.textContent).toContain('RSAM 123');
    expect(row.textContent).toContain('FI -0.12');
    expect(row.textContent).toContain('87.3');
    expect(screen.queryByTitle(/riesgo|risk/i)).toBeNull();
  });

  it('sin métricas el badge de riesgo queda como fallback', () => {
    renderCard({ liveChannel: 'JP.JYT..BHZ', metrics: undefined });

    expect(screen.queryByTestId('card-metrics-row')).toBeNull();
    expect(screen.getByTitle(/riesgo|risk/i)).not.toBeNull();
  });

  it('sin canal en vivo (modo estático) no muestra la fila aunque haya métricas', () => {
    renderCard({ liveChannel: undefined, metrics: METRICS });

    expect(screen.queryByTestId('card-metrics-row')).toBeNull();
    expect(screen.getByTitle(/riesgo|risk/i)).not.toBeNull();
  });

  it('los valores null salen como guion, no rompen la fila', () => {
    renderCard({
      liveChannel: 'JP.JYT..BHZ',
      metrics: { ...METRICS, rsam: null, fi: null, peak_db: null, freq_hz: null },
    });

    const row = screen.getByTestId('card-metrics-row');
    expect(row.textContent).toContain('RSAM —');
    expect(row.textContent).toContain('FI —');
  });
});

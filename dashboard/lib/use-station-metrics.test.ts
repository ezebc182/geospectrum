/**
 * Tests del hook de polling de métricas (PR-W3, encargo del Task 7).
 *
 * Lo que verifican: que la SWR key sea null cuando el consumidor no quiere
 * métricas (enabled=false) o no hay canales — con key null SWR ni siquiera
 * llama al fetcher, así que la vista de tarjetas cerrada no genera un
 * request cada 15 s por eternidad.
 */

import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';

import type { StationMetrics } from './station-metrics';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));

vi.mock('./station-metrics', () => ({
  fetchStationMetrics: fetchMock,
}));

const { useStationMetrics } = await import('./use-station-metrics');

const SAMPLE: StationMetrics = {
  channel: 'IU.MAJO.00.BHZ',
  endtime: '2026-08-21T14:32:10.000000Z',
  rsam: 123.4,
  freq_hz: 2.4,
  fi: -0.12,
  peak_db: 87.3,
  events_hour: 3,
};

/** Cada render usa un cache propio: SWR dedupea por key entre tests. */
function wrapper({ children }: { children: React.ReactNode }) {
  return React.createElement(
    SWRConfig,
    { value: { provider: () => new Map(), dedupingInterval: 0 } },
    children
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('useStationMetrics', () => {
  it('con canales y enabled trae el mapa de métricas', async () => {
    fetchMock.mockResolvedValue({ [SAMPLE.channel]: SAMPLE });

    const { result } = renderHook(
      () => useStationMetrics(['IU.MAJO.00.BHZ'], true),
      { wrapper }
    );

    await waitFor(() => {
      expect(result.current[SAMPLE.channel]).toEqual(SAMPLE);
    });
    expect(fetchMock).toHaveBeenCalledWith(['IU.MAJO.00.BHZ']);
  });

  it('con enabled=false NO dispara polling y devuelve vacío', async () => {
    fetchMock.mockResolvedValue({ [SAMPLE.channel]: SAMPLE });

    const { result } = renderHook(
      () => useStationMetrics(['IU.MAJO.00.BHZ'], false),
      { wrapper }
    );

    // Le damos tiempo a SWR de resolver si la key no fuera null.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current).toEqual({});
  });

  it('sin canales NO dispara polling aunque esté enabled', async () => {
    fetchMock.mockResolvedValue({});

    const { result } = renderHook(() => useStationMetrics([], true), { wrapper });

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current).toEqual({});
  });
});

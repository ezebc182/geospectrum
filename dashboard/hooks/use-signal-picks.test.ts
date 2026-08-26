/**
 * El hook de picks: siembra por efecto, alta idempotente y mediciones
 * derivadas. La API se mockea entera; lo que se prueba es el contrato del
 * hook, no la red.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { seismicAPI, type PickApiRecord } from '@/lib/api';
import { useSignalPicks } from './use-signal-picks';

vi.mock('@/lib/api', () => ({
  seismicAPI: {
    getStationPicks: vi.fn(),
    createStationPick: vi.fn(),
    deleteStationPick: vi.fn(),
  },
}));

const T0 = Date.UTC(2026, 7, 23, 14, 0, 0);
const WINDOW = { startMs: T0, endMs: T0 + 600_000 };
const CHANNEL = 'AK.FIRE..BHZ';

function record(id: string, phase: PickApiRecord['phase'], offsetMs: number): PickApiRecord {
  const iso = new Date(T0 + offsetMs).toISOString();
  return {
    id,
    channel: CHANNEL,
    phase,
    pick_time: iso,
    note: null,
    created_at: iso,
    updated_at: iso,
  };
}

afterEach(() => {
  vi.mocked(seismicAPI.getStationPicks).mockReset();
  vi.mocked(seismicAPI.createStationPick).mockReset();
  vi.mocked(seismicAPI.deleteStationPick).mockReset();
});

describe('useSignalPicks', () => {
  it('sin ventana no pide nada y queda idle con lista vacía', () => {
    const { result } = renderHook(() => useSignalPicks(CHANNEL, null));

    expect(result.current.status).toBe('idle');
    expect(result.current.picks).toEqual([]);
    expect(seismicAPI.getStationPicks).not.toHaveBeenCalled();
  });

  it('con ventana siembra los picks por efecto y calcula las mediciones', async () => {
    vi.mocked(seismicAPI.getStationPicks).mockResolvedValue({
      picks: [record('a', 'P', 0), record('b', 'S', 11_400)],
      measurements: { sp_seconds: null, distance_km: null, coda_seconds: null, coda_magnitude: null },
    });

    const { result } = renderHook(() => useSignalPicks(CHANNEL, WINDOW));

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.picks).toHaveLength(2);
    // Las mediciones de pantalla salen de la copia TS, no de la respuesta:
    // el backend calcula para el CSV, el cliente para el feedback inmediato.
    expect(result.current.measurements.spSeconds).toBeCloseTo(11.4, 6);
    expect(result.current.measurements.distanceKm).toBeCloseTo(93.699, 3);
  });

  it('el doble clic idempotente (mismo id) reemplaza, no duplica', async () => {
    vi.mocked(seismicAPI.getStationPicks).mockResolvedValue({
      picks: [],
      measurements: { sp_seconds: null, distance_km: null, coda_seconds: null, coda_magnitude: null },
    });
    vi.mocked(seismicAPI.createStationPick).mockResolvedValue(record('same-id', 'P', 0));

    const { result } = renderHook(() => useSignalPicks(CHANNEL, WINDOW));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    await act(() => result.current.addPick('P', T0));
    await act(() => result.current.addPick('P', T0));

    expect(result.current.picks).toHaveLength(1);
  });

  it('removePick borra en la API y saca el pick de la lista', async () => {
    vi.mocked(seismicAPI.getStationPicks).mockResolvedValue({
      picks: [record('a', 'P', 0)],
      measurements: { sp_seconds: null, distance_km: null, coda_seconds: null, coda_magnitude: null },
    });
    vi.mocked(seismicAPI.deleteStationPick).mockResolvedValue(undefined);

    const { result } = renderHook(() => useSignalPicks(CHANNEL, WINDOW));
    await waitFor(() => expect(result.current.picks).toHaveLength(1));

    await act(() => result.current.removePick('a'));

    expect(seismicAPI.deleteStationPick).toHaveBeenCalledWith(CHANNEL, 'a');
    expect(result.current.picks).toEqual([]);
  });

  it('el error de red del listado termina en status error, no en excepción', async () => {
    vi.mocked(seismicAPI.getStationPicks).mockRejectedValue(new Error('500'));

    const { result } = renderHook(() => useSignalPicks(CHANNEL, WINDOW));

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.picks).toEqual([]);
  });
});

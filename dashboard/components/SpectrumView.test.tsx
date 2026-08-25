/**
 * El jsdom no rasteriza: la curva no se verifica acá. Lo que SÍ se verifica es
 * el contrato del eje — que el máximo de frecuencia mostrado sale de la
 * RESPUESTA y no de una constante en TS (tarea 3.13): medido en producción el
 * techo varía entre 10, 20 y 25 Hz, y un eje constante miente por factor 2,5.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';

import es from '@/messages/es.json';
import { seismicAPI } from '@/lib/api';
import type { SpectrumResponse } from '@/lib/api';
import { SpectrumView } from './SpectrumView';

vi.mock('@/lib/api', () => ({
  seismicAPI: { getStationSpectrum: vi.fn() },
}));

const WINDOW = { startMs: Date.UTC(2026, 7, 24, 12, 0, 0), endMs: Date.UTC(2026, 7, 24, 12, 10, 0) };

function respuesta(over: Partial<SpectrumResponse> = {}): SpectrumResponse {
  return {
    channel: 'IU.MAJO..BHZ',
    sampling_rate: 20.0,
    max_freq_hz: 10.0,
    starttime: '2026-08-24T12:00:00Z',
    endtime: '2026-08-24T12:10:00Z',
    npts: 12000,
    filter: 'none',
    freqs: [0, 2.5, 5, 7.5, 10],
    power_db: [10, 20, 61, 30, 15],
    ...over,
  };
}

function renderSpectrum(props: Partial<Parameters<typeof SpectrumView>[0]> = {}) {
  return render(
    <NextIntlClientProvider locale="es-AR" messages={es} timeZone="UTC">
      <SpectrumView
        channel="IU.MAJO..BHZ"
        window={WINDOW}
        filter="none"
        {...props}
      />
    </NextIntlClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.mocked(seismicAPI.getStationSpectrum).mockReset();
});

describe('SpectrumView', () => {
  it('pide el espectro de la ventana con el filtro vigente', async () => {
    vi.mocked(seismicAPI.getStationSpectrum).mockResolvedValue(respuesta());
    renderSpectrum({ filter: 'bp' });

    await waitFor(() => {
      expect(seismicAPI.getStationSpectrum).toHaveBeenCalledWith(
        'IU.MAJO..BHZ',
        WINDOW,
        'bp',
      );
    });
  });

  it('el eje sale de max_freq_hz de la RESPUESTA, no de una constante', async () => {
    vi.mocked(seismicAPI.getStationSpectrum).mockResolvedValue(
      respuesta({ max_freq_hz: 10.0 }),
    );
    renderSpectrum();
    expect(await screen.findByText('10 Hz')).toBeTruthy();
  });

  it('dos respuestas con max_freq_hz distinto producen ejes distintos', async () => {
    // La mitad del contrato de la tarea 3.13: si una constante TS pisara el
    // valor de la respuesta, ambos renders mostrarían el mismo eje.
    vi.mocked(seismicAPI.getStationSpectrum).mockResolvedValue(
      respuesta({ max_freq_hz: 10.0 }),
    );
    const first = renderSpectrum();
    expect(await screen.findByText('10 Hz')).toBeTruthy();
    first.unmount();

    vi.mocked(seismicAPI.getStationSpectrum).mockResolvedValue(
      respuesta({ sampling_rate: 100.0, max_freq_hz: 25.0 }),
    );
    renderSpectrum();
    expect(await screen.findByText('25 Hz')).toBeTruthy();
    expect(screen.queryByText('10 Hz')).toBeNull();
  });

  it('señala el pico dominante con su frecuencia', async () => {
    // power_db máximo en 61 → freqs[2] = 5 Hz.
    vi.mocked(seismicAPI.getStationSpectrum).mockResolvedValue(respuesta());
    renderSpectrum();

    const pico = await screen.findByTestId('spectrum-peak');
    expect(pico.textContent).toContain('5');
  });

  it('muestra un loader mientras el espectro está en vuelo', () => {
    vi.mocked(seismicAPI.getStationSpectrum).mockReturnValue(new Promise(() => {}));
    renderSpectrum();

    expect(screen.getByTestId('spectrum-loading').textContent).toContain(
      es.station.spectrumLoading,
    );
  });

  it('una falla muestra el error honesto, no un panel vacío', async () => {
    vi.mocked(seismicAPI.getStationSpectrum).mockRejectedValue(new Error('500'));
    renderSpectrum();

    await waitFor(() => {
      expect(screen.getByTestId('spectrum-error').textContent).toContain(
        es.station.spectrumError,
      );
    });
  });

  it('al cambiar la ventana vuelve a pedir el espectro', async () => {
    vi.mocked(seismicAPI.getStationSpectrum).mockResolvedValue(respuesta());
    const { rerender } = renderSpectrum();
    await waitFor(() => expect(seismicAPI.getStationSpectrum).toHaveBeenCalledTimes(1));

    rerender(
      <NextIntlClientProvider locale="es-AR" messages={es} timeZone="UTC">
        <SpectrumView
          channel="IU.MAJO..BHZ"
          window={{ startMs: WINDOW.startMs + 60_000, endMs: WINDOW.endMs + 60_000 }}
          filter="none"
        />
      </NextIntlClientProvider>,
    );
    await waitFor(() => expect(seismicAPI.getStationSpectrum).toHaveBeenCalledTimes(2));
  });
});

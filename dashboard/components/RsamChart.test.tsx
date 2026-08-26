/**
 * El jsdom no rasteriza: la polilínea no se verifica acá. Se verifica el
 * contrato — qué período se pide (adaptativo a la ventana: con el fijo de
 * SWARM de 600 s, la ventana de 2 min del clic daría serie VACÍA), qué se
 * muestra en cada estado y que el componente NO calcula RSAM.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';

import es from '@/messages/es.json';
import { seismicAPI } from '@/lib/api';
import type { RsamResponse } from '@/lib/api';
import { RsamChart } from './RsamChart';

vi.mock('@/lib/api', () => ({
  seismicAPI: { getStationRsam: vi.fn() },
}));

const T0 = Date.UTC(2026, 7, 24, 12, 0, 0);
const HORA = { startMs: T0, endMs: T0 + 3_600_000 };

function respuesta(over: Partial<RsamResponse> = {}): RsamResponse {
  return {
    channel: 'IU.MAJO..BHZ',
    sampling_rate: 20.0,
    period_seconds: 60,
    starttime: '2026-08-24T12:00:00Z',
    endtime: '2026-08-24T13:00:00Z',
    samples: Array.from({ length: 6 }, (_, i) => ({
      t: `2026-08-24T12:0${i}:30Z`,
      value: 10 + i,
    })),
    ...over,
  };
}

function renderRsam(props: Partial<Parameters<typeof RsamChart>[0]> = {}) {
  return render(
    <NextIntlClientProvider locale="es-AR" messages={es} timeZone="UTC">
      <RsamChart channel="IU.MAJO..BHZ" window={HORA} {...props} />
    </NextIntlClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.mocked(seismicAPI.getStationRsam).mockReset();
});

describe('RsamChart', () => {
  it('pide la serie con un período adaptativo (~60 puntos por ventana)', async () => {
    vi.mocked(seismicAPI.getStationRsam).mockResolvedValue(respuesta());
    renderRsam();

    await waitFor(() => {
      // 1 h / 60 puntos = 60 s por punto.
      expect(seismicAPI.getStationRsam).toHaveBeenCalledWith('IU.MAJO..BHZ', HORA, 60);
    });
  });

  it('la ventana corta del clic pide un período chico, nunca la serie vacía de 600 s', async () => {
    vi.mocked(seismicAPI.getStationRsam).mockResolvedValue(respuesta());
    renderRsam({ window: { startMs: T0, endMs: T0 + 120_000 } });

    await waitFor(() => {
      expect(seismicAPI.getStationRsam).toHaveBeenCalledWith(
        'IU.MAJO..BHZ',
        { startMs: T0, endMs: T0 + 120_000 },
        2,
      );
    });
  });

  it('muestra cuántos puntos dibuja y de qué período', async () => {
    vi.mocked(seismicAPI.getStationRsam).mockResolvedValue(respuesta());
    renderRsam();

    const info = await screen.findByTestId('rsam-info');
    expect(info.textContent).toContain('6');
    expect(info.textContent).toContain('60');
  });

  it('muestra un loader mientras la serie está en vuelo', () => {
    vi.mocked(seismicAPI.getStationRsam).mockReturnValue(new Promise(() => {}));
    renderRsam();

    expect(screen.getByTestId('rsam-loading').textContent).toContain(
      es.station.rsamLoading,
    );
  });

  it('una falla muestra el error honesto', async () => {
    vi.mocked(seismicAPI.getStationRsam).mockRejectedValue(new Error('500'));
    renderRsam();

    await waitFor(() => {
      expect(screen.getByTestId('rsam-error').textContent).toContain(
        es.station.rsamError,
      );
    });
  });

  it('una serie vacía lo dice, no deja un lienzo mudo', async () => {
    vi.mocked(seismicAPI.getStationRsam).mockResolvedValue(respuesta({ samples: [] }));
    renderRsam();

    await waitFor(() => {
      expect(screen.getByTestId('rsam-empty').textContent).toContain(
        es.station.rsamEmpty,
      );
    });
  });

  it('al cambiar la ventana vuelve a pedir la serie', async () => {
    vi.mocked(seismicAPI.getStationRsam).mockResolvedValue(respuesta());
    const { rerender } = renderRsam();
    await waitFor(() => expect(seismicAPI.getStationRsam).toHaveBeenCalledTimes(1));

    rerender(
      <NextIntlClientProvider locale="es-AR" messages={es} timeZone="UTC">
        <RsamChart
          channel="IU.MAJO..BHZ"
          window={{ startMs: T0 + 60_000, endMs: T0 + 3_660_000 }}
        />
      </NextIntlClientProvider>,
    );
    await waitFor(() => expect(seismicAPI.getStationRsam).toHaveBeenCalledTimes(2));
  });
});

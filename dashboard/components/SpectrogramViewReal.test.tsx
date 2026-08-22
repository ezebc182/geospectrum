/**
 * Tests del refresco del espectrograma.
 *
 * El bug: `fetchSpectrogram` hacía `setIsLoading(true)` también en el refresco
 * periódico, así que cada 30 segundos la imagen desaparecía durante todo el
 * fetch. Con 12 tarjetas en la grilla siempre había varias en blanco y la
 * pantalla parpadeaba sin parar.
 *
 * El refresco ahora ocurre en segundo plano: la imagen anterior se mantiene
 * hasta que llega la nueva.
 */

import * as React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import es from '@/messages/es.json';
import type { SeismicCity } from '@/lib/seismic-cities';

const { getSpectrogramMock } = vi.hoisted(() => ({
  getSpectrogramMock: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  seismicAPI: { getSpectrogram: getSpectrogramMock },
}));

import { SpectrogramViewReal } from './SpectrogramViewReal';

const CITY = {
  id: 'tokyo',
  name: 'Tokio',
  lat: 35.6,
  lon: 139.7,
  network: 'IU',
} as SeismicCity;

/** Respuesta exitosa del backend con la imagen dada. */
function okResponse(image: string) {
  return {
    success: true,
    image,
    metadata: { network: 'IU', station: 'MAJO', generated_at: '2026-08-18T10:00:00Z' },
  };
}

function renderCard() {
  return render(
    <NextIntlClientProvider locale="es" messages={es}>
      <SpectrogramViewReal city={CITY} />
    </NextIntlClientProvider>
  );
}

/** `src` actual de la imagen del espectrograma, o null si no hay ninguna. */
function imagenActual(): string | null {
  const img = screen.queryByRole('img');
  return img ? img.getAttribute('src') : null;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('SpectrogramViewReal — refresco', () => {
  it('mantiene la imagen anterior mientras refresca en segundo plano', async () => {
    // LA aserción del bug: al dispararse el intervalo, la imagen vieja tiene
    // que seguir en pantalla en vez de dejar la tarjeta en blanco.
    let resolverSegundoFetch: ((v: unknown) => void) | undefined;
    getSpectrogramMock
      .mockResolvedValueOnce(okResponse('PRIMERA'))
      .mockImplementationOnce(
        () => new Promise((resolve) => {
          resolverSegundoFetch = resolve;
        })
      );

    renderCard();
    await waitFor(() => expect(imagenActual()).toContain('PRIMERA'));

    // Se dispara el refresco, que queda pendiente sin resolver.
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });

    // Con el bug acá la imagen era null y se veía el spinner.
    expect(imagenActual()).toContain('PRIMERA');

    await act(async () => {
      resolverSegundoFetch?.(okResponse('SEGUNDA'));
    });

    await waitFor(() => expect(imagenActual()).toContain('SEGUNDA'));
  });

  it('no borra la imagen si el refresco de fondo falla', async () => {
    // Un fallo puntual del backend no invalida el espectrograma anterior: lo
    // que está en pantalla sigue siendo dato real de hace un minuto.
    getSpectrogramMock
      .mockResolvedValueOnce(okResponse('PRIMERA'))
      .mockRejectedValueOnce(new Error('backend caído'));

    renderCard();
    await waitFor(() => expect(imagenActual()).toContain('PRIMERA'));

    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });

    expect(imagenActual()).toContain('PRIMERA');
  });

  it('sí muestra el spinner en la primera carga', async () => {
    // El refresco silencioso no debe tapar el estado de carga inicial, cuando
    // todavía no hay nada que mostrar.
    getSpectrogramMock.mockImplementation(
      () => new Promise(() => {}) // nunca resuelve
    );

    renderCard();

    expect(imagenActual()).toBeNull();
  });
});

describe('SpectrogramViewReal — link al detalle de estación', () => {
  it('el SCNL enlaza a /stations con el canal escapado', async () => {
    getSpectrogramMock.mockResolvedValue({
      success: true,
      image: 'IMG',
      metadata: {
        network: 'IU',
        station: 'MAJO',
        channel: 'BHZ',
        generated_at: '2026-08-18T10:00:00Z',
      },
    });

    renderCard();
    await act(async () => {});

    const link = screen.getByRole('link', { name: /IU\.MAJO/ });
    // Location vacío (doble punto): el endpoint lo resuelve con `*`.
    expect(link.getAttribute('href')).toBe('/stations/IU.MAJO..BHZ');
  });

  it('sin channel en el metadata no enlaza — no hay estación que abrir', async () => {
    // El espectrograma sintético no trae `channel`: mostrar un link roto sería
    // peor que no mostrarlo.
    getSpectrogramMock.mockResolvedValue(okResponse('IMG'));

    renderCard();

    // El archivo corre con fake timers: `findBy*` esperaría con timers reales
    // y se colgaría. `act` deja que la promesa del fetch mockeado se resuelva.
    await act(async () => {});

    // El SCNL se muestra igual (hay más de un lugar donde aparece), pero
    // ninguno de ellos es un link.
    expect(screen.getAllByText(/IU\.MAJO/).length).toBeGreaterThan(0);
    expect(screen.queryByRole('link')).toBeNull();
  });
});

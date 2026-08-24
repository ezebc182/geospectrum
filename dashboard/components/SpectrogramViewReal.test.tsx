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

describe('SpectrogramViewReal — eje de tiempo y frecuencia', () => {
  // Estos tres tests no ejercitan el refresco periódico: corren con timers
  // reales para poder usar `findBy*` sin colgarse (ver comentario más abajo,
  // en el describe de link al detalle).
  beforeEach(() => {
    vi.useRealTimers();
  });

  /** Render con la respuesta default (metadata sin `channel`, como MAJO). */
  function renderView() {
    getSpectrogramMock.mockResolvedValue(okResponse('IMG'));
    return renderCard();
  }

  /** Render con un metadata a medida, para casos que necesitan `channel`. */
  function renderViewWithMetadata(metadata: Record<string, unknown>) {
    getSpectrogramMock.mockResolvedValue({
      success: true,
      image: 'IMG',
      metadata: { generated_at: '2026-08-18T10:00:00Z', ...metadata },
    });
    return renderCard();
  }

  it('rotula el eje de tiempo segun las horas que realmente pidio', async () => {
    // Antes decía -24h/-18h/-12h/-6h fijo, sin relación con el rango real.
    // Acá el fetch pide 24h (constante del componente) y el metadata no trae
    // `duration_hours`, así que cae al valor pedido: mismo resultado.
    renderView();
    await screen.findByRole('img');
    expect(screen.getByTestId('spectrogram-time-axis')).toHaveTextContent('-24h');
  });

  it('avisa que el eje de frecuencia es fijo y no el del canal', async () => {
    // El backend renderiza SIEMPRE 0.1-20 Hz (generate_spectrogram_image), pero
    // el techo real depende del muestreo: hay canales de 10, 20 y 25 Hz. Un eje
    // fijo miente por factor 2 en los de 10. No se puede corregir la imagen ya
    // renderizada, pero sí se puede decir qué eje es.
    renderView();
    await screen.findByRole('img');
    expect(screen.getByTestId('spectrogram-freq-axis')).toHaveAttribute(
      'title',
      expect.stringMatching(/0[.,]1.*20 ?Hz/i),
    );
  });

  it('enlaza al espectrograma con eje real de la estacion', async () => {
    // La salida honesta: el canvas de /stations/[channel] SÍ deriva el eje del
    // dato. Si el PNG no puede decir la verdad, al menos indica dónde está.
    renderViewWithMetadata({ network: 'AR', station: 'TEST', channel: 'HHZ' });
    expect(await screen.findByTestId('accurate-axis-link')).toHaveAttribute(
      'href',
      '/stations/AR.TEST..HHZ',
    );
  });

  it('usa duration_hours del metadata cuando el backend lo manda distinto al pedido', async () => {
    // Si el backend alguna vez difiere de lo pedido (reintento con otra
    // ventana, versión vieja vs nueva), el eje tiene que reflejar lo que
    // EFECTIVAMENTE se renderizó, no lo que el frontend creyó pedir.
    renderViewWithMetadata({ network: 'AR', station: 'TEST', duration_hours: 12 });
    await screen.findByRole('img');
    expect(screen.getByTestId('spectrogram-time-axis')).toHaveTextContent('-12h');
    expect(screen.getByTestId('spectrogram-time-axis')).not.toHaveTextContent('-24h');
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

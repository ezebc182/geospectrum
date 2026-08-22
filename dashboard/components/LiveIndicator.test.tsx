/**
 * Tests del indicador del stream (PR-W4, T12).
 *
 * `formats` se importa de @/i18n/request — la config REAL de la app — y no se
 * copia a mano: un harness que inventa su propia config prueba una app que no
 * existe (el falso verde que documenta LiveSpectrogramCanvas.test.tsx:16-17).
 *
 * Lo que se fija: que cada estado tenga texto propio (el color no comunica
 * nada a un lector de pantalla) y que el texto se pueda ocultar sin perder
 * accesibilidad — el sidebar colapsado sólo tiene lugar para el punto.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it } from 'vitest';

import { LiveIndicator } from './LiveIndicator';
import { formats } from '@/i18n/request';
import es from '@/messages/es.json';
import type { StreamStatus } from '@/hooks/use-event-stream';

function renderIndicator(status: StreamStatus, props = {}) {
  return render(
    <NextIntlClientProvider locale="es-AR" messages={es} formats={formats} timeZone="UTC">
      <LiveIndicator status={status} {...props} />
    </NextIntlClientProvider>,
  );
}

afterEach(() => {
  cleanup();
});

describe('LiveIndicator — texto por estado', () => {
  it('live dice "En vivo"', () => {
    renderIndicator('live');
    expect(screen.getByText('En vivo')).toBeTruthy();
  });

  it('reconnecting se distingue de offline', () => {
    /**
     * Dos estados distintos con dos mensajes distintos: "reconectando" le
     * dice al usuario que espere, "sin conexión" que algo anda mal. Un solo
     * mensaje para ambos lo dejaría esperando para siempre.
     */
    renderIndicator('reconnecting');
    expect(screen.getByText('Reconectando…')).toBeTruthy();
    cleanup();

    renderIndicator('offline');
    expect(screen.getByText('Sin conexión')).toBeTruthy();
  });

  it('connecting tiene su propio texto', () => {
    renderIndicator('connecting');
    expect(screen.getByText('Conectando…')).toBeTruthy();
  });
});

describe('LiveIndicator — accesibilidad', () => {
  it('se anuncia como status con aria-live', () => {
    /** El color no comunica nada sin vista. */
    renderIndicator('live');
    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
  });

  it('sin label visible el texto igual llega al lector de pantalla', () => {
    renderIndicator('live', { showLabel: false });
    expect(screen.getByText('En vivo')).toBeTruthy();
  });

  it('el title lleva el estado, para el sidebar colapsado', () => {
    renderIndicator('offline');
    expect(screen.getByRole('status').getAttribute('title')).toBe('Sin conexión');
  });

  it('el punto de color es decorativo', () => {
    /** Sin aria-hidden el lector anunciaría un elemento vacío sin sentido. */
    const { container } = renderIndicator('live');
    expect(container.querySelector('[aria-hidden="true"]')).toBeTruthy();
  });
});

describe('LiveIndicator — semáforo', () => {
  it('live es verde y pulsa', () => {
    const { container } = renderIndicator('live');
    const dot = container.querySelector('[aria-hidden="true"]');
    expect(dot?.className).toContain('bg-green-400');
    expect(dot?.className).toContain('animate-pulse');
  });

  it('offline es rojo', () => {
    const { container } = renderIndicator('offline');
    expect(container.querySelector('[aria-hidden="true"]')?.className).toContain('bg-red-500');
  });

  it('reconnecting es amarillo, no rojo', () => {
    /**
     * Rojo mientras reintenta le diría al usuario "está roto" cuando en
     * realidad está por volver.
     */
    const { container } = renderIndicator('reconnecting');
    const dot = container.querySelector('[aria-hidden="true"]');
    expect(dot?.className).toContain('bg-yellow-400');
    expect(dot?.className).not.toContain('bg-red-500');
  });
});

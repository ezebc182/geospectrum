/**
 * La campanita con estado de leídas: el badge cuenta lo NO LEÍDO, marcar
 * una o todas limpia el contador, y el estado persiste en localStorage.
 *
 * El dropdown de Radix se abre por TECLADO (Enter): en jsdom los pointer
 * events de Radix son poco confiables y el teclado es el camino estable.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { SWRConfig } from 'swr';
import { afterEach, describe, expect, it, vi } from 'vitest';

import es from '@/messages/es.json';
import {
  READ_ALERTS_STORAGE_KEY,
  alertFingerprint,
  loadReadFingerprints,
} from '@/lib/alert-read-state';
import { reportFetcher } from '@/lib/api';
import { NotificationBell } from './NotificationBell';

vi.mock('@/lib/api', () => ({
  reportFetcher: vi.fn(),
}));

const SWARM = {
  tipo: 'enjambre' as const,
  descripcion: '3 eventos M>=3 en <=15min y <=20km',
  eventos_relacionados: ['emsc_a', 'emsc_b'],
};

const FELT = {
  tipo: 'actividad_sentida' as const,
  descripcion: 'Evento sentido cerca de Lima',
  eventos_relacionados: ['usgs_x'],
};

function arrange(alertas: unknown[] = [SWARM, FELT]) {
  vi.mocked(reportFetcher).mockResolvedValue({ alertas } as never);
}

function renderBell() {
  return render(
    <NextIntlClientProvider locale="es-AR" messages={es} timeZone="UTC">
      {/* Cache de SWR NUEVO por test: sin esto, el /report de un test se
          filtra al siguiente y los asertos mienten. */}
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <NotificationBell />
      </SWRConfig>
    </NextIntlClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.mocked(reportFetcher).mockReset();
});

describe('NotificationBell — leídas', () => {
  it('el badge cuenta las alertas sin leer, no todas las activas', async () => {
    localStorage.setItem(
      READ_ALERTS_STORAGE_KEY,
      JSON.stringify([alertFingerprint(SWARM)]),
    );
    arrange();
    renderBell();

    // 2 activas, 1 leída ⇒ el badge dice 1.
    await waitFor(() =>
      expect(screen.getByLabelText('Alertas sin leer: 1')).toBeTruthy(),
    );
  });

  it('con todas leídas la campanita queda limpia (sin badge)', async () => {
    localStorage.setItem(
      READ_ALERTS_STORAGE_KEY,
      JSON.stringify([alertFingerprint(SWARM), alertFingerprint(FELT)]),
    );
    arrange();
    renderBell();

    await waitFor(() =>
      expect(screen.getByLabelText('Alertas sin leer: 0')).toBeTruthy(),
    );
    // Sin no-leídas el badge numérico no se renderiza.
    expect(screen.queryByText('0')).toBeNull();
  });

  it('marcar UNA como leída baja el contador y persiste en localStorage', async () => {
    arrange();
    renderBell();
    const trigger = await screen.findByLabelText('Alertas sin leer: 2');
    fireEvent.keyDown(trigger, { key: 'Enter' });

    const [firstMark] = await screen.findAllByLabelText('Marcar como leída');
    fireEvent.click(firstMark);

    await waitFor(() =>
      expect(screen.getByLabelText('Alertas sin leer: 1')).toBeTruthy(),
    );
    expect(loadReadFingerprints().size).toBe(1);
  });

  it('«Marcar todas» limpia el badge y guarda todas las huellas', async () => {
    arrange();
    renderBell();
    const trigger = await screen.findByLabelText('Alertas sin leer: 2');
    fireEvent.keyDown(trigger, { key: 'Enter' });

    fireEvent.click(await screen.findByText('Marcar todas'));

    await waitFor(() =>
      expect(screen.getByLabelText('Alertas sin leer: 0')).toBeTruthy(),
    );
    expect(loadReadFingerprints()).toEqual(
      new Set([alertFingerprint(SWARM), alertFingerprint(FELT)]),
    );
  });

  it('una alerta leída se atenúa pero SIGUE en la lista: activa es activa', async () => {
    localStorage.setItem(
      READ_ALERTS_STORAGE_KEY,
      JSON.stringify([alertFingerprint(SWARM)]),
    );
    arrange();
    renderBell();
    const trigger = await screen.findByLabelText('Alertas sin leer: 1');
    fireEvent.keyDown(trigger, { key: 'Enter' });

    // La leída no desaparece: el backend la sigue reportando activa.
    const row = (await screen.findByText(SWARM.descripcion)).closest('[data-read]');
    expect(row).not.toBeNull();
  });
});

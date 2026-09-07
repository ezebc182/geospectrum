/**
 * Selector de canales de /analytics (analytics-professional-panels, 5.2;
 * spec dashboard-ui "Resuelto por el design" §2: hasta 4 canales del
 * `station-catalog`, badge `is_live`).
 *
 * El catálogo llega por `seismicAPI.getStationCatalog` (mockeado). Lo que se
 * afirma: el tope de 4 — el 5.º click NO llama a `onChange` y muestra el
 * aviso `max4` —, que el badge de vivo aparece solo en los `is_live`, y que
 * los textos salen de los JSON reales vía `t(...)` (molde SpectrumView.test).
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import es from '@/messages/es.json';
import { seismicAPI } from '@/lib/api';
import type { StationCatalogEntry } from '@/lib/types';
import { IntlTestProvider } from '@/lib/test-intl';
import { MAX_PICKED_CHANNELS, StationPicker } from './StationPicker';

vi.mock('@/lib/api', () => ({
  seismicAPI: { getStationCatalog: vi.fn() },
}));

function entry(channel: string, over: Partial<StationCatalogEntry> = {}): StationCatalogEntry {
  const [network, station] = channel.split('.');
  return { channel, city_id: 'santiago', network, station, is_live: true, is_primary: false, ...over };
}

const CATALOG: StationCatalogEntry[] = [
  entry('C1.MT01..HHZ'),
  entry('C1.MT02..HHZ', { is_live: false }),
  entry('C1.MT03..HHZ'),
  entry('C1.MT04..HHZ'),
  entry('C1.MT05..HHZ'),
];

function renderPicker(selected: string[] = []) {
  const onChange = vi.fn();
  render(
    <IntlTestProvider>
      <StationPicker selected={selected} onChange={onChange} />
    </IntlTestProvider>,
  );
  return { onChange };
}

afterEach(() => {
  cleanup();
  vi.mocked(seismicAPI.getStationCatalog).mockReset();
});

describe('StationPicker', () => {
  it('el tope es 4 canales', () => {
    expect(MAX_PICKED_CHANNELS).toBe(4);
  });

  it('muestra el loader i18n mientras el catálogo está en vuelo', () => {
    vi.mocked(seismicAPI.getStationCatalog).mockReturnValue(new Promise(() => {}));
    renderPicker();
    expect(screen.getByRole('status').textContent).toContain(es.analytics.picker.loading);
  });

  it('lista el catálogo con un botón por canal y el badge de vivo solo en los is_live', async () => {
    vi.mocked(seismicAPI.getStationCatalog).mockResolvedValue(CATALOG);
    renderPicker();
    const first = await screen.findByRole('button', { name: /C1\.MT01\.\.HHZ/ });
    expect(first).toHaveAttribute('aria-pressed', 'false');
    const live = screen.getAllByText(es.analytics.picker.live);
    // 5 entradas, 1 muda ⇒ 4 badges
    expect(live).toHaveLength(4);
    expect(screen.getByRole('button', { name: /C1\.MT02\.\.HHZ/ }).textContent).not.toContain(
      es.analytics.picker.live,
    );
  });

  it('un click agrega el canal (onChange con la lista nueva) y el activo lleva aria-pressed', async () => {
    vi.mocked(seismicAPI.getStationCatalog).mockResolvedValue(CATALOG);
    const { onChange } = renderPicker(['C1.MT01..HHZ']);
    const second = await screen.findByRole('button', { name: /C1\.MT02\.\.HHZ/ });
    expect(screen.getByRole('button', { name: /C1\.MT01\.\.HHZ/ })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(second);
    expect(onChange).toHaveBeenCalledWith(['C1.MT01..HHZ', 'C1.MT02..HHZ']);
  });

  it('un click sobre un canal ya elegido lo quita', async () => {
    vi.mocked(seismicAPI.getStationCatalog).mockResolvedValue(CATALOG);
    const { onChange } = renderPicker(['C1.MT01..HHZ', 'C1.MT03..HHZ']);
    fireEvent.click(await screen.findByRole('button', { name: /C1\.MT01\.\.HHZ/ }));
    expect(onChange).toHaveBeenCalledWith(['C1.MT03..HHZ']);
  });

  it('el 5.º canal NO se agrega y aparece el aviso max4', async () => {
    vi.mocked(seismicAPI.getStationCatalog).mockResolvedValue(CATALOG);
    const four = CATALOG.slice(0, 4).map((e) => e.channel);
    const { onChange } = renderPicker(four);
    expect(screen.queryByText(es.analytics.picker.max4)).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: /C1\.MT05\.\.HHZ/ }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText(es.analytics.picker.max4)).toBeInTheDocument();
  });

  it('una falla del catálogo muestra el error i18n, no una lista vacía', async () => {
    vi.mocked(seismicAPI.getStationCatalog).mockRejectedValue(new Error('500'));
    renderPicker();
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain(es.analytics.picker.error);
    });
  });
});

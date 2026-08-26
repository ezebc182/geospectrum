/**
 * Miniatura de mapa del detalle de estación: orientación, no navegación.
 *
 * Leaflet REAL sobre jsdom (misma decisión que map-locale-popups.test.tsx:
 * mockear el módulo produce dos instancias según el tick del import()).
 * El marcador es un divIcon a propósito — el icono default de Leaflet
 * referencia PNGs que Next no sirve sin config extra, y un vector (circle)
 * revienta en jsdom sin renderer stub.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';

import { StationMiniMap } from './StationMiniMap';

afterEach(cleanup);

describe('StationMiniMap', () => {
  it('inicializa Leaflet centrado y con marcador', async () => {
    const { container } = render(<StationMiniMap latitude={34.05} longitude={-118.24} />);

    await waitFor(() => {
      expect(container.querySelector('.leaflet-container')).not.toBeNull();
    });
    // El marcador divIcon queda en el DOM como .leaflet-marker-icon.
    await waitFor(() => {
      expect(container.querySelector('.leaflet-marker-icon')).not.toBeNull();
    });
  });

  it('no es interactivo: sin drag ni controles de zoom', async () => {
    const { container } = render(<StationMiniMap latitude={34.05} longitude={-118.24} />);

    await waitFor(() => {
      expect(container.querySelector('.leaflet-container')).not.toBeNull();
    });
    const map = container.querySelector('.leaflet-container') as HTMLElement;
    // Leaflet pone la clase de cursor `leaflet-grab` SOLO con dragging
    // habilitado: su ausencia es el observable de "no interactivo".
    expect(map.className).not.toContain('leaflet-grab');
    expect(container.querySelector('.leaflet-control-zoom')).toBeNull();
  });

  it('es decorativo para lectores de pantalla', () => {
    const { container } = render(<StationMiniMap latitude={34.05} longitude={-118.24} />);
    // querySelector y no firstChild: el componente también emite el <link>
    // del CSS de Leaflet antes del div del mapa.
    expect(container.querySelector('div')?.getAttribute('aria-hidden')).toBe('true');
  });
});

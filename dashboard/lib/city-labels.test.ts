import { describe, expect, it } from 'vitest';

import { minPopulationForZoom, shouldShowCityLabel } from './city-labels';

describe('minPopulationForZoom', () => {
  it('exige más población cuanto más lejos está la cámara', () => {
    expect(minPopulationForZoom(4)).toBeGreaterThan(minPopulationForZoom(6));
    expect(minPopulationForZoom(6)).toBeGreaterThan(minPopulationForZoom(8));
  });

  it('deja de filtrar cuando el zoom es alto', () => {
    // Acercado a una sola región los nombres ya no compiten entre sí.
    expect(minPopulationForZoom(10)).toBe(0);
    expect(minPopulationForZoom(15)).toBe(0);
  });
});

describe('shouldShowCityLabel', () => {
  it('a nivel continental deja solo las megaciudades', () => {
    // Zoom 4 es el del problema original: Bogotá, Quito, Trujillo y Tucumán
    // apilados en 200 píxeles.
    expect(shouldShowCityLabel(20_000_000, 4)).toBe(true); // São Paulo
    expect(shouldShowCityLabel(900_000, 4)).toBe(false); // Trujillo
  });

  it('deja fuera a las ciudades grandes que no son megaciudades', () => {
    // Con la lista mundial de 84 ciudades, un corte de 8M dejaba 27 etiquetas
    // a zoom 4 y el apilamiento volvía. Santiago y Madrid son grandes pero a
    // nivel continental no aportan referencia sobre las que ya están.
    expect(shouldShowCityLabel(6_800_000, 4)).toBe(false); // Santiago
    expect(shouldShowCityLabel(6_700_000, 4)).toBe(false); // Madrid
    expect(shouldShowCityLabel(37_000_000, 4)).toBe(true); // Tokio
  });

  it('muestra las ciudades medianas al acercarse', () => {
    const trujillo = 900_000;

    expect(shouldShowCityLabel(trujillo, 4)).toBe(false);
    expect(shouldShowCityLabel(trujillo, 9)).toBe(true);
  });

  it('nunca oculta una ciudad al acercarse más', () => {
    // Que un nombre aparezca y vuelva a desaparecer al hacer zoom in es
    // desconcertante: la visibilidad tiene que ser monótona.
    const poblaciones = [500_000, 2_000_000, 9_000_000];

    for (const poblacion of poblaciones) {
      let visibleAntes = false;
      for (let zoom = 3; zoom <= 12; zoom++) {
        const visible = shouldShowCityLabel(poblacion, zoom);
        if (visibleAntes) expect(visible).toBe(true);
        visibleAntes = visible;
      }
    }
  });

  it('incluye a la ciudad que está justo en el umbral', () => {
    expect(shouldShowCityLabel(15_000_000, 4)).toBe(true);
    expect(shouldShowCityLabel(14_999_999, 4)).toBe(false);
  });
});

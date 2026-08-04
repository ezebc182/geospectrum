import { describe, expect, it } from 'vitest';

import { MAJOR_CITIES } from './major-cities';

describe('MAJOR_CITIES', () => {
  it('cubre todos los continentes, no solo Sudamérica', () => {
    // La lista original tenía 30 ciudades y las 30 eran sudamericanas, resto
    // de cuando el proyecto miraba solo los Andes. Con ingesta global eso deja
    // a Tokio sin nombre y a Mendoza con nombre.
    const paises = new Set(MAJOR_CITIES.map((c) => c.country));

    expect(paises.has('Japón')).toBe(true);
    expect(paises.has('Turquía')).toBe(true);
    expect(paises.has('Estados Unidos')).toBe(true);
    expect(paises.has('Nueva Zelanda')).toBe(true);
    expect(paises.has('Indonesia')).toBe(true);
  });

  it('reparte las ciudades entre hemisferios', () => {
    // Un chequeo grosero de sesgo: si todo cae de un lado, la lista volvió a
    // ser regional sin que nadie lo note.
    const este = MAJOR_CITIES.filter((c) => c.lon > 0).length;
    const oeste = MAJOR_CITIES.filter((c) => c.lon < 0).length;

    expect(este).toBeGreaterThan(10);
    expect(oeste).toBeGreaterThan(10);
  });

  it('incluye ciudades chicas sobre fallas activas', () => {
    // El criterio de la lista no es "las más grandes" sino "las que sirven
    // para ubicar un sismo": Wellington con 420 mil habitantes ubica mejor un
    // evento en Nueva Zelanda que cualquier megaciudad del otro lado.
    const wellington = MAJOR_CITIES.find((c) => c.name === 'Wellington');

    expect(wellington).toBeDefined();
    expect(wellington!.population).toBeLessThan(1_000_000);
  });

  it('no tiene ciudades duplicadas por nombre', () => {
    const nombres = MAJOR_CITIES.map((c) => c.name);

    expect(nombres.length).toBe(new Set(nombres).size);
  });

  it('tiene coordenadas válidas en todas las ciudades', () => {
    // Una coordenada invertida no da error: pone la ciudad en el lugar
    // equivocado y el mapa se ve plausible.
    for (const city of MAJOR_CITIES) {
      expect(Math.abs(city.lat), `${city.name} lat`).toBeLessThanOrEqual(90);
      expect(Math.abs(city.lon), `${city.name} lon`).toBeLessThanOrEqual(180);
      expect(city.population, `${city.name} población`).toBeGreaterThan(0);
    }
  });
});

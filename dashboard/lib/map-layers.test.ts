/**
 * Capa base gris de CARTO con API key opcional.
 *
 * Lo que se protege acá es la DEGRADACIÓN: sin `NEXT_PUBLIC_CARTO_API_KEY`
 * la URL tiene que ser EXACTAMENTE la de siempre, sin `?` colgado ni el
 * string `undefined`. Un `?api_key=undefined` no rompe el build ni los tipos:
 * rompe los tiles en runtime, en silencio, y sólo se ve en el navegador.
 *
 * La var se lee a nivel de módulo, así que cada rama necesita su propio
 * `vi.resetModules()` + import dinámico: un import estático arriba dejaría
 * clavado el valor del primer test.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const URL_SIN_KEY = 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png';

/** Importa el módulo fresco con la var puesta (o borrada si es `undefined`). */
async function importarConKey(key: string | undefined) {
  vi.resetModules();
  if (key === undefined) {
    delete process.env.NEXT_PUBLIC_CARTO_API_KEY;
  } else {
    process.env.NEXT_PUBLIC_CARTO_API_KEY = key;
  }
  return import('./map-layers');
}

afterEach(() => {
  delete process.env.NEXT_PUBLIC_CARTO_API_KEY;
  vi.resetModules();
});

describe('BASE_LAYERS.greyscale (CARTO Positron)', () => {
  it('sin la var, la URL es idéntica a la histórica: ni "?" ni "undefined"', async () => {
    const { BASE_LAYERS } = await importarConKey(undefined);

    expect(BASE_LAYERS.greyscale.url).toBe(URL_SIN_KEY);
    expect(BASE_LAYERS.greyscale.url).not.toContain('?');
    expect(BASE_LAYERS.greyscale.url).not.toContain('undefined');
    expect(BASE_LAYERS.greyscale.url).not.toContain('api_key');
  });

  it('con la var vacía o en blanco degrada igual que si no estuviera', async () => {
    for (const vacia of ['', '   ']) {
      const { BASE_LAYERS } = await importarConKey(vacia);
      expect(BASE_LAYERS.greyscale.url).toBe(URL_SIN_KEY);
    }
  });

  it('con la var puesta, agrega ?api_key= al final y conserva los placeholders', async () => {
    const { BASE_LAYERS } = await importarConKey('abc123');
    const url = BASE_LAYERS.greyscale.url;

    expect(url).toBe(`${URL_SIN_KEY}?api_key=abc123`);
    // Un solo `?`: la URL base no traía query string.
    expect(url.match(/\?/g)).toHaveLength(1);
    // Los placeholders de Leaflet siguen intactos y ANTES del query string.
    for (const ph of ['{s}', '{z}', '{x}', '{y}']) {
      expect(url).toContain(ph);
      expect(url.indexOf(ph)).toBeLessThan(url.indexOf('?'));
    }
  });

  it('escapa la key para que no rompa el query string', async () => {
    const { BASE_LAYERS } = await importarConKey('a b&c=d');
    expect(BASE_LAYERS.greyscale.url).toBe(`${URL_SIN_KEY}?api_key=${encodeURIComponent('a b&c=d')}`);
  });

  it('conserva la atribución doble (término de uso de CARTO) y el maxZoom, con y sin key', async () => {
    for (const key of [undefined, 'abc123']) {
      const { BASE_LAYERS } = await importarConKey(key);
      expect(BASE_LAYERS.greyscale.attribution).toBe('© OpenStreetMap contributors © CARTO');
      expect(BASE_LAYERS.greyscale.maxZoom).toBe(20);
    }
  });

  it('la key no toca ninguna otra capa base', async () => {
    const { BASE_LAYERS } = await importarConKey('abc123');
    for (const [id, layer] of Object.entries(BASE_LAYERS)) {
      if (id === 'greyscale') continue;
      expect(layer.url).not.toContain('api_key');
    }
  });
});

describe('BaseLayerId', () => {
  it('mantiene las claves que alimentan el switcher y las claves i18n map.baseLayers.<id>', async () => {
    const { BASE_LAYERS } = await importarConKey(undefined);
    expect(Object.keys(BASE_LAYERS).sort()).toEqual(
      ['greyscale', 'ocean', 'satellite', 'street', 'terrain'].sort(),
    );
  });
});

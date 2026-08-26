/**
 * Estado de "leída" de las alertas de la campanita.
 *
 * Las alertas son DERIVADAS (el backend las recalcula en cada /report, sin
 * id propio), así que la identidad es una huella tipo+eventos. Propiedad
 * deliberada: si un enjambre suma un evento nuevo, la huella cambia y la
 * alerta vuelve a "no leída" — información nueva re-notifica.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  MAX_READ_FINGERPRINTS,
  READ_ALERTS_STORAGE_KEY,
  alertFingerprint,
  countUnread,
  loadReadFingerprints,
  saveReadFingerprints,
} from '@/lib/alert-read-state';

const SWARM = {
  tipo: 'enjambre' as const,
  descripcion: '3 eventos M>=3 en <=15min y <=20km',
  eventos_relacionados: ['emsc_b', 'emsc_a'],
};

const FELT = {
  tipo: 'actividad_sentida' as const,
  descripcion: 'Evento sentido cerca de Lima',
  eventos_relacionados: ['usgs_x'],
};

afterEach(() => {
  localStorage.clear();
});

describe('alertFingerprint', () => {
  it('es estable ante el ORDEN de los eventos relacionados', () => {
    const reordered = { ...SWARM, eventos_relacionados: ['emsc_a', 'emsc_b'] };
    expect(alertFingerprint(SWARM)).toBe(alertFingerprint(reordered));
  });

  it('cambia cuando el enjambre suma un evento nuevo (re-notificar es correcto)', () => {
    const grown = { ...SWARM, eventos_relacionados: ['emsc_a', 'emsc_b', 'emsc_c'] };
    expect(alertFingerprint(grown)).not.toBe(alertFingerprint(SWARM));
  });

  it('dos tipos distintos con los mismos eventos NO colisionan', () => {
    const otherType = { ...SWARM, tipo: 'evento_significativo' as const };
    expect(alertFingerprint(otherType)).not.toBe(alertFingerprint(SWARM));
  });

  it('sin eventos relacionados cae a la descripción, no a una huella vacía', () => {
    const a = { tipo: 'enjambre' as const, descripcion: 'uno', eventos_relacionados: [] };
    const b = { tipo: 'enjambre' as const, descripcion: 'otro', eventos_relacionados: [] };
    expect(alertFingerprint(a)).not.toBe(alertFingerprint(b));
  });
});

describe('load/save — tolerancia al storage hostil', () => {
  it('sin nada guardado devuelve un set vacío', () => {
    expect(loadReadFingerprints().size).toBe(0);
  });

  it('JSON corrupto devuelve un set vacío sin lanzar', () => {
    localStorage.setItem(READ_ALERTS_STORAGE_KEY, '{no-es-json');
    expect(loadReadFingerprints().size).toBe(0);
  });

  it('un valor que no es lista de strings devuelve un set vacío', () => {
    localStorage.setItem(READ_ALERTS_STORAGE_KEY, JSON.stringify({ x: 1 }));
    expect(loadReadFingerprints().size).toBe(0);
    localStorage.setItem(READ_ALERTS_STORAGE_KEY, JSON.stringify([1, 2, 3]));
    expect(loadReadFingerprints().size).toBe(0);
  });

  it('lo guardado se recupera en el mismo orden de inserción', () => {
    saveReadFingerprints(new Set(['a', 'b']));
    expect([...loadReadFingerprints()]).toEqual(['a', 'b']);
  });

  it('el storage queda acotado: sobreviven las ÚLTIMAS huellas, no las primeras', () => {
    const many = new Set(
      Array.from({ length: MAX_READ_FINGERPRINTS + 10 }, (_, i) => `fp-${i}`),
    );
    saveReadFingerprints(many);
    const loaded = loadReadFingerprints();
    expect(loaded.size).toBe(MAX_READ_FINGERPRINTS);
    // Se recorta por el frente (FIFO): la más vieja se va, la más nueva queda.
    expect(loaded.has('fp-0')).toBe(false);
    expect(loaded.has(`fp-${MAX_READ_FINGERPRINTS + 9}`)).toBe(true);
  });
});

describe('countUnread', () => {
  it('cuenta solo las alertas cuya huella NO está leída', () => {
    const read = new Set([alertFingerprint(SWARM)]);
    expect(countUnread([SWARM, FELT], read)).toBe(1);
  });

  it('con todas leídas la campanita queda limpia', () => {
    const read = new Set([alertFingerprint(SWARM), alertFingerprint(FELT)]);
    expect(countUnread([SWARM, FELT], read)).toBe(0);
  });
});

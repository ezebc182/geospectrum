/**
 * Settings manuales del helicorder (spec §61, filosofía SWARM).
 *
 * El auto-clip por percentil sirve como PUNTO DE PARTIDA, no como verdad: un
 * sismo real vive en la cola superior de la distribución, así que cualquier
 * percentil lo suficientemente bajo como para escalar el ruido de fondo pinta
 * el evento entero de rojo y lo clampea contra el borde de la fila. SWARM
 * resuelve esto dejando que el operador mueva el clip. Estos tests fijan el
 * contrato de esos controles.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  HELICORDER_DEFAULTS,
  clampBarMult,
  clampClipMult,
  effectiveClip,
  loadHelicorderSettings,
  saveHelicorderSettings,
  settingsStorageKey,
} from './helicorder-settings';

describe('escala efectiva del clip', () => {
  it('con clipMult=1 el clip efectivo es el auto — el default no cambia lo que ya se ve', () => {
    expect(effectiveClip(400, 1)).toBeCloseTo(400);
  });

  it('subir clipMult sube el umbral: menos muestras clipean y el sismo se lee', () => {
    // Este es EL caso del bug: con auto=400 un sismo de 3000 clipeaba entero.
    // Con clipMult=8 el umbral pasa a 3200 y el evento entra sin saturar.
    expect(effectiveClip(400, 8)).toBeCloseTo(3200);
  });

  it('bajar clipMult exagera el ruido de fondo — el uso inverso, ver microsismicidad', () => {
    expect(effectiveClip(400, 0.25)).toBeCloseTo(100);
  });

  it('nunca devuelve 0 ni negativo — sería división por cero al escalar', () => {
    expect(effectiveClip(0, 1)).toBeGreaterThan(0);
    expect(effectiveClip(400, 0)).toBeGreaterThan(0);
    expect(effectiveClip(-400, 1)).toBeGreaterThan(0);
  });
});

describe('clamps de los controles', () => {
  it('clipMult queda dentro del rango del slider', () => {
    expect(clampClipMult(0.001)).toBe(HELICORDER_DEFAULTS.clipMultMin);
    expect(clampClipMult(9999)).toBe(HELICORDER_DEFAULTS.clipMultMax);
    expect(clampClipMult(2)).toBe(2);
  });

  it('barMult queda dentro del rango del slider', () => {
    expect(clampBarMult(0.001)).toBe(HELICORDER_DEFAULTS.barMultMin);
    expect(clampBarMult(9999)).toBe(HELICORDER_DEFAULTS.barMultMax);
    expect(clampBarMult(3)).toBe(3);
  });

  it('un valor no numérico cae al default en vez de propagar NaN al canvas', () => {
    expect(clampClipMult(NaN)).toBe(HELICORDER_DEFAULTS.clipMult);
    expect(clampBarMult(NaN)).toBe(HELICORDER_DEFAULTS.barMult);
  });
});

describe('persistencia por canal', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('la clave incluye el canal — dos estaciones no comparten escala', () => {
    expect(settingsStorageKey('IU.MAJO..BHZ')).not.toBe(settingsStorageKey('C1.VA01..BHZ'));
    expect(settingsStorageKey('IU.MAJO..BHZ')).toContain('IU.MAJO..BHZ');
  });

  it('guarda y recupera lo mismo', () => {
    saveHelicorderSettings('IU.MAJO..BHZ', { clipMult: 4, barMult: 2, timeChunkMinutes: 15 });
    expect(loadHelicorderSettings('IU.MAJO..BHZ')).toEqual({
      clipMult: 4,
      barMult: 2,
      timeChunkMinutes: 15,
    });
  });

  it('un canal sin settings guardados devuelve los defaults', () => {
    expect(loadHelicorderSettings('NUEVO.CANAL..BHZ')).toEqual({
      clipMult: HELICORDER_DEFAULTS.clipMult,
      barMult: HELICORDER_DEFAULTS.barMult,
      timeChunkMinutes: HELICORDER_DEFAULTS.timeChunkMinutes,
    });
  });

  it('JSON corrupto en localStorage no rompe la vista, cae a defaults', () => {
    localStorage.setItem(settingsStorageKey('IU.MAJO..BHZ'), '{no es json');
    expect(loadHelicorderSettings('IU.MAJO..BHZ').clipMult).toBe(HELICORDER_DEFAULTS.clipMult);
  });

  it('valores fuera de rango guardados a mano se clampean al leer', () => {
    localStorage.setItem(
      settingsStorageKey('IU.MAJO..BHZ'),
      JSON.stringify({ clipMult: 99999, barMult: -5, timeChunkMinutes: 30 }),
    );
    const s = loadHelicorderSettings('IU.MAJO..BHZ');
    expect(s.clipMult).toBe(HELICORDER_DEFAULTS.clipMultMax);
    expect(s.barMult).toBe(HELICORDER_DEFAULTS.barMultMin);
  });

  it('un timeChunk que no está en la lista cae al default — el eje X no se inventa', () => {
    localStorage.setItem(
      settingsStorageKey('IU.MAJO..BHZ'),
      JSON.stringify({ clipMult: 1, barMult: 1, timeChunkMinutes: 7 }),
    );
    expect(loadHelicorderSettings('IU.MAJO..BHZ').timeChunkMinutes).toBe(
      HELICORDER_DEFAULTS.timeChunkMinutes,
    );
  });
});

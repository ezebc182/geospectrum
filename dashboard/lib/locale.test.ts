import { describe, expect, it } from 'vitest';

import { isAppLocale, setLocaleCookie, toAppLocale } from './locale';

describe('toAppLocale', () => {
  it('colapsa es-AR a es', () => {
    expect(toAppLocale('es-AR')).toBe('es');
  });

  it('colapsa en-US a en', () => {
    expect(toAppLocale('en-US')).toBe('en');
  });

  it('acepta el tag pelado en', () => {
    expect(toAppLocale('en')).toBe('en');
  });

  it('un idioma no soportado cae al default es', () => {
    expect(toAppLocale('fr')).toBe('es');
    expect(toAppLocale('fr-FR')).toBe('es');
  });

  it('es case-insensitive (los headers pueden venir en mayúsculas)', () => {
    expect(toAppLocale('EN-us')).toBe('en');
  });
});

describe('isAppLocale', () => {
  it('acepta solo es y en', () => {
    expect(isAppLocale('es')).toBe(true);
    expect(isAppLocale('en')).toBe(true);
    expect(isAppLocale('fr')).toBe(false);
    expect(isAppLocale('es-AR')).toBe(false);
    expect(isAppLocale(undefined)).toBe(false);
  });
});

describe('setLocaleCookie', () => {
  it('escribe NEXT_LOCALE con path=/ (legible por el server en todo el sitio)', () => {
    setLocaleCookie('en');
    expect(document.cookie).toContain('NEXT_LOCALE=en');
  });
});

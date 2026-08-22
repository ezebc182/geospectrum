/**
 * Contrato de zona horaria de la app.
 *
 * El bug que estos tests bloquean (vivo durante todo el PR-W3): `formats`
 * tenía `timeZone: 'UTC'` dentro de cada formato nombrado, pero el return de
 * getRequestConfig NO traía `timeZone` global. Resultado: las llamadas por
 * nombre — format.dateTime(d, 'medium') — salían en UTC, y las que pasan
 * opciones inline — format.dateTime(d, {hour:'2-digit'}) — caían a la zona
 * del navegador. Cinco call-sites de producción corrían corridos hasta 14 h.
 *
 * IMPORTANTE — cómo se testea esto y por qué: la config se lee EJECUTANDO el
 * callback real de getRequestConfig, no reimplantándolo. Una primera versión
 * de este archivo armaba el formatter con una constante APP_TIME_ZONE
 * paralela: borrar el `timeZone` de request.ts dejaba los tests en verde,
 * exactamente el falso verde que el PR vino a matar. Verificado por mutación.
 */
import { createFormatter } from 'use-intl/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Captura el callback que request.ts le pasa a getRequestConfig, para poder
// ejecutarlo acá con headers/cookies controlados.
const capturedConfigFn = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('next-intl/server', () => ({
  getRequestConfig: (fn: unknown) => {
    capturedConfigFn.current = fn;
    return fn;
  },
}));

const cookieValue = vi.hoisted(() => ({ current: undefined as string | undefined }));
const acceptLanguage = vi.hoisted(() => ({ current: null as string | null }));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => (cookieValue.current ? { value: cookieValue.current } : undefined) }),
  headers: async () => ({ get: () => acceptLanguage.current }),
}));

import './request';

/** Corre el getRequestConfig REAL y devuelve lo que la app usaría. */
async function loadAppConfig(locale?: string) {
  const fn = capturedConfigFn.current as (args: {
    locale?: string;
    requestLocale: Promise<string | undefined>;
  }) => Promise<Record<string, unknown>>;
  return fn({ locale, requestLocale: Promise.resolve(locale) });
}

// 2026-08-01T23:30:00Z: en UTC es el día 1 a las 23:30; en Asia/Tokyo (UTC+9)
// ya es el día 2 a las 08:30. Cruzar la medianoche hace que el DÍA delate la
// zona, sin depender de si el locale rinde 12 h o 24 h.
const CROSS_MIDNIGHT = new Date('2026-08-01T23:30:00Z');

// Locale de reloj 24 h y orden estable: con es-AR ('11:30:00 p. m.') las
// aserciones sobre la hora quedan atadas al formato del locale, no a la zona,
// que es lo único que estos tests miden.
const CLOCK_LOCALE = 'en-GB';

// Las MISMAS opciones inline que usan los paneles de admin (DATE_OPTIONS) y
// el eje X de MagnitudeTimeChart: son las que `formats` NO alcanza.
const INLINE_OPTIONS = {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
} as const;

beforeEach(() => {
  cookieValue.current = undefined;
  acceptLanguage.current = null;
});

describe('getRequestConfig — zona horaria', () => {
  it('devuelve timeZone UTC a nivel raíz (lo que cubre las opciones inline)', async () => {
    const config = await loadAppConfig();
    expect(config.timeZone).toBe('UTC');
  });

  it('los formatos nombrados también fijan UTC', async () => {
    const config = await loadAppConfig();
    const formats = config.formats as {
      dateTime: Record<string, { timeZone?: string }>;
    };
    expect(formats.dateTime.medium.timeZone).toBe('UTC');
    expect(formats.dateTime.short.timeZone).toBe('UTC');
    expect(formats.dateTime.time.timeZone).toBe('UTC');
  });
});

describe('formateo real con la config de la app', () => {
  /**
   * ESTE es el test de la regresión: el formatter se arma con lo que
   * getRequestConfig devuelve DE VERDAD. Si alguien borra el `timeZone` del
   * return, `config.timeZone` llega undefined, use-intl cae a la zona del
   * proceso y con TZ=Asia/Tokyo esto rompe.
   */
  it('format.dateTime con opciones INLINE respeta UTC', async () => {
    const config = await loadAppConfig();
    const format = createFormatter({
      locale: CLOCK_LOCALE,
      formats: config.formats as never,
      timeZone: config.timeZone as string,
    });

    const rendered = format.dateTime(CROSS_MIDNIGHT, INLINE_OPTIONS);

    // 01 a las 23:30 en UTC. En Asia/Tokyo sería "02 ... 08:30".
    expect(rendered).toContain('01');
    expect(rendered).toContain('23:30');
    expect(rendered).not.toContain('02');
  });

  it('format.dateTime por NOMBRE respeta UTC', async () => {
    const config = await loadAppConfig();
    const format = createFormatter({
      locale: CLOCK_LOCALE,
      formats: config.formats as never,
      timeZone: config.timeZone as string,
    });

    expect(format.dateTime(CROSS_MIDNIGHT, 'medium')).toContain('23:30');
  });

  /**
   * Verificación por mutación, hecha test: con la zona equivocada las
   * aserciones de arriba DEBEN romper. Si esto fallara, el test de UTC
   * pasaría con cualquier zona y no estaría midiendo nada.
   */
  it('con una zona NO-UTC el mismo instante cae en otro día (el test discrimina)', async () => {
    const config = await loadAppConfig();
    const tokyo = createFormatter({
      locale: CLOCK_LOCALE,
      formats: config.formats as never,
      timeZone: 'Asia/Tokyo',
    });

    const rendered = tokyo.dateTime(CROSS_MIDNIGHT, INLINE_OPTIONS);

    expect(rendered).toContain('02');
    expect(rendered).toContain('08:30');
  });
});

import { describe, expect, it } from 'vitest';
import { formatDateTimeCompact, getMagnitudeSeverity } from './utils';

describe('getMagnitudeSeverity', () => {
  it('mapea mag=6 a critical', () => {
    expect(getMagnitudeSeverity(6)).toBe('critical');
  });

  it('mapea mag=5.9 a high (justo debajo del umbral critical)', () => {
    expect(getMagnitudeSeverity(5.9)).toBe('high');
  });

  it('mapea mag=5 a high', () => {
    expect(getMagnitudeSeverity(5)).toBe('high');
  });

  it('mapea mag=4.9 a moderate (justo debajo del umbral high)', () => {
    expect(getMagnitudeSeverity(4.9)).toBe('moderate');
  });

  it('mapea mag=4 a moderate', () => {
    expect(getMagnitudeSeverity(4)).toBe('moderate');
  });

  it('mapea mag=3.9 a low (justo debajo del umbral moderate)', () => {
    expect(getMagnitudeSeverity(3.9)).toBe('low');
  });

  it('mapea magnitudes muy bajas a low', () => {
    expect(getMagnitudeSeverity(0)).toBe('low');
    expect(getMagnitudeSeverity(-1)).toBe('low');
  });

  it('mapea magnitudes muy altas a critical', () => {
    expect(getMagnitudeSeverity(9.5)).toBe('critical');
  });
});

describe('formatDateTimeCompact — siempre UTC', () => {
  it('formatea en UTC, no en la zona del proceso', () => {
    // 13:06 UTC debe salir 13:06 corra donde corra el test (TZ del CI puede
    // ser cualquiera). Con getHours() local esto falla fuera de UTC.
    expect(formatDateTimeCompact('2026-08-21T13:06:40.000Z')).toBe(
      '2026-08-21 13:06:40',
    );
  });

  it('no corre el día hacia atrás cerca de medianoche UTC', () => {
    // El caso que delata la zona local: 00:30 UTC es "el día anterior 21:30"
    // en Buenos Aires. La fecha debe seguir siendo la del 22.
    expect(formatDateTimeCompact('2026-08-22T00:30:00.000Z')).toBe(
      '2026-08-22 00:30:00',
    );
  });

  it('acepta el formato de endtime de ObsPy (microsegundos)', () => {
    expect(formatDateTimeCompact('2026-08-21T14:32:10.123456Z')).toBe(
      '2026-08-21 14:32:10',
    );
  });
});

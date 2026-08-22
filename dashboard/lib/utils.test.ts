import { describe, expect, it } from 'vitest';
import { formatDateTimeCompact, getMagnitudeCategory, getMagnitudeSeverity } from './utils';

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

  it('mapea mag=3.9 a light (justo debajo del umbral moderate)', () => {
    expect(getMagnitudeSeverity(3.9)).toBe('light');
  });

  it('mapea mag=3 a light', () => {
    expect(getMagnitudeSeverity(3)).toBe('light');
  });

  it('mapea mag=2.9 a low (justo debajo del umbral light)', () => {
    expect(getMagnitudeSeverity(2.9)).toBe('low');
  });

  it('mapea magnitudes muy bajas a low', () => {
    expect(getMagnitudeSeverity(0)).toBe('low');
    expect(getMagnitudeSeverity(-1)).toBe('low');
  });

  /**
   * El chip de la lista y el punto del globo tienen que coincidir: un M3.9
   * salía amarillo en el globo (magnitudeColor: >=3) y verde en el chip
   * (getMagnitudeSeverity: <4 = low). Mismo sismo, dos colores.
   *
   * Los cortes de las tres funciones son EL MISMO contrato — el comentario de
   * getMagnitudeCategory ya lo declaraba ("mismos cortes que
   * getMagnitudeColor"); getMagnitudeSeverity era la que se había quedado sin
   * el tramo 3-4.
   */
  it('comparte los cortes con getMagnitudeCategory en todos los tramos', () => {
    const equivalencias: Array<[number, ReturnType<typeof getMagnitudeSeverity>, string]> = [
      [2.9, 'low', 'micro'],
      [3, 'light', 'leve'],
      [3.9, 'light', 'leve'],
      [4, 'moderate', 'moderado'],
      [4.9, 'moderate', 'moderado'],
      [5, 'high', 'fuerte'],
      [5.9, 'high', 'fuerte'],
      [6, 'critical', 'mayor'],
    ];

    for (const [mag, severity, categoria] of equivalencias) {
      expect(getMagnitudeSeverity(mag), `severidad de M${mag}`).toBe(severity);
      expect(getMagnitudeCategory(mag), `categoría de M${mag}`).toBe(categoria);
    }
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

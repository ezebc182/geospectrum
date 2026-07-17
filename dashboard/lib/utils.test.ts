import { describe, expect, it } from 'vitest';
import { getMagnitudeSeverity } from './utils';

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

import { describe, expect, it } from 'vitest';

import {
  EMPTY_FILTERS,
  availableSources,
  dateRangeOf,
  filterEvents,
  hasActiveFilters,
  periodWindow,
} from './event-filters';
import type { SeismicEvent } from '@/lib/types';

function makeEvento(overrides: Partial<SeismicEvent> = {}): SeismicEvent {
  return {
    id: 'evt-1',
    fuentes: ['USGS'],
    hora_utc: '2026-07-13T10:00:00Z',
    lat: -34.6,
    lon: -58.4,
    prof_km: 10,
    mag: 5.2,
    mag_tipo: 'mb',
    lugar: 'Buenos Aires, Argentina',
    sentido: false,
    revisado: true,
    ...overrides,
  };
}

/** `YYYY-MM-DD` de un evento situado a mediodía local, para evitar bordes. */
function localNoon(year: number, month: number, day: number): string {
  return new Date(year, month - 1, day, 12, 0, 0).toISOString();
}

describe('hasActiveFilters', () => {
  it('es false con los filtros vacíos', () => {
    expect(hasActiveFilters(EMPTY_FILTERS)).toBe(false);
  });

  it('ignora una búsqueda que es sólo espacios', () => {
    expect(hasActiveFilters({ ...EMPTY_FILTERS, query: '   ' })).toBe(false);
  });

  it('detecta un piso de magnitud en cero, que es un filtro válido', () => {
    // Con un chequeo por falsy en vez de por null, un 0 se tomaría como
    // "sin filtro" y dejaría pasar magnitudes negativas.
    expect(hasActiveFilters({ ...EMPTY_FILTERS, minMagnitude: 0 })).toBe(true);
  });
});

describe('filterEvents — búsqueda por lugar', () => {
  const eventos = [
    makeEvento({ id: 'a', lugar: 'Región de Antofagasta, Chile' }),
    makeEvento({ id: 'b', lugar: 'Buenos Aires, Argentina' }),
    makeEvento({ id: 'c', lugar: null as unknown as string }),
  ];

  it('devuelve todo si no hay filtros activos', () => {
    expect(filterEvents(eventos, EMPTY_FILTERS)).toHaveLength(3);
  });

  it('encuentra sin escribir los acentos', () => {
    const result = filterEvents(eventos, { ...EMPTY_FILTERS, query: 'region' });

    expect(result.map((e) => e.id)).toEqual(['a']);
  });

  it('encuentra escribiendo los acentos', () => {
    const result = filterEvents(eventos, { ...EMPTY_FILTERS, query: 'Región' });

    expect(result.map((e) => e.id)).toEqual(['a']);
  });

  it('ignora mayúsculas y busca por subcadena', () => {
    const result = filterEvents(eventos, { ...EMPTY_FILTERS, query: 'ARGENT' });

    expect(result.map((e) => e.id)).toEqual(['b']);
  });

  it('no explota con un lugar nulo', () => {
    const result = filterEvents(eventos, { ...EMPTY_FILTERS, query: 'chile' });

    expect(result.map((e) => e.id)).toEqual(['a']);
  });
});

describe('filterEvents — rango de magnitud', () => {
  const eventos = [
    makeEvento({ id: 'm2', mag: 2.5 }),
    makeEvento({ id: 'm4', mag: 4.0 }),
    makeEvento({ id: 'm6', mag: 6.3 }),
  ];

  it('aplica el piso de forma inclusive', () => {
    const result = filterEvents(eventos, { ...EMPTY_FILTERS, minMagnitude: 4 });

    expect(result.map((e) => e.id)).toEqual(['m4', 'm6']);
  });

  it('aplica el techo de forma inclusive', () => {
    const result = filterEvents(eventos, { ...EMPTY_FILTERS, maxMagnitude: 4 });

    expect(result.map((e) => e.id)).toEqual(['m2', 'm4']);
  });

  it('combina piso y techo', () => {
    const result = filterEvents(eventos, {
      ...EMPTY_FILTERS,
      minMagnitude: 3,
      maxMagnitude: 5,
    });

    expect(result.map((e) => e.id)).toEqual(['m4']);
  });
});

describe('filterEvents — período relativo', () => {
  // Referencia fija: 15 de julio de 2026, 12:00 hora local. Se inyecta como
  // `now` para que los tests no dependan de cuándo se corren.
  const now = new Date(2026, 6, 15, 12, 0, 0).getTime();
  const HOUR = 60 * 60 * 1000;

  const eventos = [
    makeEvento({ id: 'hace2h', hora_utc: new Date(now - 2 * HOUR).toISOString() }),
    makeEvento({ id: 'hace8h', hora_utc: new Date(now - 8 * HOUR).toISOString() }),
    makeEvento({ id: 'ayer', hora_utc: new Date(2026, 6, 14, 15, 0, 0).toISOString() }),
    makeEvento({ id: 'anteayer', hora_utc: new Date(2026, 6, 13, 15, 0, 0).toISOString() }),
  ];

  it("'all' no filtra nada", () => {
    const result = filterEvents(eventos, { ...EMPTY_FILTERS, period: 'all' }, now);

    expect(result).toHaveLength(4);
  });

  it("'6h' deja sólo lo de las últimas 6 horas", () => {
    const result = filterEvents(eventos, { ...EMPTY_FILTERS, period: '6h' }, now);

    expect(result.map((e) => e.id)).toEqual(['hace2h']);
  });

  it("'12h' incluye lo de 8 horas atrás", () => {
    const result = filterEvents(eventos, { ...EMPTY_FILTERS, period: '12h' }, now);

    expect(result.map((e) => e.id)).toEqual(['hace2h', 'hace8h']);
  });

  it("'24h' incluye lo de ayer a la tarde", () => {
    const result = filterEvents(eventos, { ...EMPTY_FILTERS, period: '24h' }, now);

    expect(result.map((e) => e.id)).toEqual(['hace2h', 'hace8h', 'ayer']);
  });

  it("'today' corta en la medianoche local, no 24 horas atrás", () => {
    // La diferencia con '24h': lo de ayer a las 15:00 entra en las últimas 24
    // horas pero NO es "hoy".
    const result = filterEvents(eventos, { ...EMPTY_FILTERS, period: 'today' }, now);

    expect(result.map((e) => e.id)).toEqual(['hace2h', 'hace8h']);
  });

  it("'yesterday' devuelve sólo el día anterior completo", () => {
    const result = filterEvents(eventos, { ...EMPTY_FILTERS, period: 'yesterday' }, now);

    expect(result.map((e) => e.id)).toEqual(['ayer']);
  });

  it('descarta un evento con fecha inválida en vez de dejarlo pasar', () => {
    // `NaN < x` es false, así que sin el chequeo explícito se colaría.
    const conBasura = [...eventos, makeEvento({ id: 'roto', hora_utc: 'no-es-fecha' })];
    const result = filterEvents(conBasura, { ...EMPTY_FILTERS, period: '24h' }, now);

    expect(result.map((e) => e.id)).not.toContain('roto');
  });
});

describe('periodWindow', () => {
  const now = new Date(2026, 6, 15, 12, 0, 0).getTime();

  it("devuelve null para 'all'", () => {
    expect(periodWindow('all', now)).toBeNull();
  });

  it("'yesterday' termina justo antes de la medianoche de hoy", () => {
    const window = periodWindow('yesterday', now)!;
    const startOfToday = new Date(2026, 6, 15, 0, 0, 0, 0).getTime();

    expect(window.to).toBe(startOfToday - 1);
    expect(window.from).toBe(new Date(2026, 6, 14, 0, 0, 0, 0).getTime());
  });
});

describe('filterEvents — fuentes y sentidos', () => {
  const eventos = [
    makeEvento({ id: 'usgs', fuentes: ['USGS'] }),
    makeEvento({ id: 'emsc', fuentes: ['EMSC'] }),
    makeEvento({ id: 'ambas', fuentes: ['USGS', 'EMSC'] }),
    makeEvento({ id: 'sentido', fuentes: ['USGS'], sentido: true }),
  ];

  it('una lista de fuentes vacía no filtra nada', () => {
    expect(filterEvents(eventos, { ...EMPTY_FILTERS, sources: [] })).toHaveLength(4);
  });

  it('incluye el evento si tiene AL MENOS una de las fuentes elegidas', () => {
    const result = filterEvents(eventos, { ...EMPTY_FILTERS, sources: ['EMSC'] });

    expect(result.map((e) => e.id)).toEqual(['emsc', 'ambas']);
  });

  it('filtra por eventos sentidos', () => {
    const result = filterEvents(eventos, { ...EMPTY_FILTERS, onlyFelt: true });

    expect(result.map((e) => e.id)).toEqual(['sentido']);
  });

  it('combina varios criterios a la vez', () => {
    const mixtos = [
      makeEvento({ id: 'ok', lugar: 'Santiago, Chile', mag: 5.5, sentido: true }),
      makeEvento({ id: 'chico', lugar: 'Santiago, Chile', mag: 2.0, sentido: true }),
      makeEvento({ id: 'otro', lugar: 'Lima, Perú', mag: 5.5, sentido: true }),
      makeEvento({ id: 'nosentido', lugar: 'Santiago, Chile', mag: 5.5, sentido: false }),
    ];

    const result = filterEvents(mixtos, {
      ...EMPTY_FILTERS,
      query: 'chile',
      minMagnitude: 4,
      onlyFelt: true,
    });

    expect(result.map((e) => e.id)).toEqual(['ok']);
  });
});

describe('availableSources', () => {
  it('devuelve las fuentes únicas y ordenadas', () => {
    const eventos = [
      makeEvento({ fuentes: ['USGS', 'EMSC'] }),
      makeEvento({ fuentes: ['USGS'] }),
      makeEvento({ fuentes: ['GFZ'] }),
    ];

    expect(availableSources(eventos)).toEqual(['EMSC', 'GFZ', 'USGS']);
  });

  it('devuelve una lista vacía sin eventos', () => {
    expect(availableSources([])).toEqual([]);
  });
});

describe('dateRangeOf', () => {
  it('devuelve null si no hay eventos', () => {
    expect(dateRangeOf([])).toBeNull();
  });

  it('devuelve el primer y el último día cubiertos', () => {
    const eventos = [
      makeEvento({ hora_utc: localNoon(2026, 7, 15) }),
      makeEvento({ hora_utc: localNoon(2026, 7, 10) }),
      makeEvento({ hora_utc: localNoon(2026, 7, 20) }),
    ];

    expect(dateRangeOf(eventos)).toEqual({ min: '2026-07-10', max: '2026-07-20' });
  });

  it('ignora las fechas inválidas', () => {
    const eventos = [
      makeEvento({ hora_utc: 'no-es-fecha' }),
      makeEvento({ hora_utc: localNoon(2026, 7, 15) }),
    ];

    expect(dateRangeOf(eventos)).toEqual({ min: '2026-07-15', max: '2026-07-15' });
  });
});

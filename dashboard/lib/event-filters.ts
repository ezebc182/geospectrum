/**
 * Filtrado de eventos sísmicos para las tablas.
 *
 * Vive acá y no dentro de EventsTable porque son funciones puras: se testean
 * sin renderizar, y la tabla queda ocupándose sólo de pintar.
 *
 * El filtrado es en CLIENTE, sobre los eventos que ya trajo /report. Alcanza
 * porque el reporte devuelve como mucho unos pocos miles de eventos y el
 * backend ya recortó por el área activa. El día que exista la tabla histórica,
 * el filtro de fechas va a tener que viajar al backend — pero la forma de
 * `EventFilters` puede quedar igual.
 */

import type { SeismicEvent } from '@/lib/types';

/**
 * Ventana de tiempo, relativa al momento de filtrar.
 *
 * Se eligió esto en vez de un rango de fechas con calendario porque /report
 * devuelve una ventana de HORAS: un calendario quedaba con casi todos los días
 * en gris y se sentía roto, aunque fuera correcto. "Últimas 6 horas" en cambio
 * significa lo mismo con dos días de datos que con un año.
 */
export type TimePeriod = 'all' | '6h' | '12h' | '24h' | 'today' | 'yesterday';

/**
 * Sin `label`: este módulo es puro y no importa next-intl (Decision 5 del
 * design de i18n-dashboard). El componente que pinta los botones resuelve el
 * texto con `t(`periods.${value}`)` del namespace `events`.
 */
export const TIME_PERIODS: { value: TimePeriod }[] = [
  { value: 'all' },
  { value: '6h' },
  { value: '12h' },
  { value: '24h' },
  { value: 'today' },
  { value: 'yesterday' },
];

export interface EventFilters {
  /** Búsqueda libre sobre el lugar del evento. */
  query: string;
  /** Magnitud mínima inclusive. null = sin piso. */
  minMagnitude: number | null;
  /** Magnitud máxima inclusive. null = sin techo. */
  maxMagnitude: number | null;
  /** Ventana de tiempo relativa. 'all' = sin límite. */
  period: TimePeriod;
  /** Fuentes seleccionadas (USGS, EMSC…). Vacío = todas. */
  sources: string[];
  /** Sólo eventos reportados como sentidos por la población. */
  onlyFelt: boolean;
}

export const EMPTY_FILTERS: EventFilters = {
  query: '',
  minMagnitude: null,
  maxMagnitude: null,
  period: 'all',
  sources: [],
  onlyFelt: false,
};

/**
 * Pasa a minúsculas y saca los acentos: los lugares vienen con tildes
 * ("Región de Antofagasta") y quien busca casi nunca las escribe. Sin esto,
 * teclear "region" no encuentra nada y el buscador parece roto.
 */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

/** Si no hay ningún criterio activo, el filtrado se puede saltear entero. */
export function hasActiveFilters(filters: EventFilters): boolean {
  return (
    filters.query.trim() !== '' ||
    filters.minMagnitude !== null ||
    filters.maxMagnitude !== null ||
    filters.period !== 'all' ||
    filters.sources.length > 0 ||
    filters.onlyFelt
  );
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * Ventana `[desde, hasta]` en milisegundos para un período, o null si no acota.
 *
 * `now` se recibe por parámetro en vez de leer el reloj adentro para que el
 * cálculo sea determinista y testeable: con `Date.now()` embebido, un test de
 * "últimas 6 horas" dependería de cuándo se corre.
 *
 * "Hoy" y "Ayer" se calculan en hora LOCAL —que es la que ve el usuario en la
 * tabla— y no en UTC: de lo contrario el corte de medianoche caería a destiempo
 * y un evento de la madrugada aparecería en el día equivocado.
 */
export function periodWindow(
  period: TimePeriod,
  now: number
): { from: number; to: number } | null {
  switch (period) {
    case 'all':
      return null;
    case '6h':
      return { from: now - 6 * HOUR_MS, to: now };
    case '12h':
      return { from: now - 12 * HOUR_MS, to: now };
    case '24h':
      return { from: now - 24 * HOUR_MS, to: now };
    case 'today': {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      return { from: start.getTime(), to: now };
    }
    case 'yesterday': {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      const end = new Date(start.getTime() - 1);
      const yesterday = new Date(start);
      yesterday.setDate(yesterday.getDate() - 1);
      return { from: yesterday.getTime(), to: end.getTime() };
    }
  }
}

export function filterEvents(
  eventos: SeismicEvent[],
  filters: EventFilters,
  now: number = Date.now()
): SeismicEvent[] {
  if (!hasActiveFilters(filters)) return eventos;

  const query = normalize(filters.query.trim());
  const window = periodWindow(filters.period, now);
  const from = window?.from ?? null;
  const to = window?.to ?? null;
  // Set para no recorrer el array de fuentes por cada evento.
  const sources = filters.sources.length > 0 ? new Set(filters.sources) : null;

  return eventos.filter((evento) => {
    if (query !== '' && !normalize(evento.lugar ?? '').includes(query)) {
      return false;
    }

    if (filters.minMagnitude !== null && evento.mag < filters.minMagnitude) {
      return false;
    }
    if (filters.maxMagnitude !== null && evento.mag > filters.maxMagnitude) {
      return false;
    }

    if (from !== null || to !== null) {
      const time = new Date(evento.hora_utc).getTime();
      // Una fecha inválida no se puede comparar: se descarta en vez de
      // colarse, porque `NaN < x` es false y pasaría todos los filtros.
      if (Number.isNaN(time)) return false;
      if (from !== null && time < from) return false;
      if (to !== null && time > to) return false;
    }

    // Basta con que el evento tenga UNA de las fuentes elegidas: un mismo
    // evento suele estar reportado por varias a la vez.
    if (sources !== null && !evento.fuentes.some((source) => sources.has(source))) {
      return false;
    }

    if (filters.onlyFelt && !evento.sentido) {
      return false;
    }

    return true;
  });
}

/** Fuentes presentes en los eventos, ordenadas, para armar el selector. */
export function availableSources(eventos: SeismicEvent[]): string[] {
  const sources = new Set<string>();
  for (const evento of eventos) {
    for (const source of evento.fuentes) sources.add(source);
  }
  return [...sources].sort();
}

/**
 * Rango de fechas (en `YYYY-MM-DD` local) que cubren los eventos cargados.
 * Se usa para acotar los inputs: hoy /report trae una ventana de horas, así que
 * ofrecer un calendario abierto haría creer que hay un histórico que no existe.
 */
export function dateRangeOf(
  eventos: SeismicEvent[]
): { min: string; max: string } | null {
  let min = Infinity;
  let max = -Infinity;

  for (const evento of eventos) {
    const time = new Date(evento.hora_utc).getTime();
    if (Number.isNaN(time)) continue;
    if (time < min) min = time;
    if (time > max) max = time;
  }

  if (min === Infinity) return null;
  return { min: toLocalDateInput(min), max: toLocalDateInput(max) };
}

/** Timestamp → `YYYY-MM-DD` en hora local, que es lo que espera `<input type="date">`. */
function toLocalDateInput(time: number): string {
  const date = new Date(time);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

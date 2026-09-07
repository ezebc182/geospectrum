/**
 * Cliente de los paneles profesionales de `/analytics`
 * (analytics-professional-panels, Fase 4).
 *
 * Tipos espejo 1:1 de `src/models/analytics.py`: el JSON que devuelve el
 * backend es la fuente de verdad, no este archivo. Lo que estos tipos
 * GARANTIZAN (y `lib/analytics.test.ts` fija):
 *
 * - `BValueResponse` es una unión discriminada por `status` ([R8]/[R9]): con
 *   `status !== "ok"` la clave `b` NO EXISTE en el body — ni como `null` —, y
 *   acá tampoco existe en el tipo. Un componente que lea `b` sin narrow por
 *   `status` no compila.
 * - `null` ≠ `0` ([R12], [R4]): `UptimeBucket.ratio`, `overall[channel]`,
 *   `baseline_rsam`, `threshold_rsam` y `SeismicEvent.prof_km` son
 *   `number | null` a propósito. `null` = "nadie miró" / "sin dato"; `0` = "se
 *   miró y no había nada". El cliente no convierte uno en otro: eso lo hacen
 *   las libs puras (`uptime-series.ts`, `hypocenter-markers.ts`) con tests
 *   `toBeNull()`.
 * - Los timestamps viajan como string ISO-8601 y se parsean con `new Date()`.
 *   OJO: `TremorResponse.samples[i].t` tiene 6 decimales
 *   (`2026-09-06T20:05:00.000000Z`, el `str(UTCDateTime)` de ObsPy, IGUAL que
 *   `/rsam`), mientras que `episodes[].start/end` son ISO de Pydantic. V8 parsea
 *   los dos (verificado en Node 22); las libs puras los llevan a ms epoch.
 *
 * Molde del transporte: `lib/feedback.ts` (`credentials: 'include'`,
 * `cache: 'no-store'`, `ApiStatusError` con el `detail` del backend). A
 * diferencia de feedback, estos endpoints son PÚBLICOS (la sesión solo
 * personaliza el área en b-value/hipocentros), así que un 401 no es "sin
 * sesión, no pasa nada": es una anomalía y se lanza como cualquier otro `!ok`.
 * El ÚNICO status que es un ESTADO y no un error es el 404 de `/tremor`
 * ("sin datos FDSN para este canal"), que `getTremor` devuelve tipado.
 */

import { ApiStatusError } from './auth';
import type { SeismicEvent } from './types';
import type { TimeWindow } from './waveform-scale';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

// --- b-value ------------------------------------------------------------------

export interface MagnitudeBin {
  /** Borde inferior del bin (múltiplo de `magnitudeBinWidth`). */
  m: number;
  /** No acumulado. */
  count: number;
  /** N(M >= m). */
  cumulative: number;
}

export type BValueStatus = 'ok' | 'insufficient' | 'degenerate';

interface BValueBase {
  method: 'aki-utsu-mle';
  n_total: number;
  n_above_mc: number;
  /** `bValueMinEvents` del JSON compartido — la UI no lo hardcodea. */
  min_events: number;
  /** `null` si el catálogo está vacío. */
  mc: number | null;
  mc_at_catalog_floor: boolean;
  bins: MagnitudeBin[];
  /** `"unknown"` para `mag_tipo` null. */
  mag_type_counts: Record<string, number>;
  window_start: string;
  window_end: string;
  /** `null` ⇒ global (área no resuelta). */
  area_slug: string | null;
}

/** Estimación válida: el ÚNICO miembro de la unión con `b`/`a`/`sigma_b`. */
export interface BValueOk extends BValueBase {
  status: 'ok';
  b: number;
  a: number;
  sigma_b: number;
}

/** `insufficient` = N bajo el mínimo; `degenerate` = todas las magnitudes
 * sobre Mc iguales. Sin `b`, sin `a`, sin `sigma_b` — ni en el body ni acá. */
export interface BValueNotEstimable extends BValueBase {
  status: 'insufficient' | 'degenerate';
}

export type BValueResponse = BValueOk | BValueNotEstimable;

// --- hipocentros ----------------------------------------------------------------

export interface HypocentersResponse {
  /** ORDER BY mag DESC, recortado a `limit`. `prof_km` puede ser `null` y
   * también NEGATIVO (EMSC/USGS reportan sobre el nivel del mar). */
  eventos: SeismicEvent[];
  /** Antes del recorte. */
  total: number;
  truncated: boolean;
  window_start: string;
  window_end: string;
  area_slug: string | null;
}

// --- uptime de estaciones -------------------------------------------------------

export type UptimeBucketKind = 'hour' | 'day';

export interface UptimeBucket {
  bucket_start: string;
  /** 0 si el canal no tiene fila en el bucket. */
  columns_count: number;
  /** Horas del bucket con fila de ALGÚN canal (0 o 1 en `bucket=hour`). */
  observed_hours: number;
  /** `expected_columns_per_hour × observed_hours` [R12]. */
  expected: number;
  /** `min(1, count/expected)`; `null` si `observed_hours === 0` (nadie miró). */
  ratio: number | null;
  /** El bucket contiene `now`. */
  in_progress: boolean;
}

export interface StationUptimeResponse {
  bucket: UptimeBucketKind;
  window_start: string;
  window_end: string;
  /** 900, derivado de `COLUMN_INTERVAL_SECONDS` en el backend. */
  expected_columns_per_hour: number;
  /** Clave: channel de 4 partes (`trace.id`); TODOS los buckets de la ventana. */
  stations: Record<string, UptimeBucket[]>;
  /** Ratio agregado por canal; `null` si no se observó nunca [R12]. */
  overall: Record<string, number | null>;
}

// --- tremor ---------------------------------------------------------------------

export type TremorBand = 'low' | 'mid' | 'high' | 'undefined';
export type TremorFiSign = 'lp_like' | 'vt_like' | 'undefined';

export interface TremorEpisode {
  /** `t` de la primera muestra del episodio (ISO de Pydantic). */
  start: string;
  /** `t` de la última muestra del episodio. */
  end: string;
  samples: number;
  /** `samples × period_seconds`. */
  duration_s: number;
  mean_ratio: number;
  peak_rsam: number;
  peak_ratio: number;
  /** `rsam[start] / peak` — bajo = emergente. */
  onset_ratio: number;
  mean_dominant_hz: number | null;
  mean_fi: number | null;
  band: TremorBand;
  fi_sign: TremorFiSign;
}

export interface TremorParameters {
  baseline_factor: number;
  min_duration_periods: number;
}

/** `t` = CENTRO de la ventana, MISMO string que `/rsam` (6 decimales);
 * `rsam` == `value` de `/rsam` para la misma ventana. */
export interface TremorSample {
  t: string;
  rsam: number;
  dominant_hz: number | null;
  fi: number | null;
}

export interface TremorResponse {
  channel: string;
  sampling_rate: number;
  period_seconds: number;
  /** `null` si no hay muestras ("sin datos" explícito). */
  baseline_rsam: number | null;
  /** `baseline × tremorBaselineFactor`, calculado en el backend. */
  threshold_rsam: number | null;
  tremor_fraction: number;
  parameters: TremorParameters;
  samples: TremorSample[];
  episodes: TremorEpisode[];
}

/** El 404 de `/tremor` es un ESTADO del panel ("sin datos para este canal"),
 * no un error: se devuelve tipado para que el componente no necesite un
 * `catch` que distinga status codes. */
export type TremorResult = { kind: 'data'; data: TremorResponse } | { kind: 'no-data'; detail: string };

// --- transporte -----------------------------------------------------------------

async function readDetail(response: Response): Promise<string> {
  let detail = `API Error: ${response.status} ${response.statusText}`;
  try {
    const body = (await response.json()) as { detail?: unknown } | null;
    if (body?.detail) detail = String(body.detail);
  } catch {
    // body no-JSON: queda el mensaje genérico
  }
  return detail;
}

async function fetchRaw(path: string): Promise<Response> {
  return fetch(`${API_BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    cache: 'no-store',
  });
}

async function request<T>(path: string): Promise<T> {
  const response = await fetchRaw(path);
  if (!response.ok) throw new ApiStatusError(response.status, await readDetail(response));
  return response.json() as Promise<T>;
}

/** Query string con SOLO los parámetros presentes (un `min_mag=undefined`
 * sería un 422 del backend). `channel` se repite por canal: FastAPI recibe
 * `list[str]` como `?channel=A&channel=B`. */
function query(params: Record<string, string | number | string[] | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) search.append(key, item);
    } else {
      search.set(key, String(value));
    }
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : '';
}

// --- fetchers -------------------------------------------------------------------

/** `GET /analytics/b-value?days=&min_mag=&mc=`. 503 sin `event_store`, 422
 * fuera de rango ⇒ `ApiStatusError`. Área: la activa de la sesión o la default. */
export async function getBValue(days: number, minMag?: number, mc?: number): Promise<BValueResponse> {
  return request<BValueResponse>(`/analytics/b-value${query({ days, min_mag: minMag, mc })}`);
}

/** `GET /analytics/hypocenters?days=&min_mag=&limit=`. El backend ordena por
 * magnitud DESC y declara `truncated` si `total > limit`. */
export async function getHypocenters(days: number, minMag?: number, limit?: number): Promise<HypocentersResponse> {
  return request<HypocentersResponse>(`/analytics/hypocenters${query({ days, min_mag: minMag, limit })}`);
}

/** `GET /analytics/station-uptime?days=&bucket=&channel=…`. Sin canales (o
 * lista vacía) ⇒ todos los canales con filas en la ventana. `days > 14`
 * vuelve con `bucket: "day"` aunque se pida `hour`: leer `bucket` de la
 * respuesta, no del argumento. */
export async function getStationUptime(
  days: number,
  bucket: UptimeBucketKind,
  channels?: string[],
): Promise<StationUptimeResponse> {
  const channel = channels && channels.length > 0 ? channels : undefined;
  return request<StationUptimeResponse>(`/analytics/station-uptime${query({ days, bucket, channel })}`);
}

/** `GET /analytics/tremor/{channel}?start&end` (ventana absoluta ≤ 24 h, misma
 * forma que `seismicAPI.getStationRsam`). 404 ⇒ `{kind: 'no-data'}`; 422/503/…
 * ⇒ `ApiStatusError`. */
export async function getTremor(channel: string, window: TimeWindow): Promise<TremorResult> {
  const start = new Date(window.startMs).toISOString();
  const end = new Date(window.endMs).toISOString();
  const response = await fetchRaw(`/analytics/tremor/${encodeURIComponent(channel)}${query({ start, end })}`);
  if (response.status === 404) return { kind: 'no-data', detail: await readDetail(response) };
  if (!response.ok) throw new ApiStatusError(response.status, await readDetail(response));
  return { kind: 'data', data: (await response.json()) as TremorResponse };
}

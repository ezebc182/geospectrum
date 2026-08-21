/**
 * Métricas por estación (PR-W3): tipos, fetch batch y formateo.
 *
 * Polling ligero a propósito (spec §3 dejaba la decisión al plan): el muro
 * monta ~74 tiras — un WS de métricas por tira sería una tormenta de
 * conexiones; un request batch cada 15 s por contenedor alcanza para
 * métricas que cambian cada 4 s.
 */

export interface StationMetrics {
  channel: string;
  endtime: string;
  rsam: number | null;
  freq_hz: number | null;
  fi: number | null;
  peak_db: number | null;
  events_hour: number | null;
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

export async function fetchStationMetrics(
  channels: string[],
): Promise<Record<string, StationMetrics>> {
  if (channels.length === 0) return {};
  const params = new URLSearchParams();
  for (const channel of channels) params.append('channel', channel);
  try {
    const response = await fetch(`${API_BASE}/stations/metrics?${params}`);
    if (!response.ok) return {};
    const data = (await response.json()) as {
      metrics?: Record<string, StationMetrics>;
    };
    return data.metrics ?? {};
  } catch {
    // Sin métricas la UI muestra guiones; nunca es razón para romper la vista
    return {};
  }
}

export function latencySeconds(endtime: string, nowMs: number): number | null {
  const parsed = Date.parse(endtime);
  if (Number.isNaN(parsed)) return null;
  return Math.max(0, Math.round((nowMs - parsed) / 1000));
}

const DASH = '—';

function fmt(value: number | null, digits: number): string {
  return value === null ? DASH : value.toFixed(digits);
}

/** Banda compacta de la tira del muro (spec §3: "RSAM · FI · lat"). */
export function formatWallMetricsLine(m: StationMetrics, nowMs: number): string {
  const lat = latencySeconds(m.endtime, nowMs);
  const rsam = m.rsam === null ? DASH : String(Math.round(m.rsam));
  return `RSAM ${rsam} · FI ${fmt(m.fi, 2)} · ${lat === null ? DASH : `${lat}s`}`;
}

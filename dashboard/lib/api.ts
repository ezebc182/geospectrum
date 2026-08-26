/**
 * Cliente API para GeoSpectrum Service
 */

import type { AppLocale } from './locale';
import type {
  BetaSignup,
  MonitorReport,
  SeismicEvent,
  Alert,
  StationCatalogEntry,
  WallResponse,
} from './types';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

class SeismicAPI {
  private baseUrl: string;

  constructor(baseUrl: string = API_BASE_URL) {
    this.baseUrl = baseUrl;
  }

  private async fetchJSON<T>(endpoint: string): Promise<T> {
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      headers: {
        'Content-Type': 'application/json',
      },
      // No cache para datos en tiempo real
      cache: 'no-store',
      // Obligatorio en cross-origin (dashboard :3008 -> API :8000): sin esto
      // el browser NO manda la cookie `session` y /report responde siempre
      // como anónimo, ignorando el área de interés activa del usuario. Mismo
      // motivo que documenta lib/auth.ts, donde ya se usa en las 6 llamadas.
      credentials: 'include',
    });

    if (!response.ok) {
      throw new Error(`API Error: ${response.status} ${response.statusText}`);
    }

    return response.json();
  }

  /**
   * Obtener reporte completo
   */
  async getReport(): Promise<MonitorReport> {
    return this.fetchJSON<MonitorReport>('/report');
  }

  /**
   * Obtener solo eventos
   */
  async getEvents(): Promise<SeismicEvent[]> {
    return this.fetchJSON<SeismicEvent[]>('/events');
  }

  /**
   * Obtener solo alertas
   */
  async getAlerts(): Promise<Alert[]> {
    return this.fetchJSON<Alert[]>('/alerts');
  }

  /**
   * Health check
   */
  async getHealth(): Promise<string> {
    const response = await fetch(`${this.baseUrl}/health`);
    return response.text();
  }

  /**
   * Búsqueda avanzada de eventos con filtros
   */
  async searchEvents(params: {
    sources?: string;
    minMag?: number;
    maxMag?: number;
    minDepth?: number;
    maxDepth?: number;
    minLat?: number;
    maxLat?: number;
    minLon?: number;
    maxLon?: number;
    windowMinutes?: number;
    feltOnly?: boolean;
    reviewedOnly?: boolean;
  }): Promise<SeismicEvent[]> {
    const queryParams = new URLSearchParams();

    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        // El backend espera snake_case (min_mag, window_minutes): mandar la
        // clave camelCase hace que FastAPI la ignore EN SILENCIO y el filtro
        // no filtre nada — verificado contra producción el 2026-08-20.
        const snakeKey = key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
        queryParams.append(snakeKey, value.toString());
      }
    });

    return this.fetchJSON<SeismicEvent[]>(`/events/search?${queryParams.toString()}`);
  }

  /**
   * Obtener espectrograma para una ubicación específica
   */
  async getSpectrogram(
    cityId: string,
    latitude: number,
    longitude: number,
    network?: string,
    durationHours: number = 24
  ): Promise<{
    success: boolean;
    image: string | null;
    metadata: any;
    error?: string;
  }> {
    const queryParams = new URLSearchParams({
      latitude: latitude.toString(),
      longitude: longitude.toString(),
      duration_hours: durationHours.toString(),
    });

    if (network) {
      queryParams.append('network', network);
    }

    return this.fetchJSON(`/spectrograms/${cityId}?${queryParams.toString()}`);
  }

  /**
   * Ciudades con streaming en vivo disponible (SeedLink) y su canal SEED.
   */
  async getLiveChannels(): Promise<{ city_id: string; channel: string }[]> {
    return this.fetchJSON('/spectrograms/live-channels');
  }

  /**
   * Catálogo completo de subestaciones (PR-W3): TODAS las candidatas
   * ingestadas, no solo la ganadora por ciudad de getLiveChannels().
   */
  async getStationCatalog(): Promise<StationCatalogEntry[]> {
    return this.fetchJSON<StationCatalogEntry[]>('/spectrograms/station-catalog');
  }

  /**
   * Muro default "Global" estilo SPECTRONET (estático, generado del catálogo).
   */
  async getGlobalWall(): Promise<WallResponse> {
    return this.fetchJSON<WallResponse>('/walls/global');
  }

  /**
   * Espectro 1D (Power vs Hz) de una ventana concreta — paridad SWARM.
   * `start`/`end` son obligatorios en el backend: un espectro "de las últimas
   * 24 h" no tiene sentido físico.
   */
  /**
   * Serie RSAM on-demand de una ventana absoluta. Sin `filter`: RSAM se
   * define sobre la señal cruda y el backend hace su demean por ventana.
   */
  async getStationRsam(
    channel: string,
    window: { startMs: number; endMs: number },
    periodSeconds: number,
  ): Promise<RsamResponse> {
    const start = encodeURIComponent(new Date(window.startMs).toISOString());
    const end = encodeURIComponent(new Date(window.endMs).toISOString());
    return this.fetchJSON<RsamResponse>(
      `/stations/${encodeURIComponent(channel)}/rsam?start=${start}&end=${end}&period_seconds=${periodSeconds}`,
    );
  }

  async getStationSpectrum(
    channel: string,
    window: { startMs: number; endMs: number },
    filter: 'none' | 'bp' = 'none',
  ): Promise<SpectrumResponse> {
    const start = encodeURIComponent(new Date(window.startMs).toISOString());
    const end = encodeURIComponent(new Date(window.endMs).toISOString());
    return this.fetchJSON<SpectrumResponse>(
      `/stations/${encodeURIComponent(channel)}/spectra?start=${start}&end=${end}&filter=${filter}`,
    );
  }
}

/** Respuesta de GET /stations/{channel}/rsam (Fase 4). `t` es el CENTRO de cada ventana. */
export interface RsamResponse {
  channel: string;
  sampling_rate: number;
  period_seconds: number;
  starttime: string;
  endtime: string;
  samples: { t: string; value: number }[];
}

/** Respuesta de GET /stations/{channel}/spectra (Fase 3). */
export interface SpectrumResponse {
  channel: string;
  sampling_rate: number;
  /** min(25 Hz, Nyquist): el eje del gráfico se dibuja con ESTO, nunca con una constante. */
  max_freq_hz: number;
  starttime: string;
  endtime: string;
  npts: number;
  filter: string;
  freqs: number[];
  power_db: number[];
}

// Singleton
export const seismicAPI = new SeismicAPI();

// SWR fetchers
export const reportFetcher = () => seismicAPI.getReport();
export const eventsFetcher = () => seismicAPI.getEvents();
export const alertsFetcher = () => seismicAPI.getAlerts();

/**
 * Administración de beta testers (solo admin+, sesión por cookie httpOnly:
 * `credentials: 'include'` obligatorio — mismo criterio que lib/auth.ts).
 */
export async function getBetaSignups(): Promise<BetaSignup[]> {
  const response = await fetch(`${API_BASE_URL}/beta-signups`, {
    credentials: 'include',
  });
  if (!response.ok) throw new Error(`Beta list failed: ${response.status}`);
  return response.json();
}

export async function approveBetaSignup(id: string): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/beta-signups/${id}/approve`, {
    method: 'POST',
    credentials: 'include',
  });
  if (!response.ok) throw new Error(`Beta approve failed: ${response.status}`);
}

/**
 * Alta en la lista de espera de la beta (landing pública).
 *
 * `website` es el honeypot del form: viaja siempre (vacío para humanos) —
 * el backend descarta en silencio los payloads donde venga con contenido.
 * `locale` es el idioma activo de la landing: el backend lo persiste en
 * beta_signups.locale y de ahí sale el idioma del email de confirmación y
 * de la invitación al aprobar (cadena beta→invitación→emails, Fase 1).
 * Lanza en 4xx/5xx: el form distingue rate-limit/errores para el mensaje.
 */
export async function signupBeta(
  email: string,
  website: string,
  locale: AppLocale,
): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/beta-signups`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, website, locale }),
  });

  if (!response.ok) {
    throw new Error(`Beta signup failed: ${response.status}`);
  }
}

/**
 * Cliente API para GeoSpectrum Service
 */

import type { MonitorReport, SeismicEvent, Alert } from './types';

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
        queryParams.append(key, value.toString());
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
}

// Singleton
export const seismicAPI = new SeismicAPI();

// SWR fetchers
export const reportFetcher = () => seismicAPI.getReport();
export const eventsFetcher = () => seismicAPI.getEvents();
export const alertsFetcher = () => seismicAPI.getAlerts();

/**
 * Alta en la lista de espera de la beta (landing pública).
 *
 * `website` es el honeypot del form: viaja siempre (vacío para humanos) —
 * el backend descarta en silencio los payloads donde venga con contenido.
 * Lanza en 4xx/5xx: el form distingue rate-limit/errores para el mensaje.
 */
export async function signupBeta(email: string, website: string): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/beta-signups`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, website }),
  });

  if (!response.ok) {
    throw new Error(`Beta signup failed: ${response.status}`);
  }
}

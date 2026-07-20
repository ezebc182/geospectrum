/**
 * Tipos TypeScript para la API de GeoSpectrum
 */

export interface SeismicEvent {
  id: string;
  fuentes: string[];
  hora_utc: string;
  lat: number;
  lon: number;
  prof_km: number | null;
  mag: number;
  mag_tipo: string | null;
  lugar: string | null;
  sentido: boolean;
  revisado: boolean;
}

export interface KPIs {
  total_eventos: number;
  tasa_eventos_por_hora: number;
  magnitud_max: number | null;
  magnitud_promedio_ponderada_por_energia: number | null;
  profundidad_media_M_ge_4: number | null;
  eventos_sentidos: number;
  porcentaje_eventos_sentidos: number;
  minutos_desde_M_ge_5: number | null;
}

export interface Alert {
  tipo: 'enjambre' | 'evento_significativo' | 'actividad_sentida';
  descripcion: string;
  eventos_relacionados: string[];
}

export interface MonitorReport {
  timestamp_utc_generacion: string;
  region_monitorizada: {
    minlat: number;
    maxlat: number;
    minlon: number;
    maxlon: number;
  };
  data_source_errors: string[];
  kpis: KPIs;
  alertas: Alert[];
  eventos: SeismicEvent[];
}

export type AlertType = Alert['tipo'];

/**
 * Roles de usuario, jerarquía estricta descendente (ver
 * openspec/changes/multi-user-auth/design.md, Decision 6). El backend
 * serializa `role` como este mismo string en /auth/register, /auth/login
 * y /auth/me — no hay traducción de shape entre API y frontend.
 */
export type UserRole = 'superadmin' | 'admin' | 'moderador' | 'viewer';

/** Nivel jerárquico de cada rol (mayor = más privilegios). Espejo de
 * ROLE_LEVEL en src/models/user.py, solo para uso de UI condicional. */
export const ROLE_LEVEL: Record<UserRole, number> = {
  superadmin: 3,
  admin: 2,
  moderador: 1,
  viewer: 0,
};

/** Shape de usuario devuelto por /auth/register, /auth/login y /auth/me. */
export interface UserPublic {
  id: string;
  email: string;
  role: UserRole;
}

export interface ChartDataPoint {
  timestamp: number;
  mag: number;
  depth: number | null;
  felt: boolean;
  id: string;
}

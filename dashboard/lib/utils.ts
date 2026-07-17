import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Severidad por magnitud (escala Richter), derivada a tokens `--severity-*`. */
export function getMagnitudeSeverity(mag: number): 'low' | 'moderate' | 'high' | 'critical' {
  if (mag >= 6) return 'critical';
  if (mag >= 5) return 'high';
  if (mag >= 4) return 'moderate';
  return 'low';
}

/** Color por magnitud (escala Richter), usado en mapas y tablas. */
export function getMagnitudeColor(mag: number): string {
  if (mag >= 6) return '#dc2626'; // rojo — mayor
  if (mag >= 5) return '#ea580c'; // naranja fuerte — fuerte
  if (mag >= 4) return '#f59e0b'; // ámbar — moderado
  if (mag >= 3) return '#eab308'; // amarillo — leve
  return '#14b8a6'; // teal — micro
}

export function formatMagnitude(mag: number): string {
  return mag.toFixed(1);
}

/** Color por profundidad (km), mismos rangos que DepthDistributionChart. */
export function getDepthColor(prof_km: number): string {
  if (prof_km < 70) return '#ef4444';
  if (prof_km < 150) return '#f59e0b';
  if (prof_km < 300) return '#3b82f6';
  return '#8b5cf6';
}

export function formatDepth(prof_km: number | null | undefined): string {
  if (prof_km === null || prof_km === undefined) return 'N/A';
  return `${prof_km.toFixed(1)} km`;
}

export function formatDateTime(isoString: string): string {
  return new Date(isoString).toLocaleString('es-AR', {
    dateStyle: 'medium',
    timeStyle: 'medium',
  });
}

export function formatTimeAgo(isoString: string): string {
  const seconds = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
  if (seconds < 60) return 'hace instantes';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.floor(hours / 24);
  return `hace ${days} d`;
}

const ALERT_ICONS: Record<string, string> = {
  evento_significativo: '⚠️',
  enjambre: '📊',
  actividad_sentida: '👥',
};

export function getAlertIcon(tipo: string): string {
  return ALERT_ICONS[tipo] ?? 'ℹ️';
}

const ALERT_SEVERITY: Record<string, 'danger' | 'warning' | 'info'> = {
  evento_significativo: 'danger',
  enjambre: 'warning',
  actividad_sentida: 'info',
};

export function getAlertSeverity(tipo: string): 'danger' | 'warning' | 'info' {
  return ALERT_SEVERITY[tipo] ?? 'info';
}

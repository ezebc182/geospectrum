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

/** Categoría de magnitud, mismos cortes que getMagnitudeColor — para agrupar/filtrar. */
export type MagnitudeCategory = 'micro' | 'leve' | 'moderado' | 'fuerte' | 'mayor';

export function getMagnitudeCategory(mag: number): MagnitudeCategory {
  if (mag >= 6) return 'mayor';
  if (mag >= 5) return 'fuerte';
  if (mag >= 4) return 'moderado';
  if (mag >= 3) return 'leve';
  return 'micro';
}

/** Metadata de cada categoría para la leyenda: mismo orden/color que getMagnitudeColor. */
export const MAGNITUDE_CATEGORIES: {
  id: MagnitudeCategory;
  label: string;
  color: string;
}[] = [
  { id: 'micro', label: 'M < 3.0', color: getMagnitudeColor(0) },
  { id: 'leve', label: 'M 3.0-4.0', color: getMagnitudeColor(3) },
  { id: 'moderado', label: 'M 4.0-5.0', color: getMagnitudeColor(4) },
  { id: 'fuerte', label: 'M 5.0-6.0', color: getMagnitudeColor(5) },
  { id: 'mayor', label: 'M > 6.0', color: getMagnitudeColor(6) },
];

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

/**
 * Fecha+hora legible en el locale de FORMATO activo (es-AR/en-US, el que
 * expone `useLocale()` — Decision 2: el mapping app→formato vive solo en
 * i18n/request.ts, por eso acá el locale entra por parámetro y no hay ningún
 * 'es-AR' clavado). Los componentes prefieren `useFormatter().dateTime(...,
 * 'medium')`; esta función queda para call-sites que ya reciben el locale.
 */
export function formatDateTime(isoString: string, locale: string): string {
  return new Date(isoString).toLocaleString(locale, {
    dateStyle: 'medium',
    timeStyle: 'medium',
  });
}

/**
 * "YYYY-MM-DD HH:MM:SS", estilo USGS: una sola línea corta que sigue siendo
 * ordenable a simple vista (año primero), a diferencia de formatDateTime
 * ("5 ago 2026, 1:05:39 p. m.") que es más legible pero casi el doble de ancho.
 */
export function formatDateTimeCompact(isoString: string): string {
  const date = new Date(isoString);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

// formatTimeAgo se ELIMINÓ (i18n-dashboard, Fase 6): hardcodeaba "hace X min"
// en español y su último call-site migró a useFormatter().relativeTime() en la
// Fase 3 — quedaba como código muerto que la auditoría de cobertura marcaría.

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

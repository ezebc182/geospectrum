/**
 * Estado de "leída" de las alertas de la campanita (NotificationBell).
 *
 * Las alertas del /report son DERIVADAS: el backend las recalcula en cada
 * fetch y no tienen id propio. La identidad de una alerta es su huella
 * `tipo + eventos relacionados ordenados`. Consecuencia deliberada: si un
 * enjambre suma un evento nuevo, la huella cambia y la alerta vuelve a "no
 * leída" — información nueva re-notifica.
 *
 * El estado vive en localStorage (decisión del 2026-08-26): es conveniencia
 * de UI por navegador, no una medición — mismo criterio que los settings del
 * helicorder y la progresividad, y misma tolerancia al storage hostil
 * (SSR, JSON corrupto, basura de versiones viejas ⇒ defaults, nunca lanzar).
 */

/** Forma mínima de una alerta para poder identificarla. */
export interface AlertIdentity {
  tipo: string;
  descripcion: string;
  eventos_relacionados: string[];
}

export const READ_ALERTS_STORAGE_KEY = 'alert-read-fingerprints';

/**
 * Techo del storage: las alertas expiran solas del lado del backend, así que
 * las huellas viejas son peso muerto. FIFO: se recortan las más antiguas.
 */
export const MAX_READ_FINGERPRINTS = 200;

/**
 * Huella estable de una alerta. Los ids se ORDENAN antes de unir: el backend
 * no garantiza el orden de eventos_relacionados y la misma alerta no puede
 * tener dos huellas. Sin eventos, cae a la descripción — una huella vacía
 * haría indistinguibles a todas las alertas sin eventos.
 */
export function alertFingerprint(alert: AlertIdentity): string {
  const ids = [...alert.eventos_relacionados].sort();
  const identity = ids.length > 0 ? ids.join(',') : alert.descripcion;
  return `${alert.tipo}|${identity}`;
}

export function loadReadFingerprints(): Set<string> {
  // SSR y modo privado son el caso normal, no un error.
  if (typeof localStorage === 'undefined') return new Set();
  try {
    const raw = localStorage.getItem(READ_ALERTS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((v): v is string => typeof v === 'string'));
  } catch {
    return new Set();
  }
}

export function saveReadFingerprints(read: Set<string>): void {
  if (typeof localStorage === 'undefined') return;
  // Set preserva orden de inserción: recortar por el frente deja las últimas.
  const capped = [...read].slice(-MAX_READ_FINGERPRINTS);
  try {
    localStorage.setItem(READ_ALERTS_STORAGE_KEY, JSON.stringify(capped));
  } catch {
    // Cuota llena: la campanita sigue funcionando, solo no persiste.
  }
}

export function countUnread(alertas: AlertIdentity[], read: Set<string>): number {
  return alertas.filter((a) => !read.has(alertFingerprint(a))).length;
}

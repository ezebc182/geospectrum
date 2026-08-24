/**
 * Modelo de las notificaciones de la app: qué es un toast y cómo se maneja
 * la cola. Sin React ni DOM — la decisión se testea sola.
 *
 * POR QUÉ EXISTE: el relevamiento del 2026-08-24 encontró 9 patrones
 * distintos para comunicar el resultado de una acción, y algo peor: 10 de
 * las 22 acciones que mutan datos NO comunican éxito de ninguna forma
 * (revocar invitación, desactivar usuario, cambiar rol, aprobar signup,
 * borrar muro). El usuario tenía que adivinar mirando si la fila cambió.
 *
 * Tampoco había token de éxito: se improvisaba con 5 verdes distintos
 * (emerald-600, teal-500, primary, severity-low, green-400). Los tokens
 * --success/--warning se agregaron junto con esto.
 */

import type { useTranslations } from 'next-intl';

export type ToastVariant = 'success' | 'error' | 'warning' | 'info';

/**
 * Claves válidas del diccionario. next-intl deriva este tipo de
 * messages/es.json (vía global.d.ts), así que una clave inexistente o mal
 * escrita NO compila — el error se ve en tsc, no en producción como un
 * texto crudo en pantalla.
 */
export type ToastMessageKey = Parameters<ReturnType<typeof useTranslations<never>>>[0];

export interface Toast {
  id: string;
  variant: ToastVariant;
  /**
   * CLAVE del diccionario, NO el texto ya traducido.
   *
   * Invariante del proyecto (comentada en login/page.tsx, BetaSignupsPanel,
   * ExportDataSection, spectrograms y GlobeEventPanel): guardar la clave
   * permite que un cambio de idioma en caliente re-traduzca lo que está en
   * pantalla. Guardar el string ya resuelto lo congelaría en el idioma en que
   * ocurrió la acción.
   */
  messageKey: ToastMessageKey;
  /** Valores para interpolar (ICU), sin resolver el texto. */
  values?: Record<string, string | number>;
}

/**
 * Cuántos se ven a la vez. Sin tope, una acción en lote (revocar 10
 * invitaciones seguidas) taparía la pantalla con una pila de toasts.
 */
export const MAX_VISIBLE_TOASTS = 3;

/**
 * Cuánto dura cada uno antes de irse solo.
 *
 * El error dura más porque hay que poder leerlo y, muchas veces, actuar en
 * consecuencia; un "Guardado" se entiende de un vistazo. Que TODOS tengan
 * duración es lo que evita el problema actual de `ProfileSection.tsx:228`,
 * donde "Perfil actualizado" queda en pantalla indefinidamente.
 */
export const TOAST_DURATION_MS: Record<ToastVariant, number> = {
  success: 4000,
  info: 5000,
  warning: 6000,
  error: 8000,
};

/** Agrega al final y recorta los más viejos si se pasó del máximo. */
export function addToast(queue: Toast[], toast: Toast): Toast[] {
  const next = [...queue, toast];
  // Se descartan los del principio: el usuario acaba de provocar los últimos,
  // y son los que está esperando ver.
  return next.slice(Math.max(0, next.length - MAX_VISIBLE_TOASTS));
}

export function dismissToast(queue: Toast[], id: string): Toast[] {
  return queue.filter((t) => t.id !== id);
}

/**
 * Texto y mecánica para compartir un evento sísmico.
 *
 * Vive aparte del panel porque es lógica pura —entra un evento, sale el texto—
 * y así se testea sin montar el DOM ni simular navigator.share.
 */

import type { SeismicEvent } from '@/lib/types';

/**
 * Texto del mensaje a compartir.
 *
 * Se arma resumido a propósito: esto termina en un chat de WhatsApp o en un
 * tuit, no en un informe. Magnitud y lugar primero, que es lo que se lee en la
 * previsualización antes de abrir nada.
 *
 * La hora va en UTC y con la sigla explícita: un sismo lo comenta gente en
 * varios husos y "14:30" sin referencia no significa nada.
 */
export function buildShareText(evento: SeismicEvent): string {
  const magnitud = `M${evento.mag.toFixed(1)}`;
  const lugar = evento.lugar ?? 'ubicación desconocida';
  const profundidad =
    evento.prof_km === null || evento.prof_km === undefined
      ? null
      : `${evento.prof_km.toFixed(0)} km de profundidad`;

  const partes = [
    `Sismo ${magnitud} — ${lugar}`,
    [formatUtc(evento.hora_utc), profundidad].filter(Boolean).join(' · '),
  ];

  // Los eventos automáticos se revisan después y la magnitud puede corregirse:
  // avisarlo evita que alguien comparta un dato preliminar como definitivo.
  if (!evento.revisado) {
    partes.push('Solución automática, sin revisar por analista.');
  }

  return partes.filter(Boolean).join('\n');
}

/** Hora del evento en UTC, legible y sin ambigüedad de huso. */
function formatUtc(isoString: string): string {
  const fecha = new Date(isoString);
  if (Number.isNaN(fecha.getTime())) return 'fecha desconocida';

  return `${fecha.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** Parámetro de la URL que identifica el evento enfocado en el globo. */
export const EVENT_PARAM = 'event';

/**
 * URL absoluta que apunta a un evento concreto.
 *
 * Vive acá y no en la página del globo para que el panel pueda usarla sin
 * importar desde una ruta —eso arma un ciclo entre página y componente.
 */
export function eventUrl(eventId: string, base = window.location.href): string {
  const url = new URL(base);
  url.searchParams.set(EVENT_PARAM, eventId);
  return url.toString();
}

/** Resultado de intentar compartir, para que la UI dé la devolución correcta. */
export type ShareOutcome = 'shared' | 'copied' | 'dismissed' | 'failed';

/**
 * Comparte el evento con el menú nativo del sistema, o copia al portapapeles.
 *
 * `navigator.share` existe en mobile y abre el selector con WhatsApp, X,
 * Telegram y demás. En escritorio casi nunca está, así que el fallback es
 * copiar: es lo que el usuario iba a hacer a mano de todos modos.
 *
 * Cancelar el diálogo del sistema lanza AbortError. NO es un error a reportar
 * —el usuario decidió no compartir— y mostrarle un cartel de fallo por haber
 * apretado "cancelar" es exactamente el tipo de ruido que hace desconfiar de
 * una interfaz.
 */
export async function shareEvent(
  evento: SeismicEvent,
  url?: string,
): Promise<ShareOutcome> {
  const text = buildShareText(evento);

  if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    try {
      await navigator.share({ title: 'Monitor sísmico', text, url });
      return 'shared';
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return 'dismissed';
      // Si el menú nativo falla por otra razón, todavía queda copiar.
    }
  }

  return copyToClipboard(url ? `${text}\n${url}` : text);
}

async function copyToClipboard(text: string): Promise<ShareOutcome> {
  // El portapapeles necesita contexto seguro (HTTPS o localhost): en una IP de
  // red local por HTTP la API no existe y hay que decirlo, no fallar callado.
  if (typeof navigator === 'undefined' || !navigator.clipboard) return 'failed';

  try {
    await navigator.clipboard.writeText(text);
    return 'copied';
  } catch {
    return 'failed';
  }
}

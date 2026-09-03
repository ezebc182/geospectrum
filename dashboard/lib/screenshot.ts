/**
 * Captura opcional de pantalla para el panel de feedback (design.md
 * Decision 3, spec.md "Persistencia de la captura opcional").
 *
 * Las tres funciones NUNCA lanzan: cualquier fallo en cualquier paso
 * (captura, presign, PUT a R2) devuelve `null` en silencio — el submit del
 * widget no depende de esto y no debe verse afectado (spec.md "R2 mal
 * configurado no bloquea el resto del feedback").
 */

import { domToBlob } from 'modern-screenshot';
import { requestScreenshotUploadUrl } from './feedback';

/** Cap del PNG final tras compresión client-side (tasks.md Fase 3,
 * decisión de la spec: 1920px de lado largo, 2MB tras comprimir). Si el
 * resultado de modern-screenshot sigue por encima, se descarta en vez de
 * reintentar o bloquear el envío. */
const MAX_SIDE_PX = 1920;
const MAX_BYTES = 2 * 1024 * 1024;

/**
 * Captura el `<body>` de la app con `modern-screenshot`, redimensionado al
 * lado largo máximo de 1920px. Cualquier excepción de la librería (fuentes
 * cross-origin, canvas tainted, etc.) se atrapa y devuelve `null` — la
 * captura es un adjunto opcional, nunca una condición de error visible.
 */
export async function captureScreenshot(): Promise<Blob | null> {
  try {
    const { innerWidth, innerHeight } = window;
    const longSide = Math.max(innerWidth, innerHeight, 1);
    const scale = longSide > MAX_SIDE_PX ? MAX_SIDE_PX / longSide : 1;

    const blob = await domToBlob(document.body, { scale, type: 'image/png' });
    if (blob.size > MAX_BYTES) return null;
    return blob;
  } catch {
    return null;
  }
}

/**
 * Recorre `document.querySelectorAll('canvas')` y devuelve `true` ante el
 * primer `getContext('webgl'|'webgl2')` no-null. Falsos positivos son
 * aceptables (un canvas 2D que también soporta un contexto WebGL nunca
 * usado); falsos negativos son el riesgo real que el proposal señala —
 * mejor avisar de más que dejar pasar un globo 3D sin captura fiel.
 */
export function detectWebglCanvas(): boolean {
  const canvases = document.querySelectorAll('canvas');
  for (const canvas of Array.from(canvases)) {
    if (canvas.getContext('webgl') || canvas.getContext('webgl2')) return true;
  }
  return false;
}

/**
 * Presign + `PUT` directo del browser a R2 — el binario nunca pasa por
 * FastAPI. Cualquier fallo en cualquier paso (503 de R2 sin configurar,
 * network error del PUT, respuesta !ok) devuelve `null` sin lanzar.
 */
export async function uploadScreenshot(blob: Blob): Promise<string | null> {
  try {
    const presign = await requestScreenshotUploadUrl();
    if (presign === null) return null;

    const response = await fetch(presign.upload_url, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png' },
      body: blob,
    });
    if (!response.ok) return null;

    return presign.key;
  } catch {
    return null;
  }
}

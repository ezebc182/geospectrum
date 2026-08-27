/**
 * Sello de marca para las imágenes que salen de la app (share de rango y de
 * apuntes): la imagen que termina en un chat es la cara pública del producto.
 *
 * DOM-touching a propósito (createElement + canvas 2D): vive aparte de las
 * libs puras de share para que aquellas sigan siendo testeables sin DOM.
 */

const STAMP_LABEL = 'geospectrum.org';

/**
 * Una COPIA del canvas con "geospectrum.org" estampado abajo a la derecha.
 * El original no se toca: es el canvas VIVO del wave view en pantalla.
 * Sin contexto 2D devuelve el original — imagen sin sello antes que ninguna.
 */
export function stampCanvas(source: HTMLCanvasElement, label = STAMP_LABEL): HTMLCanvasElement {
  const copy = document.createElement('canvas');
  copy.width = source.width;
  copy.height = source.height;
  const ctx = copy.getContext('2d');
  if (!ctx) return source;

  ctx.drawImage(source, 0, 0);

  // Discreto pero legible: esquina inferior derecha, sobre una banda tenue
  // para sobrevivir tanto fondo blanco como trazos oscuros.
  const fontPx = Math.max(11, Math.round(copy.width / 60));
  const padding = Math.round(fontPx / 2);
  ctx.font = `${fontPx}px monospace`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.globalAlpha = 0.75;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(
    copy.width - label.length * fontPx * 0.62 - padding * 2,
    copy.height - fontPx - padding * 2,
    label.length * fontPx * 0.62 + padding * 2,
    fontPx + padding * 2,
  );
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = '#334155';
  ctx.fillText(label, copy.width - padding, copy.height - padding);
  ctx.globalAlpha = 1;
  return copy;
}

/**
 * El canvas SELLADO como archivo PNG, o null donde no se puede (jsdom,
 * canvas tainted, toBlob que nunca llama al callback). El share de texto no
 * puede colgarse esperando la imagen: a los 300 ms se sigue sin ella.
 */
export function canvasToFile(canvas: HTMLCanvasElement | null, name: string): Promise<File | null> {
  if (!canvas || typeof canvas.toBlob !== 'function') return Promise.resolve(null);
  const stamped = stampCanvas(canvas);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 300);
    try {
      stamped.toBlob((blob) => {
        clearTimeout(timer);
        resolve(blob ? new File([blob], name, { type: 'image/png' }) : null);
      });
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

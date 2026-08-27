/**
 * Vértices del trazo de la onda a partir de los pares min/max decimados.
 *
 * POR QUÉ EXISTE (bug del QA 2.19): el dibujo original trazaba un segmento
 * vertical AISLADO de max a min por cada par. Cuando la ventana tiene menos
 * muestras que los `points` pedidos, el backend entra en passthrough y cada
 * par llega con min == max: el segmento mide cero píxeles y el canvas
 * quedaba en blanco con la señal presente.
 *
 * La forma estándar de los visores sísmicos es UN solo polyline que
 * zigzaguea max→min de cada par y se ENCADENA con el siguiente: en modo
 * decimado se ven las barras (más la conexión, que elimina huecos) y en
 * passthrough la conexión entre muestras consecutivas ES la forma de onda.
 */

export interface TraceVertex {
  /** Índice del par (la coordenada x la escala el renderer). */
  pair: number;
  /** Valor en cuentas (la coordenada y la escala el renderer). */
  value: number;
}

export function buildTracePolyline(mins: number[], maxs: number[]): TraceVertex[] {
  const vertices: TraceVertex[] = [];
  const pairs = Math.min(mins.length, maxs.length);
  for (let i = 0; i < pairs; i++) {
    vertices.push({ pair: i, value: maxs[i] });
    // Par degenerado (passthrough): un solo vértice, sin duplicar.
    if (mins[i] !== maxs[i]) {
      vertices.push({ pair: i, value: mins[i] });
    }
  }
  return vertices;
}

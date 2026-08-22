/**
 * URL base de los WebSockets del backend.
 *
 * Vivía duplicada en LiveSpectrogramCanvas (:32-33) y el PR-W4 agrega un
 * segundo cliente (/ws/events): con dos copias del `.replace(/^http/, 'ws')`
 * un cambio de env var se arregla en un lado y se olvida en el otro.
 *
 * El replace cubre los dos esquemas de un saque: http→ws y https→wss.
 *
 * Los WebSockets del navegador NO pueden mandar headers, así que estas
 * conexiones son anónimas. No es un descuido: los endpoints sísmicos son
 * públicos por política del proyecto (ver src/api/routers/stations.py:4-6) y
 * lo que exige sesión es la UI del dashboard, no el dato.
 */

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

export const WS_BASE = API_BASE.replace(/^http/, 'ws');

/** URL completa de un endpoint WS. `path` va con la barra inicial. */
export function wsUrl(path: string): string {
  return `${WS_BASE}${path}`;
}

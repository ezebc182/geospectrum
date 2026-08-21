/**
 * Selección del muro de la cartelera (spec §2): query param `?wall=` gana
 * sobre localStorage (kiosks por URL), default el muro de fábrica "Global".
 * Lib pura, patrón readFocusMode de event-focus.ts.
 */

import type { Wall, WallResponse } from './types';

export const WALL_PARAM = 'wall';
export const WALL_STORAGE_KEY = 'globe.broadcast.wall.v1';
export const GLOBAL_WALL_ID = 'global';

export function readWallSelection(search: string, stored: string | null): string {
  const fromQuery = new URLSearchParams(search).get(WALL_PARAM);
  if (fromQuery) return fromQuery;
  if (stored) return stored;
  return GLOBAL_WALL_ID;
}

export function resolveWall(
  selectedId: string,
  userWalls: Wall[] | null | undefined,
  globalWall: WallResponse | undefined
): WallResponse | undefined {
  if (selectedId !== GLOBAL_WALL_ID) {
    const match = userWalls?.find((wall) => wall.id === selectedId);
    if (match) return match;
  }
  // Fallback deliberado: id desconocido/borrado → Global, la cartelera nunca en blanco
  return globalWall;
}

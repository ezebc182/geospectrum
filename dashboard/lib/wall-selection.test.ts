import { describe, expect, it } from 'vitest';
import type { Wall, WallResponse } from './types';
import { GLOBAL_WALL_ID, readWallSelection, resolveWall } from './wall-selection';

const GLOBAL: WallResponse = {
  id: 'global',
  name: 'Global',
  layout: { columns: [{ groups: [] }], showMetrics: false },
};

const MINE: Wall = {
  id: 'w1',
  name: 'Andes',
  layout: { columns: [{ groups: [] }], showMetrics: false },
  created_at: '',
  updated_at: '',
};

describe('readWallSelection', () => {
  it('el query param gana sobre lo guardado', () => {
    expect(readWallSelection('?wall=w1', 'w2')).toBe('w1');
  });
  it('sin query usa lo guardado; sin nada, global', () => {
    expect(readWallSelection('', 'w2')).toBe('w2');
    expect(readWallSelection('', null)).toBe(GLOBAL_WALL_ID);
  });
});

describe('resolveWall', () => {
  it('encuentra el muro del usuario por id', () => {
    expect(resolveWall('w1', [MINE], GLOBAL)).toBe(MINE);
  });
  it('id desconocido o muro borrado cae al Global (kiosk nunca en blanco)', () => {
    expect(resolveWall('fantasma', [MINE], GLOBAL)).toBe(GLOBAL);
    expect(resolveWall('w1', null, GLOBAL)).toBe(GLOBAL);
  });
  it('global explícito devuelve el Global', () => {
    expect(resolveWall(GLOBAL_WALL_ID, [MINE], GLOBAL)).toBe(GLOBAL);
  });
});

import { describe, expect, it } from 'vitest';
import type { WallLayout } from './types';
import {
  addChannel,
  addColumn,
  addGroup,
  countChannels,
  createEmptyLayout,
  hasChannel,
  MAX_WALL_CHANNELS,
  MAX_WALL_COLUMNS,
  moveChannel,
  moveGroup,
  removeChannel,
  removeColumn,
  removeGroup,
  renameGroup,
  toggleMetrics,
} from './wall-editor';

const TOKYO = { channel: 'IU.MAJO.00.BHZ', label: 'Tokyo' };
const LIMA = { channel: 'II.NNA.00.BHZ', label: 'Lima' };

function baseLayout(): WallLayout {
  return {
    columns: [{ groups: [{ title: 'ASIA', channels: [TOKYO] }] }],
    showMetrics: false,
  };
}

describe('wall-editor', () => {
  it('createEmptyLayout arranca con una columna vacía', () => {
    expect(createEmptyLayout()).toEqual({ columns: [{ groups: [] }], showMetrics: false });
  });

  it('addChannel agrega al final del grupo sin mutar el original', () => {
    const layout = baseLayout();
    const next = addChannel(layout, 0, 0, LIMA);
    expect(next.columns[0].groups[0].channels).toEqual([TOKYO, LIMA]);
    expect(layout.columns[0].groups[0].channels).toEqual([TOKYO]); // inmutable
  });

  it('addChannel es no-op (misma referencia) si el canal ya está en CUALQUIER grupo', () => {
    const layout = addGroup(baseLayout(), 0, 'OTRA');
    expect(addChannel(layout, 0, 1, TOKYO)).toBe(layout);
  });

  it('addChannel es no-op al llegar al máximo de canales', () => {
    let layout = createEmptyLayout();
    layout = addGroup(layout, 0, 'BULK');
    for (let i = 0; i < MAX_WALL_CHANNELS; i++) {
      layout = addChannel(layout, 0, 0, { channel: `IU.S${String(i).padStart(3, '0')}.00.BHZ`, label: `s${i}` });
    }
    expect(countChannels(layout)).toBe(MAX_WALL_CHANNELS);
    expect(addChannel(layout, 0, 0, { channel: 'IU.FULL.00.BHZ', label: 'full' })).toBe(layout);
  });

  it('removeChannel y hasChannel', () => {
    const layout = baseLayout();
    const next = removeChannel(layout, 0, 0, 0);
    expect(next.columns[0].groups[0].channels).toEqual([]);
    expect(hasChannel(layout, TOKYO.channel)).toBe(true);
    expect(hasChannel(next, TOKYO.channel)).toBe(false);
  });

  it('moveChannel intercambia con el vecino y respeta los bordes', () => {
    const layout = addChannel(baseLayout(), 0, 0, LIMA);
    const down = moveChannel(layout, 0, 0, 0, 1);
    expect(down.columns[0].groups[0].channels).toEqual([LIMA, TOKYO]);
    expect(moveChannel(layout, 0, 0, 0, -1)).toBe(layout); // borde: no-op
    expect(moveChannel(layout, 0, 0, 1, 1)).toBe(layout);
  });

  it('grupos: agregar, renombrar, mover, quitar', () => {
    let layout = addGroup(baseLayout(), 0, 'OCEANÍA');
    expect(layout.columns[0].groups.map((g) => g.title)).toEqual(['ASIA', 'OCEANÍA']);
    layout = renameGroup(layout, 0, 1, 'PACÍFICO');
    expect(layout.columns[0].groups[1].title).toBe('PACÍFICO');
    layout = moveGroup(layout, 0, 1, -1);
    expect(layout.columns[0].groups.map((g) => g.title)).toEqual(['PACÍFICO', 'ASIA']);
    layout = removeGroup(layout, 0, 0);
    expect(layout.columns[0].groups.map((g) => g.title)).toEqual(['ASIA']);
  });

  it('columnas: agrega hasta el máximo y nunca deja cero', () => {
    let layout = createEmptyLayout();
    for (let i = 0; i < MAX_WALL_COLUMNS + 2; i++) layout = addColumn(layout);
    expect(layout.columns).toHaveLength(MAX_WALL_COLUMNS);
    for (let i = 0; i < MAX_WALL_COLUMNS + 2; i++) layout = removeColumn(layout, 0);
    expect(layout.columns).toHaveLength(1);
  });

  it('removeColumn descarta la columna con sus canales', () => {
    let layout = addColumn(baseLayout());
    layout = removeColumn(layout, 0);
    expect(countChannels(layout)).toBe(0);
  });

  it('toggleMetrics invierte showMetrics', () => {
    expect(toggleMetrics(baseLayout()).showMetrics).toBe(true);
  });
});

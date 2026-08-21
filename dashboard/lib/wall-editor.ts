/**
 * Operaciones puras de edición del layout de un muro (armador PR-W2).
 * Todas inmutables; un no-op devuelve el MISMO objeto (los componentes
 * pueden comparar por referencia y saltarse el re-render). Los límites
 * espejan la validación server-side de wall_service.py.
 */

import type { WallChannel, WallColumn, WallGroup, WallLayout } from './types';

export const MAX_WALL_COLUMNS = 8;
export const MAX_WALL_CHANNELS = 120;

export function createEmptyLayout(): WallLayout {
  return { columns: [{ groups: [] }], showMetrics: false };
}

export function countChannels(layout: WallLayout): number {
  return layout.columns.reduce(
    (total, col) => total + col.groups.reduce((n, g) => n + g.channels.length, 0),
    0
  );
}

export function hasChannel(layout: WallLayout, channel: string): boolean {
  return layout.columns.some((col) =>
    col.groups.some((g) => g.channels.some((ch) => ch.channel === channel))
  );
}

function mapColumn(layout: WallLayout, col: number, fn: (c: WallColumn) => WallColumn): WallLayout {
  return { ...layout, columns: layout.columns.map((c, i) => (i === col ? fn(c) : c)) };
}

function mapGroup(layout: WallLayout, col: number, group: number, fn: (g: WallGroup) => WallGroup): WallLayout {
  return mapColumn(layout, col, (c) => ({
    ...c,
    groups: c.groups.map((g, i) => (i === group ? fn(g) : g)),
  }));
}

function moveItem<T>(items: T[], index: number, dir: -1 | 1): T[] | null {
  const target = index + dir;
  if (index < 0 || index >= items.length || target < 0 || target >= items.length) return null;
  const next = [...items];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export function addColumn(layout: WallLayout): WallLayout {
  if (layout.columns.length >= MAX_WALL_COLUMNS) return layout;
  return { ...layout, columns: [...layout.columns, { groups: [] }] };
}

export function removeColumn(layout: WallLayout, col: number): WallLayout {
  if (layout.columns.length <= 1) return layout;
  return { ...layout, columns: layout.columns.filter((_, i) => i !== col) };
}

export function addGroup(layout: WallLayout, col: number, title: string): WallLayout {
  return mapColumn(layout, col, (c) => ({ ...c, groups: [...c.groups, { title, channels: [] }] }));
}

export function renameGroup(layout: WallLayout, col: number, group: number, title: string): WallLayout {
  return mapGroup(layout, col, group, (g) => ({ ...g, title }));
}

export function removeGroup(layout: WallLayout, col: number, group: number): WallLayout {
  return mapColumn(layout, col, (c) => ({ ...c, groups: c.groups.filter((_, i) => i !== group) }));
}

export function moveGroup(layout: WallLayout, col: number, group: number, dir: -1 | 1): WallLayout {
  const moved = moveItem(layout.columns[col]?.groups ?? [], group, dir);
  if (!moved) return layout;
  return mapColumn(layout, col, (c) => ({ ...c, groups: moved }));
}

export function addChannel(layout: WallLayout, col: number, group: number, ch: WallChannel): WallLayout {
  if (hasChannel(layout, ch.channel) || countChannels(layout) >= MAX_WALL_CHANNELS) return layout;
  return mapGroup(layout, col, group, (g) => ({ ...g, channels: [...g.channels, ch] }));
}

export function removeChannel(layout: WallLayout, col: number, group: number, index: number): WallLayout {
  return mapGroup(layout, col, group, (g) => ({
    ...g,
    channels: g.channels.filter((_, i) => i !== index),
  }));
}

export function moveChannel(layout: WallLayout, col: number, group: number, index: number, dir: -1 | 1): WallLayout {
  const moved = moveItem(layout.columns[col]?.groups[group]?.channels ?? [], index, dir);
  if (!moved) return layout;
  return mapGroup(layout, col, group, (g) => ({ ...g, channels: moved }));
}

export function toggleMetrics(layout: WallLayout): WallLayout {
  return { ...layout, showMetrics: !layout.showMetrics };
}

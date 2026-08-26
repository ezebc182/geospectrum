'use client';

/**
 * Armador manual de muros (spec §2, v1 sin drag & drop): catálogo con
 * búsqueda a la izquierda, estructura de columnas/grupos a la derecha,
 * reordenar con flechas. Componente controlado: el layout vive en el padre
 * (que también renderiza la preview); acá solo hay selección de grupo
 * activo y texto de búsqueda.
 */

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import type { WallChannel, WallLayout } from '@/lib/types';
import {
  addChannel,
  addColumn,
  addGroup,
  hasChannel,
  MAX_WALL_TEXT_LEN,
  moveChannel,
  moveGroup,
  removeChannel,
  removeColumn,
  removeGroup,
  renameGroup,
  toggleMetrics,
} from '@/lib/wall-editor';

/**
 * Entrada del catálogo del armador (PR-W3): un WallChannel más lo que se
 * necesita para elegir subestación como en SWARM — el código de estación
 * (buscable) y si está transmitiendo ahora (informativo, no filtra).
 */
export interface CatalogItem extends WallChannel {
  station: string;
  isLive: boolean;
}

interface WallBuilderProps {
  layout: WallLayout;
  onChange: (layout: WallLayout) => void;
  catalog: CatalogItem[];
}

export function WallBuilder({ layout, onChange, catalog }: WallBuilderProps) {
  const t = useTranslations('charts.spectrogramsPage.wall');
  const [search, setSearch] = useState('');
  // Grupo activo: destino de "Agregar" desde el catálogo
  const [active, setActive] = useState<{ col: number; group: number }>({ col: 0, group: 0 });

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return catalog;
    // El código de estación se busca aparte del label: con 75 candidatas el
    // usuario que quiere MT14 lo escribe tal cual, no "Santiago".
    return catalog.filter(
      (ch) =>
        ch.label.toLowerCase().includes(query) ||
        ch.channel.toLowerCase().includes(query) ||
        ch.station.toLowerCase().includes(query)
    );
  }, [catalog, search]);

  const activeGroupExists = Boolean(layout.columns[active.col]?.groups[active.group]);

  return (
    <div className="flex gap-4">
      {/* Catálogo */}
      <div className="w-64 shrink-0 rounded-md border border-border p-2">
        <div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
          {t('catalogTitle')}
        </div>
        <input
          className="mb-2 w-full rounded border border-border bg-background px-2 py-1 text-sm"
          placeholder={t('searchPlaceholder')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <ul className="max-h-80 space-y-1 overflow-y-auto" data-testid="wall-catalog">
          {filtered.map((ch, i) => {
            const present = hasChannel(layout, ch.channel);
            return (
              // El canal solo NO es único en el catálogo crudo (estaciones
              // compartidas entre ciudades): el índice blinda la key aunque
              // aguas arriba se cuele otro duplicado.
              <li key={`${ch.channel}:${i}`} className="flex items-center justify-between gap-2 text-sm">
                <span className="truncate" title={ch.channel}>
                  <span
                    aria-hidden
                    title={ch.isLive ? t('channelLive') : t('channelSilent')}
                    className={`mr-1 inline-block h-1.5 w-1.5 rounded-full ${
                      ch.isLive ? 'bg-teal-500' : 'bg-muted-foreground/50'
                    }`}
                  />
                  {ch.label}
                  <span className="ml-1 font-mono text-[10px] text-muted-foreground">{ch.channel}</span>
                </span>
                <button
                  type="button"
                  className="rounded border border-border px-1.5 py-0.5 text-xs disabled:opacity-40"
                  disabled={present || !activeGroupExists}
                  title={present ? t('alreadyInWall') : t('add')}
                  // Solo {channel, label} se persiste: station/isLive son del
                  // catálogo del armador, meterlos en el layout guardaría
                  // frescura vieja como si fuera parte del muro.
                  onClick={() =>
                    onChange(
                      addChannel(layout, active.col, active.group, {
                        channel: ch.channel,
                        label: ch.label,
                      })
                    )
                  }
                >
                  {t('add')}
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      {/* Estructura del muro */}
      <div className="flex flex-1 gap-3 overflow-x-auto">
        {layout.columns.map((column, ci) => (
          <div key={ci} className="w-64 shrink-0 rounded-md border border-border p-2">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-semibold uppercase text-muted-foreground">
                {t('column', { number: ci + 1 })}
              </span>
              <button
                type="button"
                aria-label={t('removeColumn')}
                className="text-muted-foreground hover:text-destructive"
                onClick={() => onChange(removeColumn(layout, ci))}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
            {column.groups.map((group, gi) => {
              const isActive = active.col === ci && active.group === gi;
              const selectThisGroup = () => setActive({ col: ci, group: gi });
              return (
                <div
                  key={gi}
                  role="button"
                  tabIndex={0}
                  aria-pressed={isActive}
                  aria-label={t('selectGroup')}
                  className={`mb-2 rounded border p-1.5 ${isActive ? 'border-teal-500' : 'border-border'}`}
                  onClick={selectThisGroup}
                  onKeyDown={(e) => {
                    // Solo el contenedor mismo activa el grupo con teclado — un
                    // Enter/Espacio dentro del input de título o de los botones
                    // internos NO debe re-disparar la selección (evita el mismo
                    // problema de bubbling que el click).
                    if (e.target !== e.currentTarget) return;
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      selectThisGroup();
                    }
                  }}
                >
                  <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                    <input
                      aria-label={t('groupTitleLabel')}
                      className="w-full bg-transparent font-mono text-xs font-bold uppercase"
                      value={group.title}
                      maxLength={MAX_WALL_TEXT_LEN}
                      onChange={(e) => onChange(renameGroup(layout, ci, gi, e.target.value))}
                    />
                    <button type="button" aria-label={t('moveUp')} onClick={() => onChange(moveGroup(layout, ci, gi, -1))}>
                      <ArrowUp className="h-3 w-3" />
                    </button>
                    <button type="button" aria-label={t('moveDown')} onClick={() => onChange(moveGroup(layout, ci, gi, 1))}>
                      <ArrowDown className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      aria-label={t('removeGroup')}
                      onClick={() => onChange(removeGroup(layout, ci, gi))}
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                  {group.channels.length === 0 && (
                    <div className="py-1 text-[11px] text-muted-foreground">{t('emptyGroup')}</div>
                  )}
                  <ul onClick={(e) => e.stopPropagation()}>
                    {group.channels.map((ch, chi) => (
                      <li
                        key={ch.channel}
                        data-testid="builder-channel-row"
                        className="flex items-center justify-between gap-1 py-0.5 text-xs"
                      >
                        <span className="truncate" title={ch.channel}>{ch.label}</span>
                        <span className="flex shrink-0 items-center gap-0.5">
                          <button type="button" aria-label={t('moveUp')} onClick={() => onChange(moveChannel(layout, ci, gi, chi, -1))}>
                            <ArrowUp className="h-3 w-3" />
                          </button>
                          <button type="button" aria-label={t('moveDown')} onClick={() => onChange(moveChannel(layout, ci, gi, chi, 1))}>
                            <ArrowDown className="h-3 w-3" />
                          </button>
                          <button type="button" aria-label={t('remove')} onClick={() => onChange(removeChannel(layout, ci, gi, chi))}>
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
            <button
              type="button"
              className="flex w-full items-center justify-center gap-1 rounded border border-dashed border-border py-1 text-xs text-muted-foreground"
              onClick={() => onChange(addGroup(layout, ci, t('newGroupTitle')))}
            >
              <Plus className="h-3 w-3" /> {t('addGroup')}
            </button>
          </div>
        ))}
        <button
          type="button"
          className="h-10 shrink-0 rounded border border-dashed border-border px-3 text-xs text-muted-foreground"
          onClick={() => onChange(addColumn(layout))}
        >
          <span className="flex items-center gap-1"><Plus className="h-3 w-3" /> {t('addColumn')}</span>
        </button>
      </div>

      <label className="sr-only flex items-center gap-2 text-xs">
        <input type="checkbox" checked={layout.showMetrics} onChange={() => onChange(toggleMetrics(layout))} />
        {t('showMetrics')}
      </label>
    </div>
  );
}

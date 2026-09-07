/**
 * Selector de canales de /analytics (analytics-professional-panels, 5.2;
 * design Decision 3, spec dashboard-ui "Resuelto por el design" §2).
 *
 * Alimentado por `GET /spectrograms/station-catalog` (TODAS las candidatas
 * ingestadas, no solo la ganadora por ciudad). Hasta `MAX_PICKED_CHANNELS`:
 * cada canal elegido es una request FDSN de segundos para RSAM y otra para
 * tremor, y el tope es lo que mantiene el panel usable. Componente
 * controlado: `selected`/`onChange`, la página guarda la lista.
 *
 * `is_live` es informativo (una candidata muda se ofrece igual): el badge lo
 * dice y el usuario decide.
 */

'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';

import { seismicAPI } from '@/lib/api';
import { filterCatalog } from '@/lib/station-search';
import type { StationCatalogEntry } from '@/lib/types';

export const MAX_PICKED_CHANNELS = 4;

interface StationPickerProps {
  selected: string[];
  onChange: (channels: string[]) => void;
  className?: string;
}

type CatalogState =
  | { status: 'loading' }
  | { status: 'ready'; entries: StationCatalogEntry[] }
  | { status: 'error' };

export function StationPicker({ selected, onChange, className }: StationPickerProps) {
  const t = useTranslations('analytics');
  const [catalog, setCatalog] = useState<CatalogState>({ status: 'loading' });
  const [term, setTerm] = useState('');
  const [limitHit, setLimitHit] = useState(false);

  useEffect(() => {
    let cancelled = false;
    seismicAPI
      .getStationCatalog()
      .then((entries) => {
        if (!cancelled) setCatalog({ status: 'ready', entries });
      })
      .catch(() => {
        if (!cancelled) setCatalog({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const visible = useMemo(
    () => (catalog.status === 'ready' ? filterCatalog(catalog.entries, term) : []),
    [catalog, term],
  );

  const toggle = (channel: string) => {
    if (selected.includes(channel)) {
      setLimitHit(false);
      onChange(selected.filter((c) => c !== channel));
      return;
    }
    if (selected.length >= MAX_PICKED_CHANNELS) {
      // El 5.º no entra: se avisa y NO se llama a onChange.
      setLimitHit(true);
      return;
    }
    setLimitHit(false);
    onChange([...selected, channel]);
  };

  return (
    <div className={className ?? 'space-y-2'} data-testid="station-picker">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('picker.title')}</span>
        <span className="text-xs text-muted-foreground">
          {t('picker.selected', { count: selected.length, max: MAX_PICKED_CHANNELS })}
        </span>
      </div>

      {catalog.status === 'loading' && (
        <div role="status" className="text-sm text-muted-foreground">
          {t('picker.loading')}
        </div>
      )}

      {catalog.status === 'error' && (
        <div
          role="alert"
          className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300"
        >
          {t('picker.error')}
        </div>
      )}

      {catalog.status === 'ready' && (
        <>
          <input
            type="search"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            aria-label={t('picker.filter')}
            placeholder={t('picker.filter')}
            className="w-full rounded border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-800"
          />
          {limitHit && (
            <p role="status" className="text-xs text-amber-700 dark:text-amber-400">
              {t('picker.max4')}
            </p>
          )}
          {visible.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('picker.noMatches')}</p>
          ) : (
            <ul className="flex max-h-48 flex-wrap gap-1 overflow-y-auto">
              {visible.map((entry) => {
                const isActive = selected.includes(entry.channel);
                return (
                  <li key={entry.channel}>
                    <button
                      type="button"
                      aria-pressed={isActive}
                      onClick={() => toggle(entry.channel)}
                      className={
                        'inline-flex items-center gap-1 rounded border px-2 py-0.5 font-mono text-xs transition-colors ' +
                        (isActive
                          ? 'border-seismic-600 bg-seismic-600 text-white'
                          : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700')
                      }
                    >
                      <span>{entry.channel}</span>
                      {entry.is_live && (
                        <span
                          className={
                            'rounded px-1 text-[10px] uppercase ' +
                            (isActive ? 'bg-white/20' : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-300')
                          }
                        >
                          {t('picker.live')}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

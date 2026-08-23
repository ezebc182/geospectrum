/**
 * Buscador híbrido de estaciones.
 *
 * Una sola caja de texto alimenta dos fuentes que se complementan:
 *
 * - El CATÁLOGO local (75 candidatas) se filtra en memoria: instantáneo, y
 *   permite buscar por nombre de ciudad ("tokyo").
 * - FDSN se consulta con debounce y sólo si el término parece un código de
 *   estación. Llega a cualquier estación del mundo, pero NO entiende nombres
 *   de lugar (verificado contra IRIS: `*USC*` -> 3 estaciones, `NEV*` -> 204).
 *
 * No hay selector de modo a propósito: quien busca no tiene por qué saber de
 * antemano en cuál de las dos fuentes vive lo que busca.
 */

'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, Radio, Search, X } from 'lucide-react';

import {
  filterCatalog,
  groupByCity,
  shouldQueryFdsn,
  type CatalogStation,
  type FdsnStation,
} from '@/lib/station-search';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

/** Espera antes de salir a FDSN. Una consulta cuesta ~1,2 s: disparar por
 *  tecla haría cola de peticiones que llegan fuera de orden. */
const DEBOUNCE_MS = 400;

function stationHref(channel: string): string {
  return `/stations/${encodeURIComponent(channel)}`;
}

export function StationSearch() {
  const t = useTranslations('stations');

  const [term, setTerm] = useState('');
  const [catalog, setCatalog] = useState<CatalogStation[]>([]);
  const [catalogError, setCatalogError] = useState(false);
  const [catalogLoading, setCatalogLoading] = useState(true);

  const [worldResults, setWorldResults] = useState<FdsnStation[]>([]);
  const [worldLoading, setWorldLoading] = useState(false);
  const [worldError, setWorldError] = useState(false);
  const [worldQueried, setWorldQueried] = useState(false);

  const [reloadToken, setReloadToken] = useState(0);

  async function loadCatalog(signal: AbortSignal) {
    setCatalogLoading(true);
    setCatalogError(false);
    try {
      const res = await fetch(`${API_BASE_URL}/spectrograms/station-catalog`, {
        signal,
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setCatalog(await res.json());
    } catch (err) {
      if ((err as Error).name !== 'AbortError') setCatalogError(true);
    } finally {
      if (!signal.aborted) setCatalogLoading(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void loadCatalog(controller.signal);
    return () => controller.abort();
  }, [reloadToken]);

  // Búsqueda en FDSN, con debounce. El AbortController de la limpieza es lo
  // que evita que una respuesta lenta de una búsqueda vieja pise el resultado
  // de la búsqueda actual.
  const requestSeq = useRef(0);
  useEffect(() => {
    if (!shouldQueryFdsn(term)) {
      setWorldResults([]);
      setWorldError(false);
      setWorldLoading(false);
      setWorldQueried(false);
      return;
    }

    const controller = new AbortController();
    const seq = ++requestSeq.current;
    setWorldLoading(true);
    setWorldError(false);

    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `${API_BASE_URL}/stations/search?q=${encodeURIComponent(term.trim())}`,
          { signal: controller.signal, credentials: 'include' },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (seq === requestSeq.current) {
          setWorldResults(data.stations ?? []);
          setWorldQueried(true);
        }
      } catch (err) {
        if ((err as Error).name !== 'AbortError' && seq === requestSeq.current) {
          setWorldError(true);
          setWorldResults([]);
        }
      } finally {
        if (seq === requestSeq.current) setWorldLoading(false);
      }
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [term]);

  const catalogMatches = useMemo(() => filterCatalog(catalog, term), [catalog, term]);
  const cityGroups = useMemo(() => groupByCity(catalogMatches), [catalogMatches]);

  // Las que ya están en el catálogo no se repiten abajo: el usuario vería el
  // mismo canal dos veces sin saber por qué.
  const catalogChannels = useMemo(
    () => new Set(catalog.map((s) => s.channel)),
    [catalog],
  );
  const worldOnly = useMemo(
    () => worldResults.filter((s) => !catalogChannels.has(s.channel)),
    [worldResults, catalogChannels],
  );

  return (
    <div className="space-y-6">
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <input
          type="search"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder={t('searchPlaceholder')}
          aria-label={t('searchLabel')}
          className="w-full rounded-md border bg-background py-2 pl-9 pr-9 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        {term && (
          <button
            type="button"
            onClick={() => setTerm('')}
            aria-label={t('clearSearch')}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* ---------------- Catálogo ---------------- */}
      <section>
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-muted-foreground">
          {t('catalogHeading')}
          <span className="font-normal">
            ({t('countLabel', { count: catalogMatches.length })})
          </span>
        </h2>

        {catalogLoading && <p className="text-sm text-muted-foreground">{t('loading')}</p>}

        {catalogError && (
          <div className="flex items-center gap-3 rounded-md border border-destructive/40 p-3 text-sm">
            <span className="text-destructive">{t('catalogError')}</span>
            <button
              type="button"
              onClick={() => setReloadToken((n) => n + 1)}
              className="rounded border px-2 py-1 text-xs hover:bg-accent"
            >
              {t('retry')}
            </button>
          </div>
        )}

        {!catalogLoading && !catalogError && catalogMatches.length === 0 && (
          <p className="text-sm text-muted-foreground">{t('noCatalogMatches')}</p>
        )}

        <div className="space-y-5">
          {cityGroups.map((group) => (
            <div key={group.cityId}>
              <h3 className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {group.cityId}
              </h3>
              <ul className="divide-y rounded-md border">
                {group.stations.map((station) => (
                  <li key={station.channel}>
                    <Link
                      href={stationHref(station.channel)}
                      className="flex items-center gap-3 px-3 py-2 text-sm hover:bg-accent"
                    >
                      <span className="font-mono">{station.channel}</span>
                      <span className="text-muted-foreground">
                        {station.network} · {station.station}
                      </span>
                      <span className="ml-auto flex items-center gap-2">
                        {station.is_primary && (
                          <span className="rounded bg-secondary px-1.5 py-0.5 text-xs text-secondary-foreground">
                            {t('primary')}
                          </span>
                        )}
                        {station.is_live && (
                          <span
                            className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400"
                            title={t('live')}
                          >
                            <Radio className="h-3 w-3" aria-hidden="true" />
                            {t('live')}
                          </span>
                        )}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      {/* ---------------- FDSN global ---------------- */}
      <section>
        <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-muted-foreground">
          {t('worldHeading')}
          {worldLoading && (
            <span className="flex items-center gap-1 text-xs font-normal">
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
              {t('searching')}
            </span>
          )}
        </h2>
        <p className="mb-3 text-xs text-muted-foreground">{t('worldHint')}</p>

        {worldError && <p className="text-sm text-destructive">{t('searchError')}</p>}

        {!worldLoading && !worldError && worldQueried && worldOnly.length === 0 && (
          <p className="text-sm text-muted-foreground">{t('noWorldMatches')}</p>
        )}

        {worldOnly.length > 0 && (
          <ul className="divide-y rounded-md border">
            {worldOnly.map((station) => (
              <li key={station.channel}>
                <Link
                  href={stationHref(station.channel)}
                  className="flex items-center gap-3 px-3 py-2 text-sm hover:bg-accent"
                >
                  <span className="font-mono">{station.channel}</span>
                  {station.site_name && (
                    <span className="truncate text-muted-foreground">{station.site_name}</span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

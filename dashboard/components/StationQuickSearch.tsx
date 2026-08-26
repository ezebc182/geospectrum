/**
 * Buscador rápido de estaciones en el header — el "a mano" de navegación,
 * mismo lugar y mismo patrón que el selector de área.
 *
 * Filtra SOLO el catálogo local (en memoria, instantáneo). No sale a FDSN a
 * propósito: una consulta cuesta ~1,2 s y esto es para saltar entre
 * estaciones conocidas sin cambiar de página; la búsqueda profunda vive en
 * /stations y el pie del menú lleva ahí.
 *
 * El input dentro del DropdownMenu necesita stopPropagation: Radix trata
 * cada tecla como typeahead y sin eso escribir acá salta entre items en vez
 * de llenar el campo (patrón de AreaSelector, ya mordió antes).
 */

'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Radio, Search } from 'lucide-react';
import useSWR from 'swr';

import { seismicAPI } from '@/lib/api';
import { HIGH_RISK_SEISMIC_CITIES } from '@/lib/seismic-cities';
import { filterCatalog, type CatalogStation } from '@/lib/station-search';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

const CITY_NAME_BY_ID = new Map(HIGH_RISK_SEISMIC_CITIES.map((c) => [c.id, c.name]));

/** Tope de filas del menú: para más resultados está la búsqueda completa. */
const MAX_RESULTS = 12;

function stationHref(channel: string): string {
  return `/stations/${encodeURIComponent(channel)}`;
}

function rowLabel(station: CatalogStation): string {
  const city = CITY_NAME_BY_ID.get(station.city_id) ?? station.city_id;
  return station.station ? `${city} · ${station.station}` : city;
}

export function StationQuickSearch() {
  const t = useTranslations('stations.quick');
  const [query, setQuery] = useState('');

  // Misma key de SWR que la página de estación: se comparte el cache, no se
  // duplica el fetch del catálogo.
  const { data: catalog } = useSWR('/spectrograms/station-catalog', () =>
    seismicAPI.getStationCatalog(),
  );

  const results = useMemo(
    () => filterCatalog(catalog ?? [], query).slice(0, MAX_RESULTS),
    [catalog, query],
  );

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        // El término no sobrevive al cierre: reabrir con el filtro viejo
        // muestra "no hay resultados" sin que se vea por qué.
        if (!open) setQuery('');
      }}
    >
      <DropdownMenuTrigger
        aria-label={t('triggerAria')}
        className="flex h-8 items-center gap-2 rounded-md border border-border px-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Search className="h-3.5 w-3.5" aria-hidden="true" />
        <span className="hidden sm:inline">{t('trigger')}</span>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="start"
        collisionPadding={12}
        className="max-h-[min(24rem,var(--radix-dropdown-menu-content-available-height))] w-72 overflow-y-auto"
      >
        <div className="p-2">
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            {/* Sin autoFocus, mismo criterio que AreaSelector: Radix enfoca el
                primer item al abrir y robarle el foco rompe las flechas. */}
            <input
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('placeholder')}
              aria-label={t('inputAria')}
              onKeyDown={(event) => {
                if (event.key !== 'Escape') event.stopPropagation();
              }}
              className="w-full rounded-md border border-input bg-transparent py-1.5 pl-8 pr-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
        </div>

        {results.length === 0 ? (
          <div className="px-3 py-4 text-center text-sm text-muted-foreground">
            {t('noResults')}
          </div>
        ) : (
          <div data-testid="quick-search-results">
            {results.map((station, i) => (
              // channel:índice y no channel pelado: el catálogo tiene un
              // duplicado legítimo (NZ.KHZ.10.HHZ en dos ciudades) y acá se
              // muestran las DOS caras a propósito — navegan al mismo lado.
              <DropdownMenuItem key={`${station.channel}:${i}`} asChild>
                <Link
                  href={stationHref(station.channel)}
                  className="flex w-full items-center justify-between gap-2"
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    {station.is_live && (
                      <Radio
                        className="h-3 w-3 shrink-0 text-teal-500"
                        aria-label={t('live')}
                      />
                    )}
                    <span className="truncate text-sm">{rowLabel(station)}</span>
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                    {station.channel}
                  </span>
                </Link>
              </DropdownMenuItem>
            ))}
          </div>
        )}

        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/stations" className="w-full text-sm text-muted-foreground">
            {t('fullSearch')}
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

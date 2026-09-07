/**
 * Mapa de hipocentros de /analytics (analytics-professional-panels, 5.6;
 * spec dashboard-ui "Mapa de hipocentros propio de Analytics", design
 * Decision 5, [R26]).
 *
 * Mapa PROPIO, deliberadamente NO reutiliza ninguno de los mapas de /live:
 * aquellos traen ciudades, placas, selector de capas y suscripción en vivo,
 * y acá hacen ruido. Éste es una sola capa base clara (CARTO Positron), un
 * `circleMarker` por evento y nada más.
 *
 * PRESENTACIONAL: recibe `data`/`error`/`isLoading` del `useSWR` de la
 * página, igual que `BValueChart` (Decision 8). No hace fetch, no se refresca
 * solo, no conoce el área — la revalidación al cambiar de área la dispara la
 * página.
 *
 * Leaflet entra por `import()` dinámico (SSR-safe) sobre
 * `L.map(container, { preferCanvas: true })`: el canvas es lo que sostiene
 * miles de vértices sin plugin de clustering (Decision 5, y el plugin UMD ya
 * costó un bug silencioso en este repo).
 *
 * [R26]: el estilo de cada marcador sale de `markerStyle` (lib pura, 4.5). Un
 * evento con `prof_km === null` NO pasa por `getDepthColor` — con `0` daría
 * el rojo de "< 70 km", una mentira — y su popup dice "sin profundidad".
 * Profundidad NEGATIVA (existe en prod, hipocentro sobre el nivel del mar) SÍ
 * es dato: la trata `markerStyle`, acá no se filtra nada.
 */

'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useEffect, useRef } from 'react';
import type { Map as LeafletMap } from 'leaflet';

import type { HypocentersResponse } from '@/lib/analytics';
import { areaViewBounds } from '@/lib/area-view-bounds';
import { markerStyle, popupArgs, truncationNotice } from '@/lib/hypocenter-markers';
import { BASE_LAYERS } from '@/lib/map-layers';
import type { AreaBbox, AreaGeometry } from '@/lib/types';
import { formatMagnitude } from '@/lib/utils';

interface HypocenterMapProps {
  data?: HypocentersResponse;
  error?: unknown;
  isLoading: boolean;
  /** Encuadre inicial del área activa; sin geometría se usa el bbox. */
  areaGeometry?: AreaGeometry | null;
  areaBbox?: AreaBbox | null;
  className?: string;
}

/** Encuadre por defecto cuando el área no está resuelta (mundo). */
const FALLBACK_CENTER: [number, number] = [-20, -65];
const FALLBACK_ZOOM = 3;

export function HypocenterMap({
  data,
  error,
  isLoading,
  areaGeometry = null,
  areaBbox = null,
  className,
}: HypocenterMapProps) {
  const t = useTranslations('analytics');
  const tCommon = useTranslations('common');
  const format = useFormatter();
  const containerRef = useRef<HTMLDivElement>(null);

  const eventos = data?.eventos;
  // Deps por VALOR: la página recrea la respuesta en cada revalidación, y el
  // encuadre es un array nuevo en cada render. Serializar es lo que evita el
  // remonte infinito (mismo patrón que los mapas existentes).
  const eventosKey = eventos ? eventos.map((ev) => ev.id).join('|') : '';
  const bounds = areaViewBounds(areaGeometry, areaBbox);
  const boundsKey = JSON.stringify(bounds);
  // Los popups se arman UNA vez al bindear: el locale tiene que estar en las
  // deps POR VALOR o el cambio de idioma los deja en el idioma viejo.
  const popupLabels = {
    magnitude: t('map.popup.magnitude'),
    depth: t('map.popup.depth'),
    time: t('map.popup.time'),
    place: t('map.popup.place'),
    noDepth: t('map.popup.noDepth'),
    utcSuffix: tCommon('utcSuffix'),
  };
  const labelsKey = JSON.stringify(popupLabels);

  useEffect(() => {
    if (!eventos) return;
    let map: LeafletMap | null = null;
    let cancelled = false;

    import('leaflet').then((mod) => {
      const L = mod.default ?? mod;
      if (cancelled || !containerRef.current) return;

      map = L.map(containerRef.current, { preferCanvas: true, worldCopyJump: true });
      const parsed = boundsKey ? (JSON.parse(boundsKey) as [[number, number], [number, number]] | null) : null;
      if (parsed) {
        map.fitBounds(parsed);
      } else {
        map.setView(FALLBACK_CENTER, FALLBACK_ZOOM);
      }

      const base = BASE_LAYERS.greyscale;
      L.tileLayer(base.url, { attribution: base.attribution, maxZoom: base.maxZoom }).addTo(map);

      // Un marcador por evento: ninguno se descarta en silencio.
      for (const ev of eventos) {
        const style = markerStyle(ev);
        const args = popupArgs(ev);
        const depth = args.depth === null ? popupLabels.noDepth : `${args.depth.toFixed(1)} km`;
        L.circleMarker([ev.lat, ev.lon], style)
          .bindPopup(
            `<div class="text-sm">
              <p class="font-bold text-lg">M${formatMagnitude(args.mag)}${args.magType ? ` <span class="text-xs font-normal">${args.magType}</span>` : ''}</p>
              <p class="text-xs">${popupLabels.place}: ${args.place ?? '—'}</p>
              <p class="text-xs">${popupLabels.depth}: ${depth}</p>
              <p class="text-xs">${popupLabels.time}: ${format.dateTime(new Date(args.timeUtc), 'medium')} ${popupLabels.utcSuffix}</p>
            </div>`,
          )
          .addTo(map);
      }
    });

    return () => {
      cancelled = true;
      map?.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventosKey, boundsKey, labelsKey]);

  const title = <h3 className="mb-4 text-lg font-semibold text-gray-900 dark:text-white">{t('map.title')}</h3>;

  if (!data) {
    if (error) {
      return (
        <div className={className}>
          {title}
          <div
            role="alert"
            className="rounded border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300"
          >
            {t('map.error')}
          </div>
        </div>
      );
    }
    return (
      <div className={className}>
        {title}
        <div role="status" aria-busy={isLoading} className="flex items-center gap-2 text-sm text-muted-foreground">
          <span
            aria-hidden
            className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-solid border-current border-r-transparent"
          />
          {t('map.loading')}
        </div>
      </div>
    );
  }

  const notice = truncationNotice(data.total, data.eventos.length);

  return (
    <div className={className} data-testid="hypocenter-map">
      {/* El CSS de Leaflet viaja con el componente que lo necesita; Next
          dedupe los <link> repetidos si conviven dos mapas. */}
      <link
        rel="stylesheet"
        href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
        integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY="
        crossOrigin=""
      />
      {title}

      <p className="mb-2 text-sm text-gray-700 dark:text-gray-300">{t('map.total', { total: data.total })}</p>

      {notice && (
        <p
          data-testid="hypocenter-truncated"
          className="mb-2 rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200"
        >
          {t('map.truncated', { shown: notice.shown, total: notice.total })}
        </p>
      )}

      <div ref={containerRef} className="h-[420px] w-full overflow-hidden rounded-md border border-border" />
    </div>
  );
}

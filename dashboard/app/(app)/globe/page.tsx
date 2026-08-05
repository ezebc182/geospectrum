/**
 * Vista de globo 3D.
 *
 * Es una vista más, no un reemplazo de los mapas Leaflet: se agregó en su
 * propia ruta a propósito, para poder evaluarla sin tocar el Dashboard ni
 * /live ni /explore.
 *
 * Pendiente: marcar eventos como favoritos.
 */

'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { useSearchParams } from 'next/navigation';
import useSWR from 'swr';
import { Globe2, RefreshCw } from 'lucide-react';

import { reportFetcher } from '@/lib/api';
import { getActiveArea } from '@/lib/areas';
import { areaViewBounds, globeFocusFromBounds, type GlobeFocus } from '@/lib/area-view-bounds';
import { globePointId } from '@/lib/globe-data';
import { EVENT_PARAM } from '@/lib/share-event';
import { useAreaRefresh } from '@/lib/use-area-refresh';
import { AreaRefreshIndicator } from '@/components/AreaRefreshIndicator';
import { GlobeEventPanel } from '@/components/GlobeEventPanel';
import type { SeismicEvent } from '@/lib/types';

// three.js accede a `window` al importarse: con SSR el build revienta. El
// esqueleto de carga evita que el layout salte cuando aparece el canvas.
const SeismicGlobe = dynamic(
  () => import('@/components/SeismicGlobe').then((m) => m.SeismicGlobe),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-[600px] items-center justify-center rounded-xl bg-muted/30">
        <span className="text-sm text-muted-foreground">Cargando globo…</span>
      </div>
    ),
  },
);

/**
 * useSearchParams obliga a un límite de Suspense en Next 15: sin él la página
 * entera queda fuera del prerender y el build falla. El fallback es el mismo
 * esqueleto que usa la carga del globo, así no salta el layout.
 */
export default function GlobePage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-[600px] items-center justify-center rounded-xl bg-muted/30">
          <span className="text-sm text-muted-foreground">Cargando globo…</span>
        </div>
      }
    >
      <GlobeView />
    </Suspense>
  );
}

function GlobeView() {
  const { data, error, isLoading, mutate } = useSWR('/report', reportFetcher, {
    refreshInterval: 60_000,
  });
  const { data: activeArea, mutate: mutateArea } = useSWR('/areas/active', getActiveArea);

  // Se guarda el id, no el evento: con el refresco cada 60s el objeto guardado
  // queda viejo, y el panel mostraría datos de hace un minuto mientras el globo
  // dibuja los nuevos. Con el id se re-resuelve siempre contra el último
  // reporte, y si el evento desaparece del reporte el panel se cierra solo.
  //
  // Arranca con el ?event= de la URL para que un link compartido abra el
  // evento en cuestión y no el globo girando en cualquier lado.
  const searchParams = useSearchParams();
  const [selectedEventId, setSelectedEventId] = useState<string | null>(
    () => searchParams.get(EVENT_PARAM),
  );

  // El área nueva gana el foco de cámara: cambiar de área es una acción
  // explícita y más reciente que cualquier evento que ya estuviera enfocado.
  const isRefreshingArea = useAreaRefresh(() => {
    setSelectedEventId(null);
    return Promise.all([mutate(), mutateArea()]);
  });

  const focusArea: GlobeFocus | null = useMemo(() => {
    const area = activeArea?.area;
    if (!area) return null;
    const bounds = areaViewBounds(area.geometry, area.bbox);
    return bounds ? globeFocusFromBounds(bounds) : null;
  }, [activeArea]);

  // La URL sigue al evento seleccionado para que copiarla del navegador o
  // compartirla lleven al mismo lugar.
  //
  // Se usa replaceState y no router.push: cada click en un punto agregaría una
  // entrada al historial y salir del globo pasaría a ser apretar "atrás" veinte
  // veces. Tampoco se usa router.replace porque dispara una navegación de Next
  // que remonta el canvas de WebGL.
  useEffect(() => {
    const url = new URL(window.location.href);

    if (selectedEventId) url.searchParams.set(EVENT_PARAM, selectedEventId);
    else url.searchParams.delete(EVENT_PARAM);

    window.history.replaceState(null, '', url.toString());
  }, [selectedEventId]);

  if (error) {
    return (
      <p className="p-6 text-sm text-destructive">
        No se pudo cargar el reporte sísmico.
      </p>
    );
  }

  const eventos = data?.eventos ?? [];

  const selectedEvent =
    eventos.find((evento) => globePointId(evento) === selectedEventId) ?? null;

  const handleSelectEvent = (evento: SeismicEvent | null) => {
    setSelectedEventId(evento ? globePointId(evento) : null);
  };

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Globe2 className="h-7 w-7 text-seismic-600" aria-hidden="true" />
          <div>
            <h1 className="text-2xl font-bold">Globo Sísmico</h1>
            <p className="text-sm text-muted-foreground">
              {eventos.length} eventos · límites de placas tectónicas
            </p>
          </div>
        </div>

        <button
          onClick={() => mutate()}
          className="flex items-center gap-2 rounded-lg border-2 border-gray-300 px-3 py-2 text-sm transition-colors hover:bg-muted/60 dark:border-gray-700"
        >
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          Actualizar
        </button>
      </div>

      <AreaRefreshIndicator isRefreshing={isRefreshingArea}>
        {isLoading ? (
          <div className="flex h-[600px] items-center justify-center rounded-xl bg-muted/30">
            <span className="text-sm text-muted-foreground">Cargando eventos…</span>
          </div>
        ) : (
          <SeismicGlobe
            eventos={eventos}
            height={600}
            onSelectEvent={handleSelectEvent}
            // Se deriva del evento resuelto y no del estado crudo: si el
            // refresco se lleva el evento del reporte, el foco se suelta y el
            // globo vuelve a rotar en vez de quedar trabado apuntando a nada.
            selectedEventId={selectedEvent ? selectedEventId : null}
            focusArea={focusArea}
          />
        )}
      </AreaRefreshIndicator>

      {/*
        La `key` remonta el panel al cambiar de evento: así el estado de
        "Copiado al portapapeles" no queda pegado del evento anterior.
      */}
      <GlobeEventPanel
        key={selectedEventId ?? 'none'}
        evento={selectedEvent}
        onClose={() => setSelectedEventId(null)}
      />
    </div>
  );
}

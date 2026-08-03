/**
 * Vista de globo 3D.
 *
 * Es una vista más, no un reemplazo de los mapas Leaflet: se agregó en su
 * propia ruta a propósito, para poder evaluarla sin tocar el Dashboard ni
 * /live ni /explore.
 *
 * Pendiente y deliberadamente fuera de esta primera versión: foco automático
 * al evento, panel de detalle y marcar eventos como favoritos.
 */

'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import useSWR from 'swr';
import { Globe2, RefreshCw } from 'lucide-react';

import { reportFetcher } from '@/lib/api';
import { globePointId } from '@/lib/globe-data';
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

export default function GlobePage() {
  const { data, error, isLoading, mutate } = useSWR('/report', reportFetcher, {
    refreshInterval: 60_000,
  });

  // Se guarda el id, no el evento: con el refresco cada 60s el objeto guardado
  // queda viejo, y el panel mostraría datos de hace un minuto mientras el globo
  // dibuja los nuevos. Con el id se re-resuelve siempre contra el último
  // reporte, y si el evento desaparece del reporte el panel se cierra solo.
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);

  const isRefreshingArea = useAreaRefresh(() => mutate());

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

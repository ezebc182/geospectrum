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

import dynamic from 'next/dynamic';
import useSWR from 'swr';
import { Globe2, RefreshCw } from 'lucide-react';

import { reportFetcher } from '@/lib/api';
import { useAreaRefresh } from '@/lib/use-area-refresh';
import { AreaRefreshIndicator } from '@/components/AreaRefreshIndicator';

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

  const isRefreshingArea = useAreaRefresh(() => mutate());

  if (error) {
    return (
      <p className="p-6 text-sm text-destructive">
        No se pudo cargar el reporte sísmico.
      </p>
    );
  }

  const eventos = data?.eventos ?? [];

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
          <SeismicGlobe eventos={eventos} height={600} />
        )}
      </AreaRefreshIndicator>
    </div>
  );
}

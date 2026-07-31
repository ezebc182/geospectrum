'use client';

import { useState } from 'react';
import useSWR from 'swr';
import { reportFetcher } from '@/lib/api';
import { getActiveArea } from '@/lib/areas';
import { useAreaRefresh } from '@/lib/use-area-refresh';
import { AlertBanner } from '@/components/AlertBanner';
import { SeismicMapWithCities } from '@/components/SeismicMapWithCities';
import { EventsTable } from '@/components/EventsTable';
import { Radio, RefreshCw } from 'lucide-react';
import { formatTimeAgo } from '@/lib/utils';

export default function LivePage() {
  const [refreshInterval, setRefreshInterval] = useState(30000); // 30s por defecto
  const { data, error, isLoading, mutate } = useSWR('/report', reportFetcher, {
    refreshInterval,
    revalidateOnFocus: true,
  });

  // El área activa se pide aparte de /report: el reporte trae el bbox
  // (region_monitorizada) pero NO la geometría, y el mapa necesita el polígono
  // real para no dibujar un rectángulo que miente sobre un área cóncava.
  // Devuelve null para los anónimos, y ahí el mapa cae al bbox.
  const { data: activeArea, mutate: mutateArea } = useSWR(
    '/areas/active',
    getActiveArea,
    { revalidateOnFocus: false }
  );

  // Hay que refrescar las DOS cosas: el reporte (que ahora viene recortado por
  // el backend) y el área en sí (para redibujar el polígono). Refrescar sólo el
  // reporte dejaría el mapa con el área vieja.
  useAreaRefresh(() => {
    mutate();
    mutateArea();
  });

  if (isLoading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="inline-block h-12 w-12 animate-spin rounded-full border-4 border-solid border-current border-r-transparent"></div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="rounded-lg border-2 border-red-200 bg-red-50 p-8 text-center">
        <p className="text-lg font-semibold text-red-900">Error al cargar datos</p>
      </div>
    );
  }

  const { alertas, eventos, timestamp_utc_generacion, region_monitorizada } = data;

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Radio className="h-8 w-8 text-red-600 animate-pulse" />
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white">
            Monitoreo en Vivo
          </h1>
        </div>

        <div className="flex items-center gap-4">
          <select
            value={refreshInterval}
            onChange={(e) => setRefreshInterval(Number(e.target.value))}
            className="rounded-lg border-2 border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-4 py-2 text-sm"
          >
            <option value={10000}>Actualizar cada 10s</option>
            <option value={30000}>Actualizar cada 30s</option>
            <option value={60000}>Actualizar cada 60s</option>
          </select>

          <button
            onClick={() => mutate()}
            className="flex items-center gap-2 rounded-lg bg-seismic-600 px-4 py-2 text-white hover:bg-seismic-700 transition-colors"
          >
            <RefreshCw className="h-4 w-4" />
            Actualizar ahora
          </button>
        </div>
      </div>

      <div className="rounded-lg border-2 border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-4">
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Última actualización: <span className="font-semibold">{formatTimeAgo(timestamp_utc_generacion)}</span>
        </p>
      </div>

      <AlertBanner alertas={alertas} />

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <h2 className="mb-4 text-xl font-semibold text-gray-900 dark:text-white">
            Mapa en Tiempo Real con Ciudades
          </h2>
          <SeismicMapWithCities
            eventos={eventos}
            region={region_monitorizada}
            areaGeometry={activeArea?.area.geometry ?? null}
            className="h-[600px]"
          />
        </div>

        <div>
          <h2 className="mb-4 text-xl font-semibold text-gray-900 dark:text-white">
            Eventos Activos ({eventos.length})
          </h2>
          <div className="max-h-[600px] overflow-y-auto">
            <EventsTable eventos={eventos.slice(0, 20)} />
          </div>
        </div>
      </div>
    </div>
  );
}

'use client';

import { useState, useEffect } from 'react';
import useSWR from 'swr';
import { reportFetcher } from '@/lib/api';
import { KPICard } from '@/components/KPICard';
import { AlertBanner } from '@/components/AlertBanner';
import { EventsTable } from '@/components/EventsTable';
import { SeismicMapWithCities } from '@/components/SeismicMapWithCities';
import { Activity, TrendingUp, Layers, Users, MapPin, Clock } from 'lucide-react';
import { formatTimeAgo } from '@/lib/utils';

export default function DashboardPage() {
  const { data, error, isLoading } = useSWR('/report', reportFetcher, {
    refreshInterval: 60000, // Auto-refresh cada 60s
    revalidateOnFocus: true,
  });

  if (isLoading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="text-center">
          <div className="inline-block h-12 w-12 animate-spin rounded-full border-4 border-solid border-current border-r-transparent"></div>
          <p className="mt-4 text-gray-600 dark:text-gray-400">Cargando datos sísmicos...</p>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="rounded-lg border-2 border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950 p-8 text-center">
        <p className="text-lg font-semibold text-red-900 dark:text-red-100">
          Error al cargar datos
        </p>
        <p className="mt-2 text-sm text-red-700 dark:text-red-300">
          {error?.message || 'No se pudo conectar con el servicio de monitoreo'}
        </p>
      </div>
    );
  }

  const { kpis, alertas, eventos, timestamp_utc_generacion, region_monitorizada, data_source_errors } = data;

  return (
    <div className="space-y-8">
      {/* Header con timestamp */}
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold text-gray-900 dark:text-white">
          Dashboard de Monitoreo Sísmico
        </h1>
        <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
          <Clock className="h-4 w-4" />
          <span>Actualizado {formatTimeAgo(timestamp_utc_generacion)}</span>
        </div>
      </div>

      {/* Data source errors */}
      {data_source_errors.length > 0 && (
        <div className="rounded-lg border-2 border-yellow-200 dark:border-yellow-800 bg-yellow-50 dark:bg-yellow-950 p-4">
          <p className="font-semibold text-yellow-900 dark:text-yellow-100">
            ⚠️ Advertencias de fuentes de datos:
          </p>
          <ul className="mt-2 list-disc list-inside text-sm text-yellow-800 dark:text-yellow-200">
            {data_source_errors.map((err, idx) => (
              <li key={idx}>{err}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Alertas */}
      <AlertBanner alertas={alertas} />

      {/* KPIs Grid */}
      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
        <KPICard
          title="Total Eventos"
          value={kpis.total_eventos}
          subtitle={`${kpis.tasa_eventos_por_hora.toFixed(1)} eventos/hora`}
          icon={<Activity />}
          color="blue"
        />
        <KPICard
          title="Magnitud Máxima"
          value={kpis.magnitud_max ? `M${kpis.magnitud_max.toFixed(1)}` : 'N/A'}
          subtitle={kpis.magnitud_promedio_ponderada_por_energia ? `Promedio: M${kpis.magnitud_promedio_ponderada_por_energia.toFixed(1)}` : undefined}
          icon={<TrendingUp />}
          color={kpis.magnitud_max && kpis.magnitud_max >= 5 ? 'red' : kpis.magnitud_max && kpis.magnitud_max >= 4 ? 'yellow' : 'green'}
        />
        <KPICard
          title="Profundidad Media M≥4"
          value={kpis.profundidad_media_M_ge_4 ? `${kpis.profundidad_media_M_ge_4.toFixed(0)} km` : 'N/A'}
          icon={<Layers />}
          color="gray"
        />
        <KPICard
          title="Eventos Sentidos"
          value={kpis.eventos_sentidos}
          subtitle={`${(kpis.porcentaje_eventos_sentidos * 100).toFixed(0)}% del total`}
          icon={<Users />}
          color={kpis.porcentaje_eventos_sentidos > 0.5 ? 'yellow' : 'green'}
        />
      </div>

      {/* Mapa y Tabla */}
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
        <div>
          <h2 className="mb-4 flex items-center gap-2 text-xl font-semibold text-gray-900 dark:text-white">
            <MapPin className="h-5 w-5" />
            Mapa de Epicentros y Ciudades
          </h2>
          <SeismicMapWithCities eventos={eventos} region={region_monitorizada} className="h-[500px]" />
        </div>

        <div>
          <h2 className="mb-4 text-xl font-semibold text-gray-900 dark:text-white">
            Eventos Recientes
          </h2>
          <EventsTable eventos={eventos} limit={10} />
        </div>
      </div>
    </div>
  );
}

'use client';

import useSWR from 'swr';
import { reportFetcher } from '@/lib/api';
import { MagnitudeTimeChart } from '@/components/MagnitudeTimeChart';
import { DepthDistributionChart } from '@/components/DepthDistributionChart';
import { EventsTable } from '@/components/EventsTable';
import { BarChart3 } from 'lucide-react';

export default function AnalyticsPage() {
  const { data, error, isLoading } = useSWR('/report', reportFetcher, {
    refreshInterval: 60000,
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

  const { eventos } = data;

  return (
    <div className="space-y-8">
      <div className="flex items-center gap-3">
        <BarChart3 className="h-8 w-8 text-seismic-600" />
        <h1 className="text-3xl font-bold text-gray-900 dark:text-white">
          Análisis Sísmico Avanzado
        </h1>
      </div>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
        <div className="rounded-lg border-2 border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-6">
          <MagnitudeTimeChart eventos={eventos} />
        </div>

        <div className="rounded-lg border-2 border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-6">
          <DepthDistributionChart eventos={eventos} />
        </div>
      </div>

      <div className="rounded-lg border-2 border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-6">
        <h2 className="mb-4 text-xl font-semibold text-gray-900 dark:text-white">
          Tabla Completa de Eventos
        </h2>
        <EventsTable eventos={eventos} />
      </div>
    </div>
  );
}

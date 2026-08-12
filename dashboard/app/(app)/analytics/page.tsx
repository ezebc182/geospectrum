'use client';

import useSWR from 'swr';
import { useTranslations } from 'next-intl';
import { reportFetcher } from '@/lib/api';
import { useAreaRefresh } from '@/lib/use-area-refresh';
import { MagnitudeTimeChart } from '@/components/MagnitudeTimeChart';
import { DepthDistributionChart } from '@/components/DepthDistributionChart';
import { EventsTable } from '@/components/EventsTable';
import { AreaRefreshIndicator } from '@/components/AreaRefreshIndicator';
import { BarChart3 } from 'lucide-react';

export default function AnalyticsPage() {
  const t = useTranslations('analytics');
  const { data, error, isLoading, mutate } = useSWR('/report', reportFetcher, {
    refreshInterval: 60000,
  });

  // Esta página no escuchaba el cambio de área: al elegir otra región los
  // gráficos y la tabla seguían con los datos viejos hasta el refresco de 60s.
  // A diferencia del dashboard y de /live, acá sólo hay que revalidar el
  // reporte — no se dibuja el polígono del área en ningún lado.
  const isRefreshingArea = useAreaRefresh(() => mutate());

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
        <p className="text-lg font-semibold text-red-900">{t('loadError')}</p>
      </div>
    );
  }

  const { eventos } = data;

  return (
    <AreaRefreshIndicator isRefreshing={isRefreshingArea} className="space-y-8">
      <div className="flex items-center gap-3">
        <BarChart3 className="h-8 w-8 text-seismic-600" />
        <h1 className="text-3xl font-bold text-gray-900 dark:text-white">
          {t('title')}
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
          {t('fullEventsTable')}
        </h2>
        <EventsTable eventos={eventos} filterable />
      </div>
    </AreaRefreshIndicator>
  );
}

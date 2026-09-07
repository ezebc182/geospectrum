'use client';

import { useMemo, useState } from 'react';
import useSWR from 'swr';
import { useTranslations } from 'next-intl';
import { reportFetcher } from '@/lib/api';
import { getBValue, getHypocenters } from '@/lib/analytics';
import { signalWindowFromHours } from '@/lib/rsam-trend';
import { useAreaRefresh } from '@/lib/use-area-refresh';
import { MagnitudeTimeChart } from '@/components/MagnitudeTimeChart';
import { DepthDistributionChart } from '@/components/DepthDistributionChart';
import { EventsTable } from '@/components/EventsTable';
import { AreaRefreshIndicator } from '@/components/AreaRefreshIndicator';
import {
  AnalyticsWindowSelector,
  type CatalogDays,
  type SignalWindowHours,
} from '@/components/analytics/AnalyticsWindowSelector';
import { StationPicker } from '@/components/analytics/StationPicker';
import { RsamTrendChart } from '@/components/analytics/RsamTrendChart';
import { TremorPanel } from '@/components/analytics/TremorPanel';
import { StationUptimeChart } from '@/components/analytics/StationUptimeChart';
import { BValueChart } from '@/components/analytics/BValueChart';
import { HypocenterMap } from '@/components/analytics/HypocenterMap';
import { DepthSectionChart } from '@/components/analytics/DepthSectionChart';
import { BarChart3 } from 'lucide-react';

const PANEL_CLASS =
  'rounded-lg border-2 border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-6';

export default function AnalyticsPage() {
  const t = useTranslations('analytics');

  // Dos escalas distintas y deliberadamente separadas (design, Decisión del
  // selector doble): el catálogo se mide en días (30-365) y la señal en horas
  // (tope de 24 h de FDSN). Un selector único obligaría a mentir en un extremo.
  const [catalogDays, setCatalogDays] = useState<CatalogDays>(30);
  const [signalWindowHours, setSignalWindowHours] = useState<SignalWindowHours>(24);
  const [channels, setChannels] = useState<string[]>([]);

  const { data, error, isLoading, mutate } = useSWR('/report', reportFetcher, {
    refreshInterval: 60000,
  });

  // Paneles de catálogo dependientes del ÁREA: la página es dueña de su SWR
  // porque es ella la que tiene que revalidarlos al cambiar de área (Decisión
  // 8). `BValueChart` y `HypocenterMap` son presentacionales y reciben
  // data/error/isLoading por props. Sin `refreshInterval`: ningún panel nuevo
  // se refresca solo (el único que lo hace es /report, intacto).
  const {
    data: bValue,
    error: bValueError,
    isLoading: bValueLoading,
    mutate: mutateBValue,
  } = useSWR(['/analytics/b-value', catalogDays], () => getBValue(catalogDays));

  const {
    data: hypocenters,
    error: hypocentersError,
    isLoading: hypocentersLoading,
    mutate: mutateHypocenters,
  } = useSWR(['/analytics/hypocenters', catalogDays], () => getHypocenters(catalogDays));

  // El uptime NO depende del área (es de la red de estaciones, no de la
  // región de eventos): se autocarga dentro del componente y no entra al
  // Promise.all de abajo.

  // La ventana absoluta se recalcula sólo al cambiar las horas: si se derivara
  // en cada render, `startMs`/`endMs` cambiarían de valor en cada pintada y los
  // efectos de RSAM/tremor —que dependen de esos números— re-pedirían sin fin.
  const signalWindow = useMemo(
    () => signalWindowFromHours(signalWindowHours, Date.now()),
    [signalWindowHours],
  );

  // El endpoint de tremor es POR canal: se caracteriza el primero elegido.
  const tremorChannel = channels[0] ?? null;

  // Al cambiar el área hay que revalidar TODO lo que el backend recorta por
  // ella: el reporte (comportamiento previo) más b-value e hipocentros. Se
  // devuelve el Promise.all —no las tres mutaciones sueltas— porque de esa
  // promesa depende el indicador: apagarlo con la primera que resuelva dejaría
  // los otros dos paneles cambiando sin ninguna señal.
  const isRefreshingArea = useAreaRefresh(() =>
    Promise.all([mutate(), mutateBValue(), mutateHypocenters()]),
  );

  if (isLoading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="inline-block h-12 w-12 animate-spin rounded-full border-4 border-solid border-current border-r-transparent"></div>
      </div>
    );
  }

  // El error de PÁGINA sigue siendo solo el del reporte: un panel nuevo que
  // falla muestra su propia tarjeta y no se lleva puesta la página entera.
  if (error || !data) {
    return (
      <div className="rounded-lg border-2 border-red-200 bg-red-50 p-8 text-center">
        <p className="text-lg font-semibold text-red-900">{t('loadError')}</p>
      </div>
    );
  }

  const { eventos, region_monitorizada } = data;

  return (
    <AreaRefreshIndicator isRefreshing={isRefreshingArea} className="space-y-8">
      <div className="flex items-center gap-3">
        <BarChart3 className="h-8 w-8 text-seismic-600" />
        <h1 className="text-3xl font-bold text-gray-900 dark:text-white">
          {t('title')}
        </h1>
      </div>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
        <div className={PANEL_CLASS}>
          <MagnitudeTimeChart eventos={eventos} />
        </div>

        <div className={PANEL_CLASS}>
          <DepthDistributionChart eventos={eventos} />
        </div>
      </div>

      <div className={PANEL_CLASS}>
        <h2 className="mb-4 text-xl font-semibold text-gray-900 dark:text-white">
          {t('fullEventsTable')}
        </h2>
        {/* Paginada: esta es la tabla COMPLETA del reporte y sin paginar
            renderizaba las 600+ filas de una, en un solo .map(). El dashboard
            usa `limit` en cambio, que es otra cosa: asomarse a los últimos 10
            con el mapa al lado. */}
        <EventsTable eventos={eventos} filterable paginated />
      </div>

      {/* --- Paneles profesionales (analytics-professional-panels) ---------- */}

      <div className={`${PANEL_CLASS} space-y-4`}>
        <AnalyticsWindowSelector
          catalogDays={catalogDays}
          signalWindowHours={signalWindowHours}
          onCatalogDaysChange={setCatalogDays}
          onSignalWindowChange={setSignalWindowHours}
        />
        <StationPicker selected={channels} onChange={setChannels} />
      </div>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
        <div className={PANEL_CLASS}>
          <BValueChart data={bValue} error={bValueError} isLoading={bValueLoading} />
        </div>

        <div className={PANEL_CLASS}>
          <StationUptimeChart days={catalogDays} />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
        <div className={PANEL_CLASS}>
          <HypocenterMap
            data={hypocenters}
            error={hypocentersError}
            isLoading={hypocentersLoading}
            areaBbox={region_monitorizada}
          />
        </div>

        {/* Los MISMOS eventos que el mapa: dónde al lado de a qué profundidad.
            No pide nada por su cuenta — se cuelga del useSWR de hipocentros. */}
        <div className={PANEL_CLASS}>
          <DepthSectionChart eventos={hypocenters?.eventos ?? []} />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
        <div className={PANEL_CLASS}>
          <RsamTrendChart channels={channels} window={signalWindow} />
        </div>

        <div className={PANEL_CLASS}>
          <TremorPanel channel={tremorChannel} window={signalWindow} />
        </div>
      </div>
    </AreaRefreshIndicator>
  );
}

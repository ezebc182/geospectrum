'use client';

import { useCallback, useState } from 'react';
import useSWR from 'swr';
import { reportFetcher } from '@/lib/api';
import { KPICard } from '@/components/KPICard';
import { AlertBanner } from '@/components/AlertBanner';
import { EventsTable } from '@/components/EventsTable';
import { AdvancedSeismicMap } from '@/components/AdvancedSeismicMap';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Activity, TrendingUp, Layers, Users, MapPin, Clock } from 'lucide-react';
import { formatTimeAgo } from '@/lib/utils';

export default function DashboardPage() {
  const { data, error, isLoading } = useSWR('/report', reportFetcher, {
    refreshInterval: 60000, // Auto-refresh cada 60s
    revalidateOnFocus: true,
  });

  // Sincronización unidireccional tabla→mapa (Decisión 3 de design.md). Estado local,
  // sin store global. Solo EventsTable.onRowClick escribe acá — el mapa NO tiene onEventClick
  // conectado a este setter, para que interacciones en el mapa nunca modifiquen la selección
  // de la tabla (spec Requirement "Sincronización unidireccional tabla → mapa", cláusula MUST NOT).
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [visibleCounts, setVisibleCounts] = useState<{ visible: number; total: number }>({
    visible: 0,
    total: 0,
  });
  const handleBoundsChange = useCallback((visible: number, total: number) => {
    setVisibleCounts({ visible, total });
  }, []);

  if (isLoading) {
    return (
      <div className="space-y-8">
        <div className="flex items-center justify-between">
          <Skeleton className="h-9 w-96" />
          <Skeleton className="h-5 w-48" />
        </div>
        <Skeleton className="h-20 w-full" />
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, idx) => (
            <Skeleton key={idx} className="h-32 w-full" />
          ))}
        </div>
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
          <Skeleton className="h-[500px] w-full" />
          <Skeleton className="h-[500px] w-full" />
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="rounded-lg border-2 border-severity-critical/30 bg-severity-critical/10 p-8 text-center">
        <p className="text-lg font-semibold text-severity-critical">
          Error al cargar datos
        </p>
        <p className="mt-2 text-sm text-severity-critical/80">
          {error?.message || 'No se pudo conectar con el servicio de monitoreo'}
        </p>
      </div>
    );
  }

  const { kpis, alertas, eventos, timestamp_utc_generacion, data_source_errors } = data;

  return (
    <div className="space-y-8">
      {/* Header con timestamp */}
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold text-foreground">
          Dashboard de Monitoreo Sísmico
        </h1>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Clock className="h-4 w-4" />
          <span className="font-data">Actualizado {formatTimeAgo(timestamp_utc_generacion)}</span>
        </div>
      </div>

      {/* Data source errors */}
      {data_source_errors.length > 0 && (
        <div className="rounded-lg border-2 border-severity-moderate/30 bg-severity-moderate/10 p-4">
          <p className="font-semibold text-severity-moderate">
            Advertencias de fuentes de datos:
          </p>
          <ul className="mt-2 list-disc list-inside text-sm text-severity-moderate/90">
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
      <div className="grid grid-cols-1 items-start gap-8 lg:grid-cols-2">
        <div>
          <div className="mb-4 flex items-center justify-between gap-2">
            <h2 className="flex items-center gap-2 text-xl font-semibold text-foreground">
              <MapPin className="h-5 w-5" />
              Mapa de Epicentros y Ciudades
            </h2>
            <Badge variant="secondary" className="font-data">
              {visibleCounts.visible} of {visibleCounts.total} events in map area
            </Badge>
          </div>
          <AdvancedSeismicMap
            eventos={eventos}
            className="h-[500px]"
            showCities
            showPlateBoundaries
            selectedEventId={selectedEventId}
            onBoundsChange={handleBoundsChange}
          />
        </div>

        <div>
          <h2 className="mb-4 text-xl font-semibold text-foreground">
            Eventos Recientes
          </h2>
          <EventsTable
            eventos={eventos}
            limit={10}
            onRowClick={setSelectedEventId}
            selectedEventId={selectedEventId}
            className="h-[500px]"
          />
        </div>
      </div>
    </div>
  );
}

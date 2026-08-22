'use client';

import { useCallback, useState } from 'react';
import { useFormatter, useNow, useTranslations } from 'next-intl';
import useSWR from 'swr';
import { reportFetcher } from '@/lib/api';
import type { SeismicEvent } from '@/lib/types';
import { getActiveArea } from '@/lib/areas';
import { useAreaRefresh } from '@/lib/use-area-refresh';
import { KPICard } from '@/components/KPICard';
import { EventsTable } from '@/components/EventsTable';
import { AdvancedSeismicMap } from '@/components/AdvancedSeismicMap';
import { AreaRefreshIndicator } from '@/components/AreaRefreshIndicator';
import { LiveIndicator } from '@/components/LiveIndicator';
import { useLiveEvents } from '@/hooks/use-live-events';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Activity,
  TrendingUp,
  Layers,
  Users,
  MapPin,
  Clock,
  PanelRightClose,
  PanelRightOpen,
} from 'lucide-react';

export default function DashboardPage() {
  const t = useTranslations('dashboard');
  const tCommon = useTranslations('common');
  // "Actualizado hace X min" sale de useFormatter().relativeTime en vez del
  // formatTimeAgo casero de lib/utils (que hardcodea el español): así el
  // relativo sigue al locale activo sin duplicar lógica de unidades.
  const format = useFormatter();
  // El "ahora" contra el que se mide el relativo es EXPLÍCITO, no el Date.now()
  // implícito de relativeTime(): sin él, servidor y cliente resuelven un
  // instante distinto y el markup no coincide al hidratar (de ahí el
  // ENVIRONMENT_FALLBACK que avisaba next-intl). Además `updateInterval` hace
  // que el cartel envejezca solo: con el Date.now() implícito el texto se
  // congelaba, porque sólo se re-evaluaba si SWR devolvía un timestamp nuevo
  // —y un dashboard que dice "hace 2 minutos" durante veinte miente.
  const now = useNow({ updateInterval: 30000 });
  // Estado del stream de eventos (PR-W4): compartido con el sidebar y el
  // globo, una sola conexión para toda la app.
  const { status: liveStatus, isLive } = useLiveEvents();

  // El selector de cadencia ("Refresh every 30s") y el botón de refrescar se
  // ELIMINARON: con el push por WebSocket no hay ciclo que elegir ni nada que
  // forzar — los eventos llegan solos en segundos. Eran controles que le
  // pedían al usuario administrar una latencia que ya no existe.
  //
  // El polling queda como fallback automático: 30 s mientras el WS esté caído,
  // 0 cuando esté vivo. Mismo criterio que GlobeBroadcastOverlay.
  // `mutate` sigue haciendo falta aunque el botón de refrescar ya no exista:
  // lo usa useAreaRefresh para recargar el reporte al cambiar de área. Eso es
  // refresco por cambio de contexto, no polling, y el push no lo cubre — el
  // backend recorta /report por el área activa.
  const { data, error, isLoading, mutate } = useSWR('/report', reportFetcher, {
    refreshInterval: isLive ? 0 : 30000,
    revalidateOnFocus: true,
  });

  // El área se pide aparte del reporte: /report trae el bbox pero NO la
  // geometría, y el encuadre la necesita — el bbox de un área que cruza el
  // antimeridiano dice -180..180 y encuadraría el planeta entero.
  const { data: activeArea, mutate: mutateArea } = useSWR(
    '/areas/active',
    getActiveArea,
    { revalidateOnFocus: false }
  );

  // El backend recorta el reporte por el área activa, así que al cambiarla hay
  // que volver a pedirlo: sin esto el dashboard seguía mostrando los KPIs y el
  // mapa de la región anterior hasta el refresco automático de 60s.
  //
  // Se devuelve el Promise.all —y no se llaman las dos mutaciones sueltas—
  // porque de esa promesa depende el indicador: apagarlo con la primera que
  // resuelva dejaría el mapa redibujándose sin ninguna señal.
  const isRefreshingArea = useAreaRefresh(() =>
    Promise.all([mutate(), mutateArea()])
  );

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

  // Los eventos que sobreviven al filtro de la tabla, para que el mapa muestre
  // lo mismo. Antes tabla y mapa recibían la lista cruda por separado: filtrar
  // por magnitud dejaba la tabla en 12 eventos y el mapa seguía con los 672
  // marcadores, y el contador "X de Y" contaba sobre el total sin filtrar.
  // Arranca en null (no en []) para distinguir "la tabla todavía no reportó"
  // de "el filtro no dejó pasar nada".
  const [filteredEventos, setFilteredEventos] = useState<SeismicEvent[] | null>(null);

  // Panel de eventos flotante, no un Sheet/Dialog: un overlay modal bloquea
  // la interacción con el mapa que queda detrás, y la idea es justamente
  // poder seguir manipulando el mapa con el panel abierto. Abierto por
  // defecto — la mayoría de las visitas quiere ver la tabla de entrada.
  const [isEventsPanelOpen, setIsEventsPanelOpen] = useState(true);

  // El contenedor que reserva espacio en el layout flex (el que el mapa
  // "siente" como ancho de su hermano) sólo cambia de w-full a w-0 DESPUÉS
  // de que el panel de adentro terminó de deslizarse hacia afuera — no en
  // el mismo instante en que se pidió cerrar. Sin este delay, el ancho
  // reservado colapsaba a 0 de golpe mientras el panel todavía estaba a
  // mitad de camino con transform, cortando su propia animación de salida
  // y haciendo que el mapa saltara de ancho antes de que el panel llegara
  // a desaparecer del todo.
  const [reserveEventsPanelWidth, setReserveEventsPanelWidth] = useState(true);
  const EVENTS_PANEL_TRANSITION_MS = 200;
  const toggleEventsPanel = () => {
    setIsEventsPanelOpen((open) => {
      const next = !open;
      if (next) {
        setReserveEventsPanelWidth(true);
      } else {
        setTimeout(() => setReserveEventsPanelWidth(false), EVENTS_PANEL_TRANSITION_MS);
      }
      return next;
    });
  };

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
          {t('loadError')}
        </p>
        <p className="mt-2 text-sm text-severity-critical/80">
          {error?.message || t('loadErrorFallback')}
        </p>
      </div>
    );
  }

  const {
    kpis,
    eventos,
    timestamp_utc_generacion,
    data_source_errors,
    region_monitorizada,
  } = data;

  // `?? eventos` y no `?? []`: mientras la tabla no haya reportado (o cuando
  // no es filtrable) el mapa muestra todo, que es el comportamiento de antes.
  const eventosParaElMapa = filteredEventos ?? eventos;

  return (
    <AreaRefreshIndicator isRefreshing={isRefreshingArea} className="space-y-8">
      {/* Header con timestamp y control de refresco */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-3xl font-bold text-foreground">
          {t('title')}
        </h1>
        <div className="flex items-center gap-4">
          {/* Con el stream vivo, el indicador reemplaza al "Actualizado hace
              X": el dato llega empujado y la antigüedad del último reporte
              deja de ser lo que le importa al usuario. Si el WS cae, vuelve el
              cartel de antigüedad, que ahí sí informa cuán viejo es lo que ve. */}
          {isLive ? (
            <LiveIndicator status={liveStatus} className="font-data" />
          ) : (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Clock className="h-4 w-4" />
              <span className="font-data">
                {t('updated', { ago: format.relativeTime(new Date(timestamp_utc_generacion), now) })}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Data source errors */}
      {data_source_errors.length > 0 && (
        <div className="rounded-lg border-2 border-severity-moderate/30 bg-severity-moderate/10 p-4">
          <p className="font-semibold text-severity-moderate">
            {t('sourceWarnings')}
          </p>
          <ul className="mt-2 list-disc list-inside text-sm text-severity-moderate/90">
            {data_source_errors.map((err, idx) => (
              <li key={idx}>{err}</li>
            ))}
          </ul>
        </div>
      )}

      {/* KPIs Grid — compactos: son contexto de un vistazo, el mapa es el
          protagonista del layout ahora. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KPICard
          title={t('kpis.totalEvents')}
          value={kpis.total_eventos}
          subtitle={t('kpis.perHour', { rate: kpis.tasa_eventos_por_hora.toFixed(1) })}
          icon={<Activity />}
          color="blue"
          compact
        />
        <KPICard
          title={t('kpis.maxMagnitude')}
          value={kpis.magnitud_max ? `M${kpis.magnitud_max.toFixed(1)}` : tCommon('notAvailable')}
          subtitle={kpis.magnitud_promedio_ponderada_por_energia ? t('kpis.average', { value: kpis.magnitud_promedio_ponderada_por_energia.toFixed(1) }) : undefined}
          icon={<TrendingUp />}
          color={kpis.magnitud_max && kpis.magnitud_max >= 5 ? 'red' : kpis.magnitud_max && kpis.magnitud_max >= 4 ? 'yellow' : 'green'}
          compact
        />
        <KPICard
          title={t('kpis.meanDepth')}
          value={kpis.profundidad_media_M_ge_4 ? `${kpis.profundidad_media_M_ge_4.toFixed(0)} km` : tCommon('notAvailable')}
          icon={<Layers />}
          color="gray"
          compact
        />
        <KPICard
          title={t('kpis.feltEvents')}
          value={kpis.eventos_sentidos}
          subtitle={t('kpis.percentOfTotal', { percent: (kpis.porcentaje_eventos_sentidos * 100).toFixed(0) })}
          icon={<Users />}
          color={kpis.porcentaje_eventos_sentidos > 0.5 ? 'yellow' : 'green'}
          compact
        />
      </div>

      {/* Mapa + panel de eventos, en el MISMO nivel de fila (flex), no
          superpuestos: el botón de Capas ya vive dentro del mapa (esquina
          superior derecha, componente AdvancedSeismicMap) y un panel
          flotante en esa misma esquina competía por el espacio y tapaba el
          botón. Acá el panel empuja el layout — angosto, con su propio
          scroll — en vez de flotar encima. */}
      <div className="flex min-h-0 flex-1 items-start gap-4">
        {/* data-tour-id: ancla del tour de onboarding (Decision 7 de
            email-invitations) — atributo semántico propio, NUNCA anclar por
            clases ni estructura del DOM, que son volátiles. */}
        <div className="min-w-0 flex-1" data-tour-id="map">
          <div className="mb-4 flex items-center justify-between gap-2">
            <h2 className="flex items-center gap-2 text-xl font-semibold text-foreground">
              <MapPin className="h-5 w-5" />
              {t('mapTitle')}
            </h2>
            {/* Antes decía "X of Y events in map area" EN INGLÉS hardcodeado
                aunque la app estuviera en español — el diccionario lo corrige
                en ambos idiomas. */}
            <Badge variant="secondary" className="font-data">
              {t('eventsInMapArea', { visible: visibleCounts.visible, total: visibleCounts.total })}
            </Badge>
          </div>
          <AdvancedSeismicMap
            eventos={eventosParaElMapa}
            region={region_monitorizada}
            areaGeometry={activeArea?.area.geometry ?? null}
            className="h-[calc(100vh-20rem)] min-h-[500px]"
            showCities
            showPlateBoundaries
            selectedEventId={selectedEventId}
            onBoundsChange={handleBoundsChange}
          />
        </div>

        {/* Toggle propio, separado del header del mapa: así nunca compite
            por espacio con el botón de Capas ni con el badge de conteo. */}
        <div className="flex shrink-0 flex-col items-center gap-2 pt-11">
          <button
            type="button"
            onClick={toggleEventsPanel}
            aria-pressed={isEventsPanelOpen}
            aria-label={isEventsPanelOpen ? t('hideEventsPanel') : t('showEventsPanel')}
            className="flex h-9 w-9 items-center justify-center rounded-md border-2 border-gray-300 hover:bg-muted/60 dark:border-gray-700"
          >
            {isEventsPanelOpen ? (
              <PanelRightClose className="h-4 w-4" />
            ) : (
              <PanelRightOpen className="h-4 w-4" />
            )}
          </button>
        </div>

        {/* El ancho REAL que ocupa en el layout flex es fijo (w-full
            max-w-sm) mientras está montado — nunca anima. Lo que se anima es
            `transform`+`opacity` en el hijo de adentro: eso no dispara
            reflow del layout, así que el <div> del mapa (flex-1, hermano)
            no ve su ancho cambiar gradualmente durante la transición.
            Antes se animaba `width` acá mismo: cada frame de esos 200ms
            reducía el flex-1 del mapa un poco más, y Leaflet — que no tiene
            invalidateSize() enganchado a un resize continuo — dibujaba los
            tiles desalineados en cada paso, viéndose como parpadeo. */}
        <div className={`shrink-0 overflow-hidden ${reserveEventsPanelWidth ? 'w-full max-w-sm' : 'w-0'}`}>
          <div
            className={`flex h-full w-full max-w-sm flex-col overflow-hidden rounded-xl border-2 border-gray-300 transition-[transform,opacity] duration-200 ease-out dark:border-gray-700 ${
              isEventsPanelOpen ? 'translate-x-0 opacity-100' : 'translate-x-full opacity-0'
            }`}
          >
            <div className="flex items-center justify-between border-b border-border bg-background px-4 py-3">
              <h2 className="whitespace-nowrap text-base font-semibold text-foreground">
                {t('recentEvents')}
              </h2>
            </div>
            <div className="h-[calc(100vh-20rem)] min-h-[500px] overflow-y-auto bg-background p-2">
              <EventsTable
                eventos={eventos}
                limit={20}
                filterable
                onRowClick={setSelectedEventId}
                selectedEventId={selectedEventId}
                onFilteredEventsChange={setFilteredEventos}
              />
            </div>
          </div>
        </div>
      </div>
    </AreaRefreshIndicator>
  );
}

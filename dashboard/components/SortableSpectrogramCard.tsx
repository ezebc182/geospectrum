'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import Link from 'next/link';
import { GripVertical, Maximize2, Radio, X } from 'lucide-react';
import type { SeismicCity } from '@/lib/seismic-cities';
import { getRiskColor } from '@/lib/seismic-cities';
import { SpectrogramViewReal } from '@/components/SpectrogramViewReal';
import { LiveSpectrogramCanvas } from '@/components/LiveSpectrogramCanvas';
import { latencySeconds, type StationMetrics } from '@/lib/station-metrics';

interface SortableSpectrogramCardProps {
  city: SeismicCity;
  /** Canal SEED si esta ciudad tiene streaming en vivo disponible; si es
   * undefined, la tarjeta muestra solo el modo estático (24h), sin toggle. */
  liveChannel?: string;
  /** Métricas de dominio del canal en vivo (PR-W3); undefined mientras el
   * polling no las trajo o si el canal no publica. */
  metrics?: StationMetrics;
  onRemove: (cityId: string) => void;
}

/** Los null del contrato de métricas se muestran como guion, nunca como 0. */
const DASH = '—';

export function SortableSpectrogramCard({
  city,
  liveChannel,
  metrics,
  onRemove,
}: SortableSpectrogramCardProps) {
  const t = useTranslations('charts.spectrogram');
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: city.id,
  });
  // `null` = el usuario todavía no eligió; manda el default (vivo si hay
  // canal). El modo NO se puede resolver sólo en el useState inicial: la
  // página pide los canales en un useEffect asíncrono, así que el primer
  // render SIEMPRE ve liveChannel=undefined y la tarjeta quedaba clavada en
  // "24h" aunque el canal llegara un instante después — pidiendo un PNG a
  // FDSN en ciudades que ya tenían columnas frescas en TimescaleDB.
  const [chosenMode, setChosenMode] = useState<'live' | 'static' | null>(null);
  const mode = chosenMode ?? (liveChannel ? 'live' : 'static');

  // La fila solo tiene sentido sobre señal viva: en modo 24h las métricas
  // serían de un instante que no es el que se está mirando.
  const showMetrics = mode === 'live' && Boolean(liveChannel) && metrics !== undefined;
  // Se recalcula en cada render; el polling de 15 s dispara los que importan.
  const latency = metrics ? latencySeconds(metrics.endtime, Date.now()) : null;

  // Ancho real de la tarjeta. El fallback de 360 es el valor que estaba
  // hardcodeado: cubre el primer render (antes de que mida) y jsdom, donde
  // ResizeObserver no reporta layout.
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [cardWidth, setCardWidth] = useState(360);

  useEffect(() => {
    const el = wrapperRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(([entry]) => {
      const w = Math.round(entry.contentRect.width);
      // Redibujar el canvas descarta el historial pintado, así que no se
      // reacciona a cada píxel de un resize en curso: sólo a cambios reales
      // de layout (cambiar de 3 a 4 columnas, girar la pantalla).
      if (w > 0) setCardWidth((prev) => (Math.abs(prev - w) > 8 ? w : prev));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 50 : undefined,
  };

  return (
    <div
      // Dos refs sobre el mismo nodo: dnd-kit necesita el suyo para arrastrar
      // y el ResizeObserver necesita el elemento para medirlo.
      ref={(node) => {
        setNodeRef(node);
        wrapperRef.current = node;
      }}
      style={style}
      className="relative group"
    >
      {liveChannel && mode === 'live' ? (
        /* `width` medido y no 360 fijo: la grilla es fluida (2/3/4/6 columnas
           sobre el ancho de la ventana) y un canvas de ancho fijo dejaba ver
           el fondo de la tarjeta a la derecha. En un canvas el width ADEMÁS
           es cuántas columnas de espectrograma entran, así que no se puede
           estirar con CSS: hay que crearlo del tamaño real. */
        <LiveSpectrogramCanvas
          channel={liveChannel}
          label={city.name}
          height={120}
          width={cardWidth}
        />
      ) : (
        <SpectrogramViewReal city={city} height={120} showLabel={true} useRealData={true} />
      )}

      {/* Selector Vivo/24h: SIEMPRE visible y con las dos opciones a la vista.
          Antes era un botón único con `opacity-0 group-hover:opacity-100` —
          invisible sin mouse encima, así que ni se sabía que la vista en vivo
          existía. Un segmentado muestra en qué modo se está y adónde se puede
          ir sin tener que descubrirlo por hover. */}
      {liveChannel && (
        <div
          role="group"
          aria-label={t('viewLive')}
          className="absolute top-2 left-1/2 z-30 flex -translate-x-1/2 overflow-hidden rounded-full bg-black/75 text-[10px] font-semibold ring-1 ring-white/20"
        >
          <button
            type="button"
            onClick={() => setChosenMode('live')}
            aria-pressed={mode === 'live'}
            title={t('viewLive')}
            className={`flex items-center gap-1 px-2 py-0.5 transition-colors ${
              mode === 'live' ? 'bg-teal-600 text-white' : 'text-white/70 hover:text-white'
            }`}
          >
            <Radio className={`h-3 w-3 ${mode === 'live' ? 'animate-pulse' : ''}`} />
            {t('liveBadge')}
          </button>
          <button
            type="button"
            onClick={() => setChosenMode('static')}
            aria-pressed={mode === 'static'}
            title={t('viewHistory')}
            className={`px-2 py-0.5 transition-colors ${
              mode === 'static' ? 'bg-teal-600 text-white' : 'text-white/70 hover:text-white'
            }`}
          >
            24h
          </button>
        </div>
      )}

      {/* Ampliar: lleva al detalle de estación, que ya tiene el espectrograma
          grande con ejes y el helicorder. En modo 24h el link vive dentro de
          SpectrogramViewReal, pero en vivo no había ninguna puerta de salida
          — la tarjeta de 120px de alto era todo lo que se podía ver. */}
      {liveChannel && mode === 'live' && (
        <Link
          href={`/stations/${encodeURIComponent(liveChannel)}`}
          title={t('expand')}
          aria-label={t('expand')}
          className="absolute bottom-2 right-2 z-30 rounded bg-black/70 p-1 text-white opacity-0 transition-opacity group-hover:opacity-100 hover:bg-black/90 focus-visible:opacity-100"
        >
          <Maximize2 className="h-3 w-3" />
        </Link>
      )}

      {/* Handle de arrastre (visible al hover) */}
      <button
        {...attributes}
        {...listeners}
        className="absolute top-2 left-2 p-1 bg-black/60 text-white rounded opacity-0 group-hover:opacity-100 transition-opacity cursor-grab active:cursor-grabbing z-30"
        title={t('dragToReorder')}
      >
        <GripVertical className="h-3 w-3" />
      </button>

      {/* Botón eliminar (visible al hover) */}
      <button
        onClick={() => onRemove(city.id)}
        className="absolute top-2 right-2 p-1 bg-red-500 text-white rounded opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-600 z-30"
        title={t('removeCity')}
      >
        <X className="h-3 w-3" />
      </button>

      {showMetrics && metrics ? (
        /* Fila de métricas de dominio (PR-W3): con señal viva el estado de la
           SEÑAL le gana a la clasificación estática de la zona, así que
           reemplaza al badge de riesgo en vez de convivir con él. */
        <div
          data-testid="card-metrics-row"
          className="absolute bottom-2 left-2 right-2 z-10 flex items-center justify-between gap-1 rounded bg-black/60 px-1.5 py-0.5 font-data text-[9px] text-gray-200"
          title={t('metrics.tooltip')}
        >
          <span>
            {t('metrics.rsam')} {metrics.rsam === null ? DASH : Math.round(metrics.rsam)}
          </span>
          <span>
            {t('metrics.freqDominant')} {metrics.freq_hz === null ? DASH : `${metrics.freq_hz}Hz`}
          </span>
          <span>
            {t('metrics.fi')} {metrics.fi === null ? DASH : metrics.fi.toFixed(2)}
          </span>
          <span>
            {t('metrics.peakDb')} {metrics.peak_db === null ? DASH : metrics.peak_db.toFixed(1)}
          </span>
          <span>
            {t('metrics.eventsHour')} {metrics.events_hour ?? DASH}
          </span>
          <span>
            {t('metrics.latency')} {latency === null ? DASH : `${latency}s`}
          </span>
        </div>
      ) : (
        /* Nivel de riesgo sísmico de la ZONA (clasificación estática del
            catálogo, no estado de la señal): punto de color + texto apagado,
            para que no se lea como una alarma en vivo. Fallback cuando no hay
            métricas, para que un canal caído no deje la tarjeta muda. */
        <div
          className="absolute bottom-2 right-2 flex items-center gap-1 px-1.5 py-0.5 rounded bg-black/50 text-[9px] font-semibold text-gray-300 z-10"
          title={t('riskTooltip')}
        >
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: getRiskColor(city.riskLevel) }}
          />
          {t(`riskLabel.${city.riskLevel}`)}
        </div>
      )}
    </div>
  );
}

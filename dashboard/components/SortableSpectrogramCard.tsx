'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Radio, X } from 'lucide-react';
import type { SeismicCity } from '@/lib/seismic-cities';
import { getRiskColor } from '@/lib/seismic-cities';
import { SpectrogramViewReal } from '@/components/SpectrogramViewReal';
import { LiveSpectrogramCanvas } from '@/components/LiveSpectrogramCanvas';

interface SortableSpectrogramCardProps {
  city: SeismicCity;
  /** Canal SEED si esta ciudad tiene streaming en vivo disponible; si es
   * undefined, la tarjeta muestra solo el modo estático (24h), sin toggle. */
  liveChannel?: string;
  onRemove: (cityId: string) => void;
}

export function SortableSpectrogramCard({ city, liveChannel, onRemove }: SortableSpectrogramCardProps) {
  const t = useTranslations('charts.spectrogram');
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: city.id,
  });
  const [mode, setMode] = useState<'live' | 'static'>(liveChannel ? 'live' : 'static');

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 50 : undefined,
  };

  return (
    <div ref={setNodeRef} style={style} className="relative group">
      {liveChannel && mode === 'live' ? (
        <LiveSpectrogramCanvas channel={liveChannel} label={city.name} height={120} width={360} />
      ) : (
        <SpectrogramViewReal city={city} height={120} showLabel={true} useRealData={true} />
      )}

      {/* Toggle Vivo/24h (solo si la ciudad tiene streaming disponible) */}
      {liveChannel && (
        <button
          onClick={() => setMode((m) => (m === 'live' ? 'static' : 'live'))}
          className="absolute top-2 left-1/2 -translate-x-1/2 flex items-center gap-1 px-2 py-0.5 bg-black/70 text-white rounded-full text-[10px] font-semibold z-30 opacity-0 group-hover:opacity-100 transition-opacity"
          title={mode === 'live' ? t('viewHistory') : t('viewLive')}
        >
          <Radio className={`h-3 w-3 ${mode === 'live' ? 'text-severity-low' : 'text-muted-foreground'}`} />
          {mode === 'live' ? t('liveBadge') : '24h'}
        </button>
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

      {/* Indicador de nivel de riesgo */}
      <div
        className="absolute bottom-2 right-2 px-2 py-1 rounded text-[10px] font-bold text-white z-10"
        style={{ backgroundColor: getRiskColor(city.riskLevel) }}
      >
        {city.riskLevel.toUpperCase()}
      </div>
    </div>
  );
}

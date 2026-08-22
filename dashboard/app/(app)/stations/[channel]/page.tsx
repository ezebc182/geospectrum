/**
 * Detalle de estación — PR A de cuatro (ver
 * docs/superpowers/specs/2026-08-20-station-detail-swarm-design.md).
 *
 * Las cuatro pestañas de SWARM se muestran desde el principio, pero sólo
 * Helicorder está viva: las otras las habilitan los PRs B-D. Se dejan
 * visibles y deshabilitadas a propósito — así la estructura de la página no
 * cambia cuando se habiliten, y quien entra ve qué va a haber acá.
 */

'use client';

import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { HelicorderCanvas } from '@/components/HelicorderCanvas';

/** Franjas por fila: los tres valores de SWARM. */
const TIME_CHUNKS = [15, 30, 60] as const;

const TABS = [
  { id: 'helicorder', enabled: true },
  { id: 'spectrogram', enabled: false },
  { id: 'wave', enabled: false },
  { id: 'rsam', enabled: false },
] as const;

export default function StationPage() {
  const params = useParams<{ channel: string }>();
  // El SCNL viaja URL-encoded en el path (lleva puntos y puede llevar espacios).
  const channel = decodeURIComponent(params.channel);
  const t = useTranslations('station');
  const [timeChunk, setTimeChunk] = useState<number>(30);

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center gap-3">
        <h1 className="text-xl font-bold text-white">{t('title')}</h1>
        <span className="font-mono text-sm text-gray-400">{channel}</span>
      </div>

      <div role="tablist" className="mb-4 flex gap-2">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            type="button"
            aria-selected={tab.enabled}
            disabled={!tab.enabled}
            className={`rounded px-3 py-1 text-sm ${
              tab.enabled ? 'bg-teal-700 text-white' : 'bg-gray-800 text-gray-500'
            }`}
          >
            {t(`tabs.${tab.id}`)}
            {!tab.enabled && ` (${t('comingSoon')})`}
          </button>
        ))}
      </div>

      <div className="mb-3 flex items-center gap-2 text-sm text-gray-300">
        <span>{t('timeChunk')}</span>
        {TIME_CHUNKS.map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setTimeChunk(m)}
            aria-pressed={m === timeChunk}
            className={`rounded px-2 py-0.5 ${
              m === timeChunk ? 'bg-teal-700 text-white' : 'bg-gray-800'
            }`}
          >
            {m}m
          </button>
        ))}
      </div>

      <HelicorderCanvas channel={channel} timeChunkMinutes={timeChunk} width={960} height={640} />
    </div>
  );
}

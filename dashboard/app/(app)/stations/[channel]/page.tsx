/**
 * Detalle de estación (ver
 * docs/superpowers/specs/2026-08-20-station-detail-swarm-design.md).
 *
 * Las cuatro pestañas de SWARM se muestran desde el principio; Helicorder
 * (PR A) y Espectrograma (PR B) están vivas, y las otras las habilitan los PRs
 * C-D. Se dejan visibles y deshabilitadas a propósito — así la estructura de
 * la página no cambia cuando se habiliten, y quien entra ve qué va a haber acá.
 */

'use client';

import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { HelicorderCanvas } from '@/components/HelicorderCanvas';
import { SpectrogramLarge } from '@/components/SpectrogramLarge';
import {
  HELICORDER_DEFAULTS,
  TIME_CHUNK_OPTIONS,
  clampBarMult,
  clampClipMult,
  clampFilter,
  type HelicorderFilter,
  loadHelicorderSettings,
  saveHelicorderSettings,
} from '@/lib/helicorder-settings';

const TABS = [
  { id: 'helicorder', enabled: true },
  { id: 'spectrogram', enabled: true },
  { id: 'wave', enabled: false },
  { id: 'rsam', enabled: false },
] as const;

type TabId = (typeof TABS)[number]['id'];

export default function StationPage() {
  const params = useParams<{ channel: string }>();
  // El SCNL viaja URL-encoded en el path (lleva puntos y puede llevar espacios).
  const channel = decodeURIComponent(params.channel);
  const t = useTranslations('station');
  const [activeTab, setActiveTab] = useState<TabId>('helicorder');
  // Arranca en defaults y los settings guardados entran por efecto: leer
  // localStorage durante el render daría un HTML distinto en servidor y
  // cliente (hydration mismatch).
  const [timeChunk, setTimeChunk] = useState<number>(HELICORDER_DEFAULTS.timeChunkMinutes);
  const [clipMult, setClipMult] = useState<number>(HELICORDER_DEFAULTS.clipMult);
  const [barMult, setBarMult] = useState<number>(HELICORDER_DEFAULTS.barMult);
  const [filter, setFilter] = useState<HelicorderFilter>(HELICORDER_DEFAULTS.filter);

  useEffect(() => {
    const s = loadHelicorderSettings(channel);
    setTimeChunk(s.timeChunkMinutes);
    setClipMult(s.clipMult);
    setBarMult(s.barMult);
    setFilter(s.filter);
  }, [channel]);

  const persist = (
    next: Partial<{
      timeChunk: number;
      clipMult: number;
      barMult: number;
      filter: HelicorderFilter;
    }>,
  ) => {
    const merged = { timeChunk, clipMult, barMult, filter, ...next };
    setTimeChunk(merged.timeChunk);
    setClipMult(merged.clipMult);
    setBarMult(merged.barMult);
    setFilter(merged.filter);
    saveHelicorderSettings(channel, {
      timeChunkMinutes: merged.timeChunk,
      clipMult: merged.clipMult,
      barMult: merged.barMult,
      filter: merged.filter,
    });
  };

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center gap-3">
        {/* Tokens del tema y no grises fijos: con `text-white`/`text-gray-*`
            esta pantalla era ilegible en tema claro (blanco sobre blanco). */}
        <h1 className="text-xl font-bold text-foreground">{t('title')}</h1>
        <span className="font-mono text-sm text-muted-foreground">{channel}</span>
      </div>

      <div role="tablist" className="mb-4 flex gap-2">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            type="button"
            // aria-selected marca la pestaña ACTIVA, no las habilitadas: con
            // dos vivas, decir que ambas están seleccionadas es mentirle al
            // lector de pantalla.
            aria-selected={tab.id === activeTab}
            disabled={!tab.enabled}
            onClick={() => tab.enabled && setActiveTab(tab.id)}
            className={`rounded px-3 py-1 text-sm ${
              !tab.enabled
                ? 'bg-muted text-muted-foreground opacity-60'
                : tab.id === activeTab
                  ? 'bg-teal-700 text-white'
                  : 'bg-muted text-foreground hover:bg-muted/80'
            }`}
          >
            {t(`tabs.${tab.id}`)}
            {!tab.enabled && ` (${t('comingSoon')})`}
          </button>
        ))}
      </div>

      {activeTab === 'spectrogram' && <SpectrogramLarge channel={channel} />}

      {activeTab === 'helicorder' && (
        <>
          <div className="mb-3 flex items-center gap-2 text-sm text-foreground">
            <span>{t('timeChunk')}</span>
            {TIME_CHUNK_OPTIONS.map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => persist({ timeChunk: m })}
                aria-pressed={m === timeChunk}
                className={`rounded px-2 py-0.5 ${
                  m === timeChunk
                    ? 'bg-teal-700 text-white'
                    : 'bg-muted text-foreground hover:bg-muted/80'
                }`}
              >
                {m}m
              </button>
            ))}
          </div>

          {/*
            Escala manual (spec §61, filosofía SWARM): el auto-clip por
            percentil pinta de rojo justamente el evento que uno quiere mirar,
            porque un sismo real ES la cola superior de la distribución del
            día. Ninguna heurística reemplaza al operador moviendo la escala.
          */}
          <fieldset className="mb-4 rounded border border-border p-3">
            <legend className="px-1 text-sm text-foreground">{t('settings')}</legend>
            <div className="flex flex-wrap items-center gap-6">
              <label className="flex items-center gap-2 text-sm text-foreground">
                <span title={t('clipMultHint')}>{t('clipMult')}</span>
                <input
                  type="range"
                  aria-label={t('clipMult')}
                  min={HELICORDER_DEFAULTS.clipMultMin}
                  max={HELICORDER_DEFAULTS.clipMultMax}
                  step={0.1}
                  value={clipMult}
                  onChange={(e) => persist({ clipMult: clampClipMult(Number(e.target.value)) })}
                />
                <span className="w-12 font-mono text-xs text-muted-foreground">
                  {clipMult.toFixed(1)}×
                </span>
              </label>

              <label className="flex items-center gap-2 text-sm text-foreground">
                <span title={t('barMultHint')}>{t('barMult')}</span>
                <input
                  type="range"
                  aria-label={t('barMult')}
                  min={HELICORDER_DEFAULTS.barMultMin}
                  max={HELICORDER_DEFAULTS.barMultMax}
                  step={0.25}
                  value={barMult}
                  onChange={(e) => persist({ barMult: clampBarMult(Number(e.target.value)) })}
                />
                <span className="w-12 font-mono text-xs text-muted-foreground">
                  {barMult.toFixed(2)}×
                </span>
              </label>

              {/* A diferencia de los sliders, esto vuelve a pedir la onda al
                  backend: el filtro cambia el dato, no cómo se dibuja. */}
              <label className="flex items-center gap-2 text-sm text-foreground">
                <span title={t('filterHint')}>{t('filter')}</span>
                <input
                  type="checkbox"
                  aria-label={t('filter')}
                  checked={filter === 'bp'}
                  onChange={(e) =>
                    persist({ filter: clampFilter(e.target.checked ? 'bp' : 'none') })
                  }
                />
              </label>

              <button
                type="button"
                onClick={() =>
                  persist({
                    clipMult: HELICORDER_DEFAULTS.clipMult,
                    barMult: HELICORDER_DEFAULTS.barMult,
                  })
                }
                className="rounded bg-muted px-2 py-0.5 text-sm text-foreground hover:bg-muted/80"
              >
                {t('reset')}
              </button>
            </div>
          </fieldset>

          <HelicorderCanvas
            channel={channel}
            timeChunkMinutes={timeChunk}
            width={960}
            height={640}
            clipMult={clipMult}
            barMult={barMult}
            filter={filter}
          />
        </>
      )}
    </div>
  );
}

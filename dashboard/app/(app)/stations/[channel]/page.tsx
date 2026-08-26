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

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import useSWR from 'swr';
import { HelicorderCanvas } from '@/components/HelicorderCanvas';
import { PickingOverlay, PickingPanel } from '@/components/PickingOverlay';
import { RsamChart } from '@/components/RsamChart';
import { SpectrogramLarge } from '@/components/SpectrogramLarge';
import { SpectrumView } from '@/components/SpectrumView';
import { WaveView } from '@/components/WaveView';
import { useSignalPicks } from '@/hooks/use-signal-picks';
import { useWaveWindow } from '@/hooks/use-wave-window';
import { seismicAPI } from '@/lib/api';
import type { PickPhase } from '@/lib/signal-picks';
import {
  PROGRESS_DEFAULTS,
  loadProgress,
  recordInteraction,
  saveProgress,
  setRevealAll,
  visibleTools,
  type UserProgress,
} from '@/lib/progressive-disclosure';
import type { TimeWindow } from '@/lib/waveform-scale';
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
import { resolveStationLocation } from '@/lib/station-location';
import { StationMiniMap } from '@/components/StationMiniMap';
import { useActiveArea } from '@/lib/use-active-area';

const TABS = [
  { id: 'helicorder', enabled: true },
  { id: 'spectrogram', enabled: true },
  // `wave` se habilita en la Fase 2 porque ya tiene vista: una pestaña
  // habilitada apuntando a una pantalla vacía es peor que decir "próximamente".
  { id: 'wave', enabled: true },
  { id: 'rsam', enabled: true },
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

  /**
   * Ventana seleccionada en el helicorder. Es la semilla del wave view: el hook
   * la clampea y pide el dato.
   */
  const [selectedWindow, setSelectedWindow] = useState<TimeWindow | null>(null);

  /**
   * Progreso del usuario, por efecto y NO por `useState(loadProgress())`: leer
   * localStorage durante el render da un HTML distinto en servidor y cliente
   * (hydration mismatch). Es el mismo motivo por el que los settings del
   * helicorder también entran por efecto, unas líneas más arriba.
   */
  const [userProgress, setUserProgress] = useState<UserProgress>(PROGRESS_DEFAULTS);
  useEffect(() => {
    setUserProgress(loadProgress());
    // Sin `channel` en deps: el progreso es GLOBAL, mide qué aprendió el
    // usuario y no cómo quiere ver un canal.
  }, []);

  const tools = visibleTools(userProgress);

  const bumpProgress = (event: 'window' | 'spectrum' | 'rsam') => {
    setUserProgress((current) => {
      const next = recordInteraction(current, event);
      saveProgress(next);
      return next;
    });
  };

  const handleToggleRevealAll = () => {
    setUserProgress((current) => {
      const next = setRevealAll(current, !current.revealAll);
      saveProgress(next);
      return next;
    });
  };

  const wave = useWaveWindow(channel, selectedWindow ?? undefined, filter);

  /**
   * El espectro es opt-in por clic y no un panel siempre montado: cada
   * apertura cuenta como interacción para la progresividad, y montarlo
   * siempre dispararía un fetch de FFT por cada zoom aunque nadie lo mire.
   */
  const [showSpectrum, setShowSpectrum] = useState(false);
  const handleToggleSpectrum = () => {
    const next = !showSpectrum;
    setShowSpectrum(next);
    if (next) bumpProgress('spectrum');
  };

  /** El clic del helicorder abre esa ventana en el wave view y cambia de pestaña. */
  const handleSelectWindow = (w: TimeWindow) => {
    setSelectedWindow(w);
    setActiveTab('wave');
    bumpProgress('window');
  };

  /** El zoom por arrastre también cuenta como ventana abierta. */
  const handleZoomWindow = (w: TimeWindow) => {
    wave.setWindow(w);
    bumpProgress('window');
  };

  /**
   * Picking (Fase 5). El hook sólo pide picks cuando la herramienta está
   * desbloqueada: antes del umbral no hay UI que los muestre y el fetch sería
   * tráfico muerto.
   */
  const picking = useSignalPicks(channel, tools.picking ? wave.window : null);
  const [armedPhase, setArmedPhase] = useState<PickPhase | null>(null);
  const [pickNote, setPickNote] = useState('');
  const [pickMutationFailed, setPickMutationFailed] = useState(false);

  const handlePickAt = async (pickTimeMs: number) => {
    if (!armedPhase) return;
    const phase = armedPhase;
    // Se desarma ANTES del await: un clic marca UNA fase, no una ráfaga.
    setArmedPhase(null);
    try {
      await picking.addPick(phase, pickTimeMs, pickNote.trim() || null);
      setPickMutationFailed(false);
      setPickNote('');
    } catch {
      setPickMutationFailed(true);
    }
  };

  const handleRemovePick = async (pickId: string) => {
    try {
      await picking.removePick(pickId);
      setPickMutationFailed(false);
    } catch {
      setPickMutationFailed(true);
    }
  };

  const handleExportPicks = async () => {
    if (!wave.window) return;
    try {
      const csv = await seismicAPI.exportStationPicksCsv(channel, wave.window);
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `picks-${channel}.csv`;
      anchor.click();
      URL.revokeObjectURL(url);
      setPickMutationFailed(false);
    } catch {
      setPickMutationFailed(true);
    }
  };

  // El selector de área vive en el layout, así que ya se ve en esta pantalla.
  // Lo que faltaba era consumirlo: cambiar de área era un no-op visual.
  const { area: activeArea } = useActiveArea();

  // La resolución channel → ciudad → {nombre, país, lat, lon} vive en
  // lib/station-location (precisión a nivel CIUDAD: orienta, no geolocaliza).
  // Sirve para dos cosas: el chequeo "dentro del área" y la orientación del
  // header (nombre + miniatura). Fuera del catálogo devuelve null y no se
  // muestra nada.
  const { data: catalog } = useSWR('/spectrograms/station-catalog', () =>
    seismicAPI.getStationCatalog(),
  );

  const stationMeta = useMemo(
    () => resolveStationLocation(catalog, channel),
    [catalog, channel],
  );

  // El área por defecto es el mundo entero: decir "dentro del área" ahí no
  // aporta nada, sólo ruido.
  //
  // OJO con la forma del tipo (verificado en `lib/types.ts:63-68` y `:105-108`):
  //   - `is_default` está en la RAÍZ del ActiveAreaResponse, NO dentro de `area`
  //   - los campos del bbox van SIN guion bajo: `minlat`, no `min_lat`
  const bbox = activeArea?.is_default ? null : (activeArea?.area?.bbox ?? null);
  const inside =
    bbox && stationMeta
      ? stationMeta.latitude >= bbox.minlat &&
        stationMeta.latitude <= bbox.maxlat &&
        stationMeta.longitude >= bbox.minlon &&
        stationMeta.longitude <= bbox.maxlon
      : null;

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
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            {/* Tokens del tema y no grises fijos: con `text-white`/`text-gray-*`
                esta pantalla era ilegible en tema claro (blanco sobre blanco). */}
            <h1 className="text-xl font-bold text-foreground">{t('title')}</h1>
            <span className="font-mono text-sm text-muted-foreground">{channel}</span>
          </div>
          {/* Orientación geográfica (hallazgo de QA: un SCNL pelado no dice
              si esto es Los Ángeles o Estambul). Nombres propios sin i18n. */}
          {stationMeta && (
            <p className="mt-1 text-sm text-muted-foreground">
              {stationMeta.name} · {stationMeta.country}
            </p>
          )}
        </div>
        {stationMeta && (
          <StationMiniMap
            latitude={stationMeta.latitude}
            longitude={stationMeta.longitude}
          />
        )}
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
            onClick={() => {
              if (!tab.enabled) return;
              setActiveTab(tab.id);
              // Cada apertura del RSAM con la serie visible cuenta como uso
              // (tarea 4.10); mirar el candado o el aviso de "sin ventana" no.
              if (tab.id === 'rsam' && tools.rsam && wave.window) bumpProgress('rsam');
            }}
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

      {inside !== null && (
        <div
          data-testid="station-area-context"
          className="mb-3 flex items-center gap-2 text-xs text-muted-foreground"
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${inside ? 'bg-teal-400' : 'bg-amber-400'}`}
          />
          {inside ? t('insideArea') : t('outsideArea')}
          <Link href="/stations" className="text-blue-400 hover:underline">
            {t('seeAreaStations')}
          </Link>
        </div>
      )}

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
            onSelectWindow={handleSelectWindow}
          />
        </>
      )}

      {activeTab === 'rsam' &&
        (!tools.rsam ? (
          <div
            data-testid="rsam-locked"
            className="rounded border border-border p-4 text-sm text-muted-foreground"
          >
            {t('rsamLocked')}
          </div>
        ) : wave.window ? (
          <RsamChart channel={channel} window={wave.window} />
        ) : (
          // Sin ventana no hay serie que pedir: mismo criterio que la pestaña
          // de onda, se explica cómo abrir una.
          <div
            data-testid="rsam-no-window"
            className="rounded border border-border p-4 text-sm text-muted-foreground"
          >
            {t('waveEmpty')}
          </div>
        ))}

      {activeTab === 'wave' &&
        (wave.window ? (
          <>
            <WaveView
              window={wave.window}
              data={wave.data}
              status={wave.status}
              canGoBack={wave.canGoBack}
              onSelectWindow={handleZoomWindow}
              onGoBack={wave.goBack}
              onReset={wave.reset}
              filter={filter}
              onFilterChange={(f) => persist({ filter: f })}
              overlay={
                tools.picking ? (
                  <PickingOverlay
                    window={wave.window}
                    picks={picking.picks}
                    armedPhase={armedPhase}
                    onPickAt={handlePickAt}
                    width={960}
                    height={280}
                  />
                ) : undefined
              }
            />

            {tools.picking && (
              <PickingPanel
                picks={picking.picks}
                measurements={picking.measurements}
                status={pickMutationFailed ? 'error' : picking.status}
                armedPhase={armedPhase}
                onArmPhase={setArmedPhase}
                onRemovePick={handleRemovePick}
                note={pickNote}
                onNoteChange={setPickNote}
                exportVisible={tools.export}
                onExport={handleExportPicks}
              />
            )}

            {tools.spectrum && (
              <div className="mt-4">
                <button
                  type="button"
                  aria-pressed={showSpectrum}
                  onClick={handleToggleSpectrum}
                  title={t('spectrumHint')}
                  className={`rounded px-3 py-1 text-sm ${
                    showSpectrum
                      ? 'bg-teal-700 text-white'
                      : 'bg-muted text-foreground hover:bg-muted/80'
                  }`}
                >
                  {t('spectrumShow')}
                </button>
                {showSpectrum && (
                  <div className="mt-2">
                    {/* La ventana del espectro es la VIGENTE del wave view
                        (wave.window), no la semilla del clic: el espectro
                        sigue al zoom, como en SWARM. */}
                    <SpectrumView channel={channel} window={wave.window} filter={filter} />
                  </div>
                )}
              </div>
            )}
          </>
        ) : (
          // Sin ventana elegida no hay nada que dibujar. Se explica cómo abrir
          // una en vez de mostrar un canvas en blanco.
          <div
            data-testid="wave-empty"
            className="rounded border border-border p-4 text-sm text-muted-foreground"
          >
            {t('waveEmpty')}
          </div>
        ))}

      {/* Escape hatch de la progresividad: quien ya sabe no tiene que ganarse
          las herramientas de nuevo. Es un TOGGLE honesto: muestra su estado,
          no desaparece al activarse (la versión que se esfumaba "no hacía
          nada" a ojos del usuario, porque su efecto vive en las pestañas de
          onda y RSAM) y se puede apagar. Solo se oculta cuando el progreso ya
          desbloqueó todo por las suyas: ahí sí no queda nada que revelar. */}
      {(userProgress.revealAll || !tools.picking) && (
        <label className="mt-6 flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={userProgress.revealAll}
            onChange={handleToggleRevealAll}
            aria-label={t('showAllTools')}
          />
          <span title={t('showAllToolsHint')}>{t('showAllTools')}</span>
          {userProgress.revealAll && (
            <span className="text-teal-600 dark:text-teal-400">{t('showAllToolsActive')}</span>
          )}
        </label>
      )}
    </div>
  );
}

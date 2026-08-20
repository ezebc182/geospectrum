'use client';

/**
 * Modo transmisión: overlay de pantalla completa pensado para compartir en
 * un stream (referencia visual: paneles tipo "Earthquakes Live"). Globo
 * full-bleed + HUD con contadores en vivo y countdown de refresco.
 *
 * Es un overlay `fixed` montado por la página del globo — no toca el layout
 * de (app) ni crea una ruta nueva: salir es desmontar (Escape o el botón X).
 *
 * Los datos NO reusan /report: el modo transmisión es global y de 24 h
 * (ventana explícita en /events/search), mientras /report recorta a la
 * ventana corta y al área activa del usuario.
 */

import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import dynamic from 'next/dynamic';
import useSWR from 'swr';
import { X, Radio, Settings2, LayoutGrid, ChevronLeft, ChevronRight } from 'lucide-react';
import { useFormatter, useNow, useTranslations } from 'next-intl';

import { seismicAPI } from '@/lib/api';
import {
  computeBroadcastStats,
  formatUtcClock,
  hourlyBuckets,
  isFreshEvent,
  latestEvents,
  minutesSinceMag,
  topRegions,
} from '@/lib/broadcast-stats';
import { buildSpotlightCard } from '@/components/spotlight-card';
import { LiveSpectrogramCanvas } from '@/components/LiveSpectrogramCanvas';
import { HIGH_RISK_SEISMIC_CITIES } from '@/lib/seismic-cities';
import { getMagnitudeSeverity, formatMagnitude, formatDepth } from '@/lib/utils';
import type { GlobeSpotlight } from '@/components/SeismicGlobe';
import type { SeismicEvent } from '@/lib/types';

// three.js accede a `window` al importarse: mismo motivo que en la página
// del globo, el componente solo puede cargarse client-side.
const SeismicGlobe = dynamic(
  () => import('@/components/SeismicGlobe').then((m) => m.SeismicGlobe),
  { ssr: false }
);

// Ventana y piso de magnitud de la vista (explícitos: los defaults del
// backend coinciden HOY, pero el modo transmisión no debe depender de eso).
const WINDOW_MINUTES = 24 * 60;
const MIN_MAG = 3;
// Cadencia de refresco, como el "Next update in: Ns" de la referencia.
const REFRESH_SECONDS = 90;

// Feed lateral: cuántos eventos mostrar y cuándo resaltar uno como nuevo.
// El panel scrollea, así que puede cargar bastante más que lo que entra.
const FEED_SIZE = 50;
const FRESH_MINUTES = 15;
const TOP_REGIONS = 6;

// Coreografía del spotlight (mismos tiempos que el hero de la landing):
// cada tanto la cámara gira hacia uno de los sismos fuertes y abre su
// infocard — es lo que hace que la transmisión se sienta viva.
const SPOTLIGHT_INTERVAL_MS = 8_000;
const SPOTLIGHT_FIRST_DELAY_MS = 2_500;
const SPOTLIGHT_POOL_SIZE = 10;

// Cartelera: capa maximizada con fondo difuso que rota entre "slides" como
// una pantalla publicitaria (pedido del usuario, 2026-08-20). El muro
// muestra TODAS las estaciones vivas — acá vive la vista SpectroNet; el
// stack lateral queda corto y sin scroll.
const BILLBOARD_SLIDES = ['wall', 'analytics'] as const;
type BillboardSlide = (typeof BILLBOARD_SLIDES)[number];
const BILLBOARD_INTERVAL_MS = 30_000;

const broadcastFetcher = (): Promise<SeismicEvent[]> =>
  seismicAPI.searchEvents({ windowMinutes: WINDOW_MINUTES, minMag: MIN_MAG });

// Clases COMPLETAS por severidad: interpolar `bg-severity-${s}/15` deja la
// clase fuera del build de Tailwind (el JIT solo ve strings literales).
// Stack de tiras finas de espectrograma (estilo RaspberryShake): se van
// agregando a medida que live-channels ofrece estaciones transmitiendo.
// 8 tiras de 44px entran sin scroll junto a las analíticas; el corte es
// por espacio, no por dato — el panel del HUD no scrollea (pedido del
// usuario: el único scroll vive en el feed de eventos).
const SPECTRO_STRIPS = 8;
// El ancho de la tira: el panel izquierdo mide w-72 (288px) menos p-3.
const SPECTRO_WIDTH = 240;
const SPECTRO_HEIGHT = 44;

const CITY_NAME_BY_ID = new Map(HIGH_RISK_SEISMIC_CITIES.map((c) => [c.id, c.name]));

// Qué paneles del HUD están visibles. Persistido: el que arma su stream
// una vez no quiere reconfigurarlo en cada apertura.
interface PanelConfig {
  analytics: boolean;
  spectrograms: boolean;
  feed: boolean;
  ticker: boolean;
}

const DEFAULT_PANELS: PanelConfig = {
  analytics: true,
  spectrograms: true,
  feed: true,
  ticker: true,
};

const PANELS_STORAGE_KEY = 'globe.broadcast.panels.v1';

// Qué estaciones eligió el usuario para el stack de espectrogramas.
// null = nunca eligió: se muestran las primeras SPECTRO_STRIPS en vivo.
const SPECTROS_STORAGE_KEY = 'globe.broadcast.spectros.v1';

function loadSpectroSelection(): string[] | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(SPECTROS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function loadPanelConfig(): PanelConfig {
  if (typeof window === 'undefined') return DEFAULT_PANELS;
  try {
    const raw = window.localStorage.getItem(PANELS_STORAGE_KEY);
    if (!raw) return DEFAULT_PANELS;
    return { ...DEFAULT_PANELS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_PANELS;
  }
}

const SEVERITY_CHIP: Record<ReturnType<typeof getMagnitudeSeverity>, string> = {
  low: 'bg-severity-low/15 text-severity-low',
  moderate: 'bg-severity-moderate/15 text-severity-moderate',
  high: 'bg-severity-high/15 text-severity-high',
  critical: 'bg-severity-critical/15 text-severity-critical',
};

interface GlobeBroadcastOverlayProps {
  onClose: () => void;
}

export function GlobeBroadcastOverlay({ onClose }: GlobeBroadcastOverlayProps) {
  const t = useTranslations('globe.broadcast');
  const { data: eventos } = useSWR('broadcast-events', broadcastFetcher, {
    refreshInterval: REFRESH_SECONDS * 1000,
  });

  // Qué estaciones tienen streaming AHORA: se re-consulta cada 5 min porque
  // los streams SeedLink se caen y vuelven solos.
  const { data: liveChannels } = useSWR(
    'broadcast-live-channels',
    () => seismicAPI.getLiveChannels(),
    { refreshInterval: 5 * 60_000 }
  );
  // Selección del usuario (agregar/quitar estaciones); sin selección se
  // muestran las primeras SPECTRO_STRIPS que estén en vivo.
  const [spectroSelection, setSpectroSelection] = useState<string[] | null>(loadSpectroSelection);
  const toggleSpectro = (channel: string) => {
    setSpectroSelection((prev) => {
      const current =
        prev ?? (liveChannels ?? []).slice(0, SPECTRO_STRIPS).map((c) => c.channel);
      const next = current.includes(channel)
        ? current.filter((c) => c !== channel)
        : [...current, channel];
      try {
        window.localStorage.setItem(SPECTROS_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // sin storage: la selección vive solo esta sesión
      }
      return next;
    });
  };

  const spectros = useMemo(() => {
    const all = liveChannels ?? [];
    const chosen =
      spectroSelection === null
        ? all.slice(0, SPECTRO_STRIPS)
        : all.filter((c) => spectroSelection.includes(c.channel));
    // Tope SIEMPRE, también sobre la selección del usuario: el panel no
    // scrollea y una selección larga desbordaba oculta bajo overflow-hidden.
    // El muro de la cartelera es el lugar donde se ve todo.
    return chosen.slice(0, SPECTRO_STRIPS).map((c) => ({
      channel: c.channel,
      name: CITY_NAME_BY_ID.get(c.city_id) ?? c.city_id,
    }));
  }, [liveChannels, spectroSelection]);

  // El muro no recorta: todas las estaciones que live-channels garantiza
  // transmitiendo, una tira por ciudad.
  const wallStrips = useMemo(
    () =>
      (liveChannels ?? []).map((c) => ({
        channel: c.channel,
        name: CITY_NAME_BY_ID.get(c.city_id) ?? c.city_id,
      })),
    [liveChannels]
  );

  const [billboard, setBillboard] = useState(false);
  const [slideIndex, setSlideIndex] = useState(0);
  const slide: BillboardSlide =
    BILLBOARD_SLIDES[((slideIndex % BILLBOARD_SLIDES.length) + BILLBOARD_SLIDES.length) % BILLBOARD_SLIDES.length];
  const openBillboard = () => {
    setSlideIndex(0);
    setBillboard(true);
  };
  // Rotación automática tipo cartelera; los botones prev/next la re-arman
  // (cambiar a mano y que a los 2s rote solo se siente como un glitch).
  useEffect(() => {
    if (!billboard) return;
    const timer = setInterval(() => setSlideIndex((i) => i + 1), BILLBOARD_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [billboard, slideIndex]);

  const isSpectroShown = (channel: string) =>
    spectroSelection === null
      ? (liveChannels ?? []).slice(0, SPECTRO_STRIPS).some((c) => c.channel === channel)
      : spectroSelection.includes(channel);

  const [panels, setPanels] = useState<PanelConfig>(loadPanelConfig);
  const [showConfig, setShowConfig] = useState(false);
  const togglePanel = (key: keyof PanelConfig) => {
    setPanels((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      try {
        window.localStorage.setItem(PANELS_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // sin storage (modo privado): la config vive solo esta sesión
      }
      return next;
    });
  };

  // El globo pide alto en píxeles (no %): se sigue el viewport a mano.
  const [viewportHeight, setViewportHeight] = useState<number | null>(null);
  useEffect(() => {
    const update = () => setViewportHeight(window.innerHeight);
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Escape sale por capas: primero la cartelera, después la transmisión.
      if (billboard) {
        setBillboard(false);
      } else {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, billboard]);

  // Countdown sincronizado con el ciclo de SWR: se rearma con cada tanda de
  // datos. Es informativo (el refresco real lo maneja SWR), por eso clava en
  // cero en vez de irse a negativo si una respuesta tarda.
  const [secondsLeft, setSecondsLeft] = useState(REFRESH_SECONDS);
  const [statsNow, setStatsNow] = useState<Date | null>(null);
  useEffect(() => {
    if (eventos === undefined) return;
    setStatsNow(new Date());
    setSecondsLeft(REFRESH_SECONDS);
    const interval = setInterval(() => {
      setSecondsLeft((s) => Math.max(0, s - 1));
    }, 1000);
    return () => clearInterval(interval);
  }, [eventos]);

  const stats = useMemo(
    () => computeBroadcastStats(eventos ?? [], statsNow ?? new Date(0)),
    [eventos, statsNow]
  );

  const feed = useMemo(() => latestEvents(eventos ?? [], FEED_SIZE), [eventos]);

  // `now` de next-intl: envejece el "hace X min" del spotlight y el resalte
  // de eventos nuevos sin regenerar todo por segundo.
  const now = useNow({ updateInterval: 60_000 });
  const format = useFormatter();

  // Spotlight rotativo sobre los sismos más fuertes (patrón del hero de la
  // landing): al azar sin repetir el anterior, para que se lea como
  // coreografía y no como "se colgó".
  const pool = useMemo(() => {
    return latestEvents(eventos ?? [], eventos?.length ?? 0)
      .filter((e) => Number.isFinite(e.lat) && Number.isFinite(e.lon))
      .sort((a, b) => b.mag - a.mag)
      .slice(0, SPOTLIGHT_POOL_SIZE);
  }, [eventos]);

  const [spotlightEvent, setSpotlightEvent] = useState<SeismicEvent | null>(null);
  useEffect(() => {
    if (pool.length === 0) return;
    let lastId: string | null = null;
    const pick = () => {
      const candidates = pool.filter((e) => e.id !== lastId);
      const elegido = candidates[Math.floor(Math.random() * candidates.length)] ?? pool[0];
      lastId = elegido.id;
      setSpotlightEvent(elegido);
    };
    const first = setTimeout(pick, SPOTLIGHT_FIRST_DELAY_MS);
    const timer = setInterval(pick, SPOTLIGHT_INTERVAL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [pool]);

  // Analíticas del HUD: una serie por gráfico, un solo tono, valores
  // directos — nada de leyendas ni dobles ejes en un panel de transmisión.
  const regiones = useMemo(() => topRegions(eventos ?? [], TOP_REGIONS), [eventos]);
  const horas = useMemo(
    () => hourlyBuckets(eventos ?? [], statsNow ?? new Date(0)),
    [eventos, statsNow]
  );
  const maxHora = Math.max(1, ...horas.map((h) => h.count));
  const maxRegion = Math.max(1, ...regiones.map((r) => r.count));

  // Ticker tipo noticiero: frases generadas de los datos, en loop.
  const ticker = useMemo(() => {
    if (!eventos || eventos.length === 0 || statsNow === null) return '';
    const frases: string[] = [];
    const ultimo = latestEvents(eventos, 1)[0];
    if (ultimo) {
      frases.push(
        t('tickerLatest', {
          mag: formatMagnitude(ultimo.mag),
          lugar: ultimo.lugar ?? `${ultimo.lat.toFixed(1)}, ${ultimo.lon.toFixed(1)}`,
          rel: format.relativeTime(new Date(ultimo.hora_utc), now),
        })
      );
    }
    const minM5 = minutesSinceMag(eventos, statsNow, 5);
    frases.push(
      minM5 === null
        ? t('tickerNoM5')
        : t('tickerSinceM5', {
            rel: format.relativeTime(new Date(statsNow.getTime() - minM5 * 60_000), now),
          })
    );
    if (regiones[0]) {
      frases.push(
        t('tickerTopRegion', { region: regiones[0].region, count: regiones[0].count })
      );
    }
    const magMax = Math.max(...eventos.map((e) => e.mag));
    frases.push(t('tickerMaxMag', { mag: formatMagnitude(magMax) }));
    return frases.join('   •••   ');
  }, [eventos, statsNow, regiones, t, format, now]);

  const spotlight = useMemo<GlobeSpotlight | null>(() => {
    if (!spotlightEvent) return null;
    return {
      lat: spotlightEvent.lat,
      lng: spotlightEvent.lon,
      render: () =>
        buildSpotlightCard(
          spotlightEvent,
          t('depthShort'),
          format.relativeTime(new Date(spotlightEvent.hora_utc), now)
        ),
    };
  }, [spotlightEvent, t, format, now]);

  // Portal a <body>: el layout de (app) tiene ancestros con transform
  // (SidebarInset, indicadores) que convierten `fixed` en "fixed relativo
  // al ancestro" — el overlay quedaba DEBAJO del navbar de la app en vez
  // de tapar el viewport entero. Visto en producción el 2026-08-20.
  const overlay = (
    // overflow-hidden en la raíz: ningún panel del HUD genera scroll; el
    // único scroll permitido es el interno del feed de eventos.
    <div className="fixed inset-0 z-[100] overflow-hidden bg-background">
      {/* Globo full-bleed detrás del HUD */}
      <div className="absolute inset-0">
        {viewportHeight !== null && (
          <SeismicGlobe
            eventos={eventos ?? []}
            height={viewportHeight}
            showControls={false}
            pointScale={1.6}
            // Misma altitud full-bleed que el hero de la landing: con el
            // default (2.5) el globo flotaba chico en un mar de fondo vacío.
            initialAltitude={1.35}
            spotlight={spotlight}
          />
        )}
      </div>

      {/* Panel de analíticas: regiones más activas + actividad por hora.
          Una serie y un tono por gráfico; los valores van directos. */}
      {(panels.analytics || panels.spectrograms) && (
      <aside className="absolute top-14 bottom-9 left-0 z-10 w-72 space-y-3 overflow-hidden p-3">
        {panels.analytics && (
        <section className="rounded-lg border border-border bg-background/85 p-3 backdrop-blur">
          <h2 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {t('topRegions')}
          </h2>
          <ul className="space-y-1.5">
            {regiones.map((r) => (
              <li key={r.region.toUpperCase()} className="flex items-center gap-2">
                <span className="w-24 truncate text-xs text-foreground">{r.region}</span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted/40">
                  <div
                    className="h-full rounded-full bg-seismic-600"
                    style={{ width: `${(r.count / maxRegion) * 100}%` }}
                  />
                </div>
                <span className="w-7 text-right font-data text-xs text-muted-foreground">
                  {r.count}
                </span>
              </li>
            ))}
          </ul>
        </section>
        )}

        {panels.analytics && (
        <section className="rounded-lg border border-border bg-background/85 p-3 backdrop-blur">
          <h2 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {t('hourlyActivity')}
          </h2>
          <div className="flex h-16 items-end gap-px" role="img" aria-label={t('hourlyActivity')}>
            {horas.map((h, i) => (
              <div
                key={i}
                title={`${h.count}`}
                className={`flex-1 rounded-t-sm ${h.hasM5 ? 'bg-severity-high' : 'bg-seismic-600'}`}
                style={{ height: `${Math.max(h.count > 0 ? 8 : 2, (h.count / maxHora) * 100)}%` }}
              />
            ))}
          </div>
          <div className="mt-1 flex justify-between font-data text-[9px] text-muted-foreground">
            <span>-24 h</span>
            <span>{t('now')}</span>
          </div>
        </section>
        )}

        {/* Espectrogramas en vivo (estilo RaspberryShake): tiras que avanzan
            solas, de estaciones que live-channels garantiza transmitiendo. */}
        {panels.spectrograms && spectros.length > 0 && (
          <section className="rounded-lg border border-border bg-background/85 p-3 backdrop-blur">
            <h2 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {t('spectrograms')}
            </h2>
            <div data-testid="spectro-strips" className="space-y-1">
              {spectros.map((s) => (
                <LiveSpectrogramCanvas
                  key={s.channel}
                  channel={s.channel}
                  label={s.name}
                  width={SPECTRO_WIDTH}
                  height={SPECTRO_HEIGHT}
                  variant="strip"
                />
              ))}
            </div>
          </section>
        )}
      </aside>
      )}

      {/* Feed lateral: últimos eventos, el más nuevo arriba. Los de los
          últimos minutos llevan punto pulsante — la "notificación" del HUD. */}
      {panels.feed && (
      <aside className="absolute top-14 bottom-9 right-0 z-10 w-80 overflow-y-auto border-l border-border bg-background/85 backdrop-blur">
        <ul data-testid="broadcast-feed" className="divide-y divide-border/60">
          {feed.map((evento) => {
            const severity = getMagnitudeSeverity(evento.mag);
            return (
              <li key={evento.id} className="flex items-start gap-3 px-3 py-2">
                <span
                  className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 font-data text-xs font-bold ${SEVERITY_CHIP[severity]}`}
                >
                  M{formatMagnitude(evento.mag)}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-foreground">
                    {evento.lugar ?? `${evento.lat.toFixed(2)}, ${evento.lon.toFixed(2)}`}
                  </p>
                  <p className="font-data text-[11px] text-muted-foreground">
                    {formatUtcClock(evento.hora_utc)} · {formatDepth(evento.prof_km)}
                  </p>
                </div>
                {isFreshEvent(evento, now, FRESH_MINUTES) && (
                  <span
                    className="mt-1.5 h-2 w-2 shrink-0 animate-pulse rounded-full bg-severity-critical"
                    title={t('freshEvent')}
                  />
                )}
              </li>
            );
          })}
        </ul>
      </aside>
      )}

      {/* HUD: barra superior */}
      <div className="absolute top-0 inset-x-0 z-10 flex items-center justify-between gap-4 bg-background/85 backdrop-blur border-b border-border px-4 py-2">
        <div className="flex items-center gap-2 min-w-0">
          <Radio className="h-4 w-4 text-severity-critical animate-pulse shrink-0" />
          <span className="font-heading font-bold text-foreground whitespace-nowrap">
            {t('title')}
          </span>
        </div>

        <div className="flex items-center gap-6 font-data text-sm">
          <div className="text-center">
            <div className="text-[10px] uppercase text-muted-foreground font-sans">
              {t('last24h')}
            </div>
            <div className="text-lg font-bold text-foreground leading-tight">
              {eventos === undefined ? '—' : stats.last24h}
            </div>
          </div>
          <div className="text-center">
            <div className="text-[10px] uppercase text-muted-foreground font-sans">
              {t('todayM5')}
            </div>
            <div className="text-lg font-bold text-severity-high leading-tight">
              {eventos === undefined ? '—' : stats.todayM5}
            </div>
          </div>
          <div className="text-center">
            <div className="text-[10px] uppercase text-muted-foreground font-sans">
              {t('todayM6')}
            </div>
            <div className="text-lg font-bold text-severity-critical leading-tight">
              {eventos === undefined ? '—' : stats.todayM6}
            </div>
          </div>
        </div>

        <div className="relative flex items-center gap-3">
          <span className="text-xs text-muted-foreground font-data whitespace-nowrap">
            {t('nextUpdate', { seconds: secondsLeft })}
          </span>
          <button
            onClick={openBillboard}
            aria-label={t('billboardMode')}
            title={t('billboardMode')}
            className="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
          >
            <LayoutGrid className="h-4 w-4" />
          </button>
          <button
            onClick={() => setShowConfig((v) => !v)}
            aria-label={t('configurePanels')}
            title={t('configurePanels')}
            className="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
          >
            <Settings2 className="h-4 w-4" />
          </button>
          <button
            onClick={onClose}
            aria-label={t('exit')}
            title={t('exit')}
            className="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="h-4 w-4" />
          </button>

          {/* Popover simple (sin Radix: un dropdown con inputs se come el
              typeahead — ver la trampa documentada del repo) */}
          {showConfig && (
            <div className="absolute right-0 top-full z-20 mt-2 w-52 rounded-lg border border-border bg-popover p-2 shadow-lg">
              {(
                [
                  ['analytics', t('panelAnalytics')],
                  ['spectrograms', t('panelSpectrograms')],
                  ['feed', t('panelFeed')],
                  ['ticker', t('panelTicker')],
                ] as [keyof PanelConfig, string][]
              ).map(([key, label]) => (
                <label
                  key={key}
                  className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-popover-foreground hover:bg-accent"
                >
                  <input
                    type="checkbox"
                    checked={panels[key]}
                    onChange={() => togglePanel(key)}
                    className="accent-current"
                  />
                  {label}
                </label>
              ))}

              {/* Estaciones del stack de espectrogramas: agregar/quitar de
                  entre las que están transmitiendo ahora. */}
              {(liveChannels ?? []).length > 0 && (
                <>
                  <div className="mt-2 mb-1 border-t border-border px-2 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {t('spectrograms')}
                  </div>
                  <div className="max-h-52 overflow-y-auto">
                    {(liveChannels ?? []).map((c) => (
                      <label
                        key={c.channel}
                        className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm text-popover-foreground hover:bg-accent"
                      >
                        <input
                          type="checkbox"
                          checked={isSpectroShown(c.channel)}
                          onChange={() => toggleSpectro(c.channel)}
                          className="accent-current"
                        />
                        {CITY_NAME_BY_ID.get(c.city_id) ?? c.city_id}
                      </label>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Cartelera: capa maximizada sobre el globo con fondo difuso, rota
          sola entre el muro (todas las estaciones vivas) y las analíticas
          en grande — pantalla publicitaria para dejar de fondo en el
          stream. Sin scroll: el muro entra porque la grilla envuelve. */}
      {billboard && (
        <div className="absolute inset-0 z-30 flex flex-col bg-background/70 backdrop-blur-xl">
          <div className="flex items-center justify-between border-b border-border/60 px-4 py-2">
            <h2 className="font-heading text-sm font-bold uppercase tracking-wider text-foreground">
              {slide === 'wall' ? t('billboardWallTitle') : t('panelAnalytics')}
            </h2>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setSlideIndex((i) => i - 1)}
                aria-label={t('billboardPrev')}
                title={t('billboardPrev')}
                className="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button
                onClick={() => setSlideIndex((i) => i + 1)}
                aria-label={t('billboardNext')}
                title={t('billboardNext')}
                className="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
              <button
                onClick={() => setBillboard(false)}
                aria-label={t('billboardClose')}
                title={t('billboardClose')}
                className="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          {slide === 'wall' && (
            <div
              data-testid="billboard-wall"
              className="flex flex-1 flex-wrap content-start justify-center gap-1.5 overflow-hidden p-3"
            >
              {wallStrips.map((s) => (
                <LiveSpectrogramCanvas
                  key={s.channel}
                  channel={s.channel}
                  label={s.name}
                  width={SPECTRO_WIDTH}
                  height={SPECTRO_HEIGHT}
                  variant="strip"
                />
              ))}
            </div>
          )}

          {slide === 'analytics' && (
            <div
              data-testid="billboard-analytics"
              className="mx-auto grid w-full max-w-4xl flex-1 content-center gap-8 overflow-hidden p-8 md:grid-cols-2"
            >
              <section>
                <h3 className="mb-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {t('topRegions')}
                </h3>
                <ul className="space-y-3">
                  {regiones.map((r) => (
                    <li key={r.region.toUpperCase()} className="flex items-center gap-3">
                      <span className="w-36 truncate text-base text-foreground">{r.region}</span>
                      <div className="h-3 flex-1 overflow-hidden rounded-full bg-muted/40">
                        <div
                          className="h-full rounded-full bg-seismic-600"
                          style={{ width: `${(r.count / maxRegion) * 100}%` }}
                        />
                      </div>
                      <span className="w-10 text-right font-data text-base text-muted-foreground">
                        {r.count}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
              <section>
                <h3 className="mb-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {t('hourlyActivity')}
                </h3>
                <div className="flex h-40 items-end gap-0.5" role="img" aria-label={t('hourlyActivity')}>
                  {horas.map((h, i) => (
                    <div
                      key={i}
                      title={`${h.count}`}
                      className={`flex-1 rounded-t-sm ${h.hasM5 ? 'bg-severity-high' : 'bg-seismic-600'}`}
                      style={{ height: `${Math.max(h.count > 0 ? 8 : 2, (h.count / maxHora) * 100)}%` }}
                    />
                  ))}
                </div>
                <div className="mt-2 flex justify-between font-data text-xs text-muted-foreground">
                  <span>-24 h</span>
                  <span>{t('now')}</span>
                </div>
              </section>
            </div>
          )}
        </div>
      )}

      {/* Ticker tipo noticiero: frases generadas de los datos, en loop
          continuo. El contenido va duplicado para que el corte del loop
          no deje la cinta vacía. */}
      {panels.ticker && ticker && (
        <div className="absolute inset-x-0 bottom-0 z-10 flex h-9 items-center overflow-hidden border-t border-border bg-background/90 backdrop-blur">
          <div className="broadcast-ticker flex shrink-0 items-center whitespace-nowrap font-data text-xs text-foreground">
            <span className="px-8">{ticker}</span>
            <span className="px-8" aria-hidden="true">
              {ticker}
            </span>
          </div>
        </div>
      )}
    </div>
  );

  return createPortal(overlay, document.body);
}

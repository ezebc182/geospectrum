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

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import dynamic from 'next/dynamic';
import useSWR from 'swr';
import { X, Radio, Settings2, LayoutGrid, ChevronLeft, ChevronRight, Minimize2, Maximize2 } from 'lucide-react';
import { useFormatter, useNow, useTranslations } from 'next-intl';

import { seismicAPI } from '@/lib/api';
import { getActiveArea } from '@/lib/areas';
import { areaViewBounds, globeFocusFromBounds, type GlobeFocus } from '@/lib/area-view-bounds';
import {
  computeBroadcastStats,
  formatUtcClock,
  hourlyBuckets,
  isFreshEvent,
  latestEvents,
  minutesSinceMag,
  topRegions,
} from '@/lib/broadcast-stats';
import { FOCUS_INTERVAL_MS, pickSpotlight, readFocusMode, type FocusMode } from '@/lib/event-focus';
import { globePointId } from '@/lib/globe-data';
import { GLOBAL_WALL_ID, WALL_PARAM, WALL_STORAGE_KEY, readWallSelection, resolveWall } from '@/lib/wall-selection';
import { buildSpotlightCard } from '@/components/spotlight-card';
import { LiveIndicator } from '@/components/LiveIndicator';
import { LiveSpectrogramCanvas } from '@/components/LiveSpectrogramCanvas';
import { useLiveEvents } from '@/hooks/use-live-events';
import { SpectronetWall } from '@/components/SpectronetWall';
import { HIGH_RISK_SEISMIC_CITIES } from '@/lib/seismic-cities';
import { getMagnitudeSeverity, formatMagnitude, formatDepth } from '@/lib/utils';
import { listWalls } from '@/lib/walls';
import { useStationMetrics } from '@/lib/use-station-metrics';
import type { GlobeSpotlight } from '@/components/SeismicGlobe';
import type { SeismicEvent } from '@/lib/types';
import { asyncStateOf } from '@/lib/async-state';
import { LoadingBlock } from '@/components/ui/loading';

// three.js accede a `window` al importarse: mismo motivo que en la página
// del globo, el componente solo puede cargarse client-side.
//
// El `loading` NO es decorativo: sin él, mientras baja el chunk de three.js
// (que no es chico) el área del globo queda literalmente en blanco. El
// dynamic de LandingHero ya tenía placeholder; este se había quedado sin uno.
const SeismicGlobe = dynamic(
  () => import('@/components/SeismicGlobe').then((m) => m.SeismicGlobe),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full w-full items-center justify-center">
        <div className="h-64 w-64 animate-pulse rounded-full bg-primary/10 md:h-96 md:w-96" />
      </div>
    ),
  }
);

// Ventana y piso de magnitud de la vista (explícitos: los defaults del
// backend coinciden HOY, pero el modo transmisión no debe depender de eso).
const WINDOW_MINUTES = 24 * 60;
const MIN_MAG = 3;
// Cadencia de refresco, como el "Next update in: Ns" de la referencia.
const REFRESH_SECONDS = 30;

// Feed lateral: cuántos eventos mostrar y cuándo resaltar uno como nuevo.
// El panel scrollea, así que puede cargar bastante más que lo que entra.
const FEED_SIZE = 50;
const FRESH_MINUTES = 15;
const TOP_REGIONS = 6;

// Modo de foco del spotlight: 'random' rota entre los sismos recientes,
// 'latest' sigue siempre al evento más nuevo (pickSpotlight decide, Task 2).
const FOCUS_STORAGE_KEY = 'globe.broadcast.focus.v1';

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
// Alto de tira del MURO de la cartelera (distinto del stack lateral del HUD,
// que usa SPECTRO_HEIGHT=44): compartida entre SpectronetWall y su fallback
// de wallStrips para que no diverjan y el muro no "salte" de tamaño al
// resolver /walls/global (bug visto en la revisión de la Task 4).
const WALL_STRIP_HEIGHT = 28;

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
  light: 'bg-severity-light/15 text-severity-light',
  moderate: 'bg-severity-moderate/15 text-severity-moderate',
  high: 'bg-severity-high/15 text-severity-high',
  critical: 'bg-severity-critical/15 text-severity-critical',
};

export interface GlobeBroadcastOverlayProps {
  onClose: () => void;
  /** Pantalla completa (portal a <body> + fixed). En `false` se renderiza
   *  embebido en el layout de la página, con `embeddedHeight` de alto. */
  fullscreen?: boolean;
  /** Alto en px cuando `fullscreen` es `false`. Ignorado en fullscreen,
   *  que siempre usa el viewport. */
  embeddedHeight?: number;
  /** Evento que arranca como spotlight (viene del `?event=` de un link
   *  compartido). Gana UNA vez: después el ciclo sigue según `focusMode`. */
  initialEventId?: string | null;
}

export function GlobeBroadcastOverlay({
  onClose,
  fullscreen = true,
  embeddedHeight,
  initialEventId,
}: GlobeBroadcastOverlayProps) {
  const t = useTranslations('globe.broadcast');
  // Estado del stream de eventos (PR-W4). El hook comparte UNA conexión con
  // el sidebar y escribe los eventos que llegan directamente en el caché de
  // SWR bajo esta misma key, así toda la cadena de useMemo de abajo sigue
  // funcionando sin cambios.
  const { status: liveStatus, isLive, receivedCount } = useLiveEvents();
  const { data: eventos, error: eventosError } = useSWR('broadcast-events', broadcastFetcher, {
    // Fallback automático (decisión del usuario, 2026-08-21): con el WS vivo
    // el polling se apaga; si se cae, vuelve solo. El usuario nunca se queda
    // sin datos, y no hay dos fuentes escribiendo la misma key a la vez.
    refreshInterval: isLive ? 0 : REFRESH_SECONDS * 1000,
  });

  // Qué estaciones tienen streaming AHORA: se re-consulta cada 5 min porque
  // los streams SeedLink se caen y vuelven solos.
  const { data: liveChannels } = useSWR(
    'broadcast-live-channels',
    () => seismicAPI.getLiveChannels(),
    { refreshInterval: 5 * 60_000 }
  );

  // Área activa, para que cambiarla encuadre la cámara TAMBIÉN en transmisión
  // (antes el overlay se montaba sin focusArea y la cámara no se movía).
  //
  // Se lee acá y no llega por prop a propósito: la key '/areas/active' es la
  // misma que usa la página, así que SWR deduplica y esto no dispara un fetch
  // extra — y el overlay queda autónomo como el resto de sus datos, sin
  // depender de que quien lo monte se acuerde de cablearlo.
  const { data: activeArea } = useSWR('/areas/active', getActiveArea);

  const focusArea: GlobeFocus | null = useMemo(() => {
    const area = activeArea?.area;
    if (!area) return null;
    const bounds = areaViewBounds(area.geometry, area.bbox);
    return bounds ? globeFocusFromBounds(bounds) : null;
  }, [activeArea]);

  // Muro SPECTRONET (Task 1): estático, generado del catálogo — no depende
  // de qué esté transmitiendo ahora, por eso no necesita refresco periódico.
  const { data: globalWall } = useSWR('broadcast-wall', () => seismicAPI.getGlobalWall(), {
    revalidateOnFocus: false,
  });
  // Muros propios del usuario (Task 4): sin sesión, listWalls resuelve null
  // (401) y el selector queda solo con la opción Global.
  const { data: userWalls } = useSWR('broadcast-user-walls', () => listWalls(), {
    revalidateOnFocus: false,
  });
  // Selección del muro a mostrar en la cartelera (Task 8): query param gana
  // sobre localStorage (kiosks por URL), default el muro Global.
  const [wallId, setWallId] = useState<string>(() => {
    if (typeof window === 'undefined') return GLOBAL_WALL_ID;
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(WALL_STORAGE_KEY);
    } catch {
      // storage bloqueado: queda el default
    }
    return readWallSelection(window.location.search, stored);
  });
  // id desconocido o muro borrado cae al Global: la cartelera nunca queda
  // en blanco (resolveWall, Task 8).
  const activeWall = resolveWall(wallId, userWalls, globalWall);
  useEffect(() => {
    try {
      window.localStorage.setItem(WALL_STORAGE_KEY, wallId);
    } catch {
      // storage bloqueado: la selección vive solo en la sesión
    }
    // history.replaceState, NUNCA router.replace: este último remonta el
    // canvas WebGL del globo (mismo patrón que ?event= en globe/page.tsx).
    const url = new URL(window.location.href);
    if (wallId === GLOBAL_WALL_ID) url.searchParams.delete(WALL_PARAM);
    else url.searchParams.set(WALL_PARAM, wallId);
    window.history.replaceState(null, '', url.toString());
  }, [wallId]);
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

  // Canales del muro activo, para pedirles las métricas en un solo batch.
  const wallChannels = useMemo(
    () =>
      activeWall
        ? activeWall.layout.columns.flatMap((c) =>
            c.groups.flatMap((g) => g.channels.map((ch) => ch.channel))
          )
        : [],
    [activeWall]
  );
  // El polling se apaga si la cartelera está cerrada o si el muro no pide
  // métricas: sin este gate serían ~74 canales cada 15 s para nada.
  const wallMetrics = useStationMetrics(
    wallChannels,
    billboard && (activeWall?.layout.showMetrics ?? false)
  );

  const [slideIndex, setSlideIndex] = useState(0);
  // Epoch de navegación MANUAL: prev/next lo suben para re-armar el timer
  // (cambiar a mano y que a los 2s rote solo se siente como un glitch).
  // Con slideIndex en las deps el timer también se re-armaba en cada tick
  // automático — mismo resultado observable, intención confusa.
  const [navEpoch, setNavEpoch] = useState(0);
  const slide: BillboardSlide =
    BILLBOARD_SLIDES[((slideIndex % BILLBOARD_SLIDES.length) + BILLBOARD_SLIDES.length) % BILLBOARD_SLIDES.length];
  const openBillboard = () => {
    setSlideIndex(0);
    setBillboard(true);
  };
  const navigateSlide = (delta: number) => {
    setSlideIndex((i) => i + delta);
    setNavEpoch((e) => e + 1);
  };
  useEffect(() => {
    if (!billboard) return;
    const timer = setInterval(() => setSlideIndex((i) => i + 1), BILLBOARD_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [billboard, navEpoch]);

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

  // Marca que ya estamos en el navegador. El portal a `document.body` (ver el
  // return) no puede correr durante el prerender del servidor, donde no hay
  // DOM. Un efecto sólo corre en el cliente, así que esto es `false` en SSR y
  // en el primer render del cliente — que es justo lo que hidrata parejo.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

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
      // Escape sale por capas: primero la cartelera, después la pantalla
      // completa. Embebido no hay pantalla completa de la que salir.
      if (billboard) {
        setBillboard(false);
      } else if (fullscreen) {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, billboard, fullscreen]);

  // Countdown sincronizado con el ciclo de SWR: se rearma con cada tanda de
  // datos. Es informativo (el refresco real lo maneja SWR), por eso clava en
  // cero en vez de irse a negativo si una respuesta tarda.
  const [secondsLeft, setSecondsLeft] = useState(REFRESH_SECONDS);
  const [statsNow, setStatsNow] = useState<Date | null>(null);
  useEffect(() => {
    if (eventos === undefined) return;
    setStatsNow(new Date());
    // Con el WS vivo no hay próximo poll que contar: el countdown se apaga y
    // en su lugar se muestra el indicador. Igual se sigue actualizando
    // `statsNow`, que es lo que fecha las estadísticas de la cartelera.
    if (isLive) return;
    setSecondsLeft(REFRESH_SECONDS);
    const interval = setInterval(() => {
      setSecondsLeft((s) => Math.max(0, s - 1));
    }, 1000);
    return () => clearInterval(interval);
  }, [eventos, isLive]);

  const stats = useMemo(
    () => computeBroadcastStats(eventos ?? [], statsNow ?? new Date(0)),
    [eventos, statsNow]
  );

  const feed = useMemo(() => latestEvents(eventos ?? [], FEED_SIZE), [eventos]);

  // El `?? []` de arriba es cómodo para calcular, pero borra la diferencia
  // entre "todavía no llegó" y "no hubo sismos": con la lista vacía el globo
  // se dibujaba pelado y el feed quedaba en blanco, sin decir cuál de las dos
  // cosas estaba pasando. El estado se deriva del dato CRUDO, antes del
  // fallback (ver lib/async-state.ts).
  const eventosState = asyncStateOf(eventos, eventosError);

  // `now` de next-intl: envejece el "hace X min" del spotlight y el resalte
  // de eventos nuevos sin regenerar todo por segundo.
  const now = useNow({ updateInterval: 60_000 });
  const format = useFormatter();

  // Modo de foco: 'random' (default) rota entre los eventos recientes,
  // 'latest' sigue siempre al más nuevo. Query param gana sobre localStorage.
  const [focusMode, setFocusMode] = useState<FocusMode>(() =>
    readFocusMode(
      typeof window !== 'undefined' ? window.location.search : '',
      typeof window !== 'undefined' ? window.localStorage.getItem(FOCUS_STORAGE_KEY) : null
    )
  );
  const changeFocusMode = (mode: FocusMode) => {
    setFocusMode(mode);
    try {
      window.localStorage.setItem(FOCUS_STORAGE_KEY, mode);
    } catch {
      // sin storage: el modo vive solo esta sesión
    }
  };

  // Spotlight: decide QUÉ mirar pickSpotlight (Task 2); acá solo se coreografía
  // el timer y se aplica el resultado. En modo latest, null = "ya está
  // enfocado" (no mover cámara).
  //
  // `eventos` cambia de referencia con cada poll de SWR (30s) aunque el
  // contenido sea el mismo. Si el efecto del interval dependiera de
  // `eventos`, CADA refetch desmontaría/remontaría el timer entero
  // (clearInterval + pick inmediato + setInterval nuevo) — en AMBOS modos,
  // no solo en latest. Eso corta la cadencia de FOCUS_INTERVAL_MS en modo
  // random y mete un pick fuera de ritmo (bug reportado en code review,
  // 2026-08-20). Por eso `eventos` vive en un ref, leído por el timer sin
  // formar parte de sus deps: el interval de 20s queda estable y solo se
  // reinicia si cambia `focusMode`.
  const eventosRef = useRef<SeismicEvent[]>([]);

  const [spotlightEvent, setSpotlightEvent] = useState<SeismicEvent | null>(null);
  const lastFocusedIdRef = useRef<string | null>(null);
  // El id del link (`initialEventId`) gana la primera elección y se consume:
  // si siguiera ganando, el ciclo automático quedaría trabado en ese evento
  // para siempre y la transmisión dejaría de rotar.
  const initialEventConsumedRef = useRef(false);
  // Se marca en el mismo golpe que `initialEventConsumedRef`, pero se lee y
  // resetea aparte: el efecto de "modo latest" (más abajo) corre en el MISMO
  // commit que el del pick inicial cuando el pool recién se pobló, y sin esta
  // bandera pickearía el evento más nuevo y pisaría el spotlight del link
  // antes de que el usuario llegue a verlo.
  const justAppliedInitialRef = useRef(false);
  const pickSpotlightNow = () => {
    const pool = eventosRef.current;
    if (pool.length === 0) return;
    const elegido = pickSpotlight(focusMode, pool, lastFocusedIdRef.current, Math.random);
    if (elegido === null) return;
    lastFocusedIdRef.current = elegido.id;
    setSpotlightEvent(elegido);
  };

  const applyInitialEventIfPending = () => {
    if (initialEventConsumedRef.current || !initialEventId) return false;
    initialEventConsumedRef.current = true;
    const delLink = eventosRef.current.find((e) => globePointId(e) === initialEventId);
    if (!delLink) {
      // Si el evento del link ya no está en la ventana de 24 h, se sigue
      // con la elección normal en vez de dejar la transmisión sin spotlight.
      return false;
    }
    lastFocusedIdRef.current = delLink.id;
    setSpotlightEvent(delLink);
    justAppliedInitialRef.current = true;
    return true;
  };

  useEffect(() => {
    eventosRef.current = eventos ?? [];
    // Primeros datos que llegan (SWR resuelve async, así que nunca están
    // listos en el montaje): se dispara el pick inicial apenas hay pool, en
    // AMBOS modos — si no, el spotlight quedaría vacío hasta el primer tick
    // del interval de 20s. `lastFocusedIdRef` sigue null solo hasta el
    // primer pick exitoso, así que esto corre una única vez; refetches
    // posteriores (mismo pool ya poblado, otra referencia) no lo repiten en
    // modo random — en latest lo cubre el efecto dedicado de más abajo.
    if (eventosRef.current.length === 0) return;
    // El spotlight del link se intenta consumir ACÁ, antes que nada: este
    // efecto está declarado primero, así que corre antes que el de modo
    // latest en el mismo commit. Si el efecto de latest lo intentara por su
    // cuenta, ambos correrían en el mismo ciclo (el pool recién poblado) y
    // el de latest pisaría el spotlight del link con el evento más nuevo.
    // La guardia de arriba (pool vacío) es clave: SWR resuelve async, así
    // que el primer render de este efecto corre con `eventos` todavía
    // `undefined` — si se consumiera `initialEventId` ahí, se perdería para
    // siempre antes de que lleguen los datos reales.
    if (applyInitialEventIfPending()) return;
    if (lastFocusedIdRef.current === null) {
      pickSpotlightNow();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventos]);

  // Timer del spotlight: cadencia estable de FOCUS_INTERVAL_MS. Deps SOLO
  // `[focusMode]` — `eventos` NO va acá (ver nota arriba): si dependiera de
  // `eventos`, cada refetch de SWR (cada 30s, nueva referencia de array
  // aunque el contenido sea el mismo) desmontaría/remontaría el timer
  // entero, cortando la cadencia de 20s también en modo random (bug
  // reportado en code review, 2026-08-20).
  useEffect(() => {
    const timer = setInterval(pickSpotlightNow, FOCUS_INTERVAL_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusMode]);

  // Solo en modo latest: apenas llega un evento nuevo (nueva referencia de
  // `eventos` desde SWR) se re-evalúa el spotlight sin esperar el próximo
  // tick del interval de 20s. En modo random esto NO debe disparar nada —
  // ahí la cadencia la marca únicamente el interval de arriba.
  useEffect(() => {
    if (focusMode !== 'latest') return;
    // El efecto de arriba (mismo commit, mismo cambio de `eventos`) ya puede
    // haber aplicado el spotlight del link: no pisarlo con el más nuevo.
    if (justAppliedInitialRef.current) {
      justAppliedInitialRef.current = false;
      return;
    }
    pickSpotlightNow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventos, focusMode]);

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

  // Lleva la fila enfocada del feed a la vista: el spotlight puede cambiar
  // por el timer o por un clic en el globo, y en ambos casos el sidebar debe
  // mostrar por qué evento va sin que el usuario tenga que scrollear a mano.
  // 'nearest' evita el salto si la fila ya está visible.
  useEffect(() => {
    if (!spotlightEvent) return;
    document.querySelector('[data-testid="feed-row-focused"]')?.scrollIntoView({ block: 'nearest' });
  }, [spotlightEvent]);

  // En fullscreen el globo ocupa el viewport; embebido, el alto que le pasa
  // la página. Se mantiene `viewportHeight` como fuente en fullscreen porque
  // ya sigue el resize de la ventana.
  const globeHeight = fullscreen ? viewportHeight : (embeddedHeight ?? null);

  const overlay = (
    // overflow-hidden en la raíz: ningún panel del HUD genera scroll; el
    // único scroll permitido es el interno del feed de eventos.
    <div
      data-testid="broadcast-root"
      className={
        fullscreen
          ? 'fixed inset-0 z-[100] overflow-hidden bg-background'
          : 'relative w-full overflow-hidden rounded-xl border border-border bg-background'
      }
      style={fullscreen ? undefined : { height: embeddedHeight }}
    >
      {/* Globo full-bleed detrás del HUD */}
      <div className="absolute inset-0">
        {globeHeight !== null && (
          <SeismicGlobe
            eventos={eventos ?? []}
            height={globeHeight}
            showControls={false}
            pointScale={1.6}
            // Misma altitud full-bleed que el hero de la landing: con el
            // default (2.5) el globo flotaba chico en un mar de fondo vacío.
            initialAltitude={1.35}
            // El globo queda QUIETO y gira sólo un momento cuando entra un
            // sismo (pedido del usuario 2026-08-22): así el movimiento
            // significa "acaba de pasar algo" en vez de ser decoración que
            // además arrastra fuera de la vista lo que uno mira.
            rotationPolicy="on-event"
            // `receivedCount` cambia con cada evento que llega por el
            // WebSocket: es el disparador natural del pulso.
            eventPulse={receivedCount}
            // El área encuadra la cámara; el spotlight se abstiene solo
            // mientras dura esa animación (ver isAreaAnimating en SeismicGlobe)
            // y retoma después, así conviven sin pelearse por la cámara.
            focusArea={focusArea}
            spotlight={spotlight}
            // Clic en un punto: enfoca ese evento como spotlight y mantiene
            // el ref de "último enfocado" coherente, igual que hace
            // pickSpotlightNow — si no, en modo latest el próximo tick del
            // interval podría re-elegir el mismo evento y disparar un pick
            // de más.
            onEventClick={(id) => {
              const target = (eventos ?? []).find((e) => e.id === id);
              if (!target) return;
              lastFocusedIdRef.current = target.id;
              setSpotlightEvent(target);
            }}
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
        {eventosState === 'loading' && (
          <div className="p-3">
            <LoadingBlock label={t('loadingEvents')} lines={6} />
          </div>
        )}
        {eventosState === 'empty' && (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">
            {t('noEvents')}
          </p>
        )}
        {eventosState === 'error' && (
          <p role="alert" className="px-3 py-6 text-center text-sm text-destructive">
            {t('loadError')}
          </p>
        )}
        <ul data-testid="broadcast-feed" className="divide-y divide-border/60">
          {feed.map((evento) => {
            const severity = getMagnitudeSeverity(evento.mag);
            const isFocused = evento.id === spotlightEvent?.id;
            return (
              <li
                key={evento.id}
                data-testid={isFocused ? 'feed-row-focused' : undefined}
                className={`flex items-start gap-3 px-3 py-2 ${
                  isFocused ? 'bg-teal-950/60 ring-1 ring-teal-500/60' : ''
                }`}
              >
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
          {/* Con el stream vivo el countdown no significa nada: los eventos
              llegan empujados, no en la próxima tanda. Se reemplaza por el
              indicador, que es lo que pide el spec (§5). Cuando el WS está
              caído vuelve el contador, porque ahí sí hay un próximo poll. */}
          {isLive ? (
            <LiveIndicator status={liveStatus} className="whitespace-nowrap font-data" />
          ) : (
            <span className="text-xs text-muted-foreground font-data whitespace-nowrap">
              {t('nextUpdate', { seconds: secondsLeft })}
            </span>
          )}
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
            type="button"
            onClick={onClose}
            aria-label={fullscreen ? t('exitFullscreen') : t('enterFullscreen')}
            title={fullscreen ? t('exitFullscreen') : t('enterFullscreen')}
            className="rounded-lg p-1.5 transition-colors hover:bg-muted/60"
          >
            {fullscreen ? (
              <Minimize2 className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Maximize2 className="h-4 w-4" aria-hidden="true" />
            )}
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

              {/* Foco del spotlight: aleatorio (default) o siguiendo siempre
                  al evento más nuevo. aria-label lleva el valor literal del
                  modo (estable en cualquier idioma); el texto visible usa
                  las claves i18n. */}
              <div className="mt-2 mb-1 border-t border-border px-2 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {t('focus.label')}
              </div>
              <div role="radiogroup" aria-label={t('focus.label')} className="flex gap-1 px-2 pb-1">
                {(['random', 'latest'] as FocusMode[]).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    role="radio"
                    aria-checked={focusMode === mode}
                    aria-label={mode}
                    onClick={() => changeFocusMode(mode)}
                    className={`flex-1 rounded px-2 py-1 text-xs transition-colors ${
                      focusMode === mode
                        ? 'bg-accent text-foreground'
                        : 'text-popover-foreground hover:bg-accent/50'
                    }`}
                  >
                    {mode === 'random' ? t('focus.random') : t('focus.latest')}
                  </button>
                ))}
              </div>

              {/* Selector de muro de la cartelera (Task 8): Global + los
                  propios del usuario. <select> nativo porque son N muros
                  (el radiogroup de foco solo sirve para 2 opciones fijas). */}
              <div className="mt-2 mb-1 border-t border-border px-2 pt-2">
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {t('wallSelector.label')}
                </div>
                <select
                  aria-label={t('wallSelector.label')}
                  className="w-full rounded border border-border bg-background px-2 py-1 text-xs"
                  value={wallId}
                  onChange={(e) => setWallId(e.target.value)}
                >
                  <option value={GLOBAL_WALL_ID}>{t('wallSelector.global')}</option>
                  {(userWalls ?? []).map((wall) => (
                    <option key={wall.id} value={wall.id}>
                      {wall.name}
                    </option>
                  ))}
                </select>
              </div>

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
                onClick={() => navigateSlide(-1)}
                aria-label={t('billboardPrev')}
                title={t('billboardPrev')}
                className="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button
                onClick={() => navigateSlide(1)}
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

          {/* El muro queda MONTADO (oculto) mientras rota otro slide: cada
              tira es 1 WebSocket + 1 fetch de historial, y desmontar/montar
              ~74 en cada rotación era una tormenta de reconexiones. Layout
              SPECTRONET (columnas + grupos) mientras carga /walls/global;
              wallStrips queda de fallback para que el muro NUNCA esté en
              blanco durante esa espera. */}
          <div
            data-testid="billboard-wall"
            className={`flex-1 overflow-hidden ${slide === 'wall' ? 'flex' : 'hidden'}`}
          >
            {activeWall ? (
              <SpectronetWall
                wall={activeWall}
                stripWidth={SPECTRO_WIDTH}
                stripHeight={WALL_STRIP_HEIGHT}
                metrics={wallMetrics}
              />
            ) : (
              <div className="flex flex-1 flex-wrap content-start justify-center gap-1.5 p-3">
                {wallStrips.map((s) => (
                  <LiveSpectrogramCanvas
                    key={s.channel}
                    channel={s.channel}
                    label={s.name}
                    width={SPECTRO_WIDTH}
                    height={WALL_STRIP_HEIGHT}
                    variant="strip"
                  />
                ))}
              </div>
            )}
          </div>

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

  // Portal SÓLO en fullscreen: el layout de (app) tiene ancestros con
  // transform (SidebarInset, indicadores) que convierten `fixed` en "fixed
  // relativo al ancestro" y el overlay quedaba debajo del navbar (visto en
  // producción el 2026-08-20). Embebido no hay `fixed` que rescatar, y
  // portalear lo sacaría del flujo donde justamente lo queremos.
  //
  // `mounted` es imprescindible: 'use client' NO evita el prerender en el
  // servidor, y ahí `document` no existe. Antes no saltaba porque el overlay
  // se montaba recién al hacer clic (ya en el navegador); desde que /globe
  // ES la transmisión, este componente es lo primero que renderiza la ruta y
  // pasa por SSR. Sin el guard: "document is not defined".
  if (fullscreen) {
    return mounted ? createPortal(overlay, document.body) : null;
  }
  return overlay;
}

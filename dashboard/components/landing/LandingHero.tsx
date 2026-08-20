/**
 * Hero de la landing pública: el globo 3D en vivo como protagonista.
 *
 * No usa screenshots ni mockups a propósito — el globo consume el endpoint
 * público /events (misma fuente que el dashboard), así que lo que gira en la
 * portada ES el producto, con sismos reales de las últimas horas. Si la API
 * no responde, el globo se muestra igual con las placas tectónicas: la
 * landing nunca puede romperse por un fetch.
 */

'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useFormatter, useNow, useTranslations } from 'next-intl';
import useSWR from 'swr';
import { Activity, ArrowRight, Languages, Radio } from 'lucide-react';

import { eventsFetcher } from '@/lib/api';
import { magnitudeColor } from '@/lib/globe-data';
import { Button } from '@/components/ui/button';
import { buildSpotlightCard } from '@/components/spotlight-card';
import type { GlobeSpotlight } from '@/components/SeismicGlobe';
import type { SeismicEvent } from '@/lib/types';

// three.js toca `window` al importarse: siempre dynamic + ssr:false (misma
// razón que en app/(app)/globe/page.tsx). El placeholder es un disco con
// pulso para que el layout no salte cuando aparece el canvas.
const SeismicGlobe = dynamic(
  () => import('@/components/SeismicGlobe').then((m) => m.SeismicGlobe),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full w-full items-center justify-center">
        <div className="h-64 w-64 animate-pulse rounded-full bg-primary/10 md:h-96 md:w-96" />
      </div>
    ),
  },
);

/** Refresco de eventos en ms. 60s: "en vivo" sin castigar a la API pública. */
const REFRESH_INTERVAL_MS = 60_000;

/** Cantidad de eventos del ticker de actividad reciente. */
const TICKER_SIZE = 4;

/**
 * Cámara y escala del globo en modo hero. Más cerca (1.35 vs 2.5 default) y
 * con puntos/anillos 1.8x: a pantalla completa el globo tiene que IMPACTAR —
 * la esfera llena el viewport y un M5 se ve desde lejos (pedido del usuario).
 */
const HERO_ALTITUDE = 1.35;
const HERO_POINT_SCALE = 1.8;

/**
 * Coreografía del spotlight: cada SPOTLIGHT_INTERVAL_MS se abre la infocard
 * sobre un sismo al azar del pool (los más fuertes del catálogo — un M5
 * cuenta mejor la historia que un M3). El primer cartel espera un poco:
 * el globo tiene que existir antes de que algo se ancle a él.
 */
const SPOTLIGHT_INTERVAL_MS = 8_000;
const SPOTLIGHT_FIRST_DELAY_MS = 2_500;
const SPOTLIGHT_POOL_SIZE = 15;

// La infocard del spotlight se extrajo a components/spotlight-card.ts
// cuando el modo transmisión del globo necesitó el mismo cartel.

interface LandingHeroProps {
  onToggleLocale: () => void;
}

export function LandingHero({ onToggleLocale }: LandingHeroProps) {
  const t = useTranslations('landing');
  const format = useFormatter();
  // "hace X minutos" de los últimos sismos: el `now` va explícito por la misma
  // razón que en el Dashboard —sin él, servidor y cliente miden contra
  // instantes distintos y el markup no coincide al hidratar—, y acá pesa más
  // porque esta es la landing pública. 60s de intervalo: los relativos que se
  // muestran son de minutos/horas, así que refrescar más seguido no cambiaría
  // el texto.
  const now = useNow({ updateInterval: 60000 });
  const heroRef = useRef<HTMLDivElement>(null);
  const [globeHeight, setGlobeHeight] = useState(0);
  const [autoRotate, setAutoRotate] = useState(true);

  // SeismicGlobe mide solo el ancho de su contenedor; el alto se lo pasamos
  // nosotros midiendo el hero, porque acá el globo es fondo a pantalla
  // completa y no un card de alto fijo.
  useEffect(() => {
    const element = heroRef.current;
    if (!element) return;

    const update = () => setGlobeHeight(element.clientHeight);
    update();

    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // La rotación continua del globo es movimiento decorativo: se apaga si el
  // visitante pidió prefers-reduced-motion. Los datos siguen visibles.
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setAutoRotate(!media.matches);
    update();

    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  const { data: eventos } = useSWR<SeismicEvent[]>('landing-events', eventsFetcher, {
    refreshInterval: REFRESH_INTERVAL_MS,
    revalidateOnFocus: false,
  });

  const stats = useMemo(() => {
    if (!eventos || eventos.length === 0) return null;

    const magnitudMax = Math.max(...eventos.map((e) => e.mag));
    const masReciente = eventos.reduce((a, b) => (a.hora_utc > b.hora_utc ? a : b));
    return { total: eventos.length, magnitudMax, masReciente };
  }, [eventos]);

  const recientes = useMemo(() => {
    if (!eventos) return [];
    return [...eventos]
      .sort((a, b) => b.hora_utc.localeCompare(a.hora_utc))
      .slice(0, TICKER_SIZE);
  }, [eventos]);

  // Spotlight: pool con los sismos más fuertes del catálogo visible.
  const spotlightPool = useMemo(() => {
    if (!eventos) return [];
    return [...eventos]
      .filter((e) => Number.isFinite(e.lat) && Number.isFinite(e.lon))
      .sort((a, b) => b.mag - a.mag)
      .slice(0, SPOTLIGHT_POOL_SIZE);
  }, [eventos]);

  const [spotlight, setSpotlight] = useState<{ evento: SeismicEvent; key: number } | null>(
    null,
  );

  useEffect(() => {
    if (spotlightPool.length === 0) return;

    let lastId: string | null = null;
    const pick = () => {
      // Al azar pero sin repetir el anterior: dos veces el mismo cartel
      // seguido se lee como "se colgó", no como coreografía.
      const candidates = spotlightPool.filter((e) => e.id !== lastId);
      const elegido =
        candidates[Math.floor(Math.random() * candidates.length)] ?? spotlightPool[0];
      lastId = elegido.id;
      setSpotlight({ evento: elegido, key: Date.now() });
    };

    const first = setTimeout(pick, SPOTLIGHT_FIRST_DELAY_MS);
    const timer = setInterval(pick, SPOTLIGHT_INTERVAL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [spotlightPool]);

  const globeSpotlight = useMemo<GlobeSpotlight | null>(() => {
    if (!spotlight) return null;
    const { evento } = spotlight;
    return {
      lat: evento.lat,
      lng: evento.lon,
      render: () =>
        buildSpotlightCard(
          evento,
          t('hero.depthShort'),
          format.relativeTime(new Date(evento.hora_utc), now),
        ),
    };
    // `now` va en las deps porque el render del card lo CONSUME: sin él el memo
    // se quedaría con el relativo del primer render y el "hace X" del globo
    // nunca envejecería —la misma trampa de leer un valor cambiante sin
    // declararlo que ya nos costó un efecto que corría una sola vez.
  }, [spotlight, t, format, now]);

  return (
    <section ref={heroRef} className="relative min-h-dvh overflow-hidden">
      {/* Capa 1: el globo, a pantalla completa detrás de todo. Interactivo
          (se puede arrastrar para rotar) — por eso el overlay de texto usa
          pointer-events-none salvo en los controles. El zoom con rueda está
          apagado: acá la rueda tiene que scrollear la página. */}
      <div className="absolute inset-0" aria-hidden="true">
        {globeHeight > 0 && (
          <SeismicGlobe
            eventos={eventos ?? []}
            height={globeHeight}
            showControls={false}
            autoRotate={autoRotate}
            enableZoom={false}
            initialAltitude={HERO_ALTITUDE}
            pointScale={HERO_POINT_SCALE}
            spotlight={globeSpotlight}
            atmosphereColor="#2dd4bf"
            atmosphereAltitude={0.22}
          />
        )}
      </div>

      {/* Capa 2: scrim inferior para que el texto sea legible sobre el globo
          sin taparlo — el gradiente deja el centro de la esfera limpio. */}
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-background via-background/70 to-transparent"
        aria-hidden="true"
      />

      {/* Nav mínima: marca, toggle de idioma y login. */}
      <header className="absolute inset-x-0 top-0 z-10">
        <nav className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
          <Link
            href="/"
            className="flex items-center gap-2 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Activity className="h-6 w-6 text-primary" aria-hidden="true" />
            <span className="font-heading text-lg font-semibold tracking-tight">
              GeoSpectrum
            </span>
          </Link>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              onClick={onToggleLocale}
              aria-label={t('nav.localeToggleAria')}
              className="min-h-11 gap-1.5 font-mono text-xs"
            >
              <Languages className="h-4 w-4" aria-hidden="true" />
              {t('nav.localeToggle')}
            </Button>
            <Button asChild variant="outline" className="min-h-11">
              <Link href="/login">{t('nav.login')}</Link>
            </Button>
          </div>
        </nav>
      </header>

      {/* Capa 3: contenido del hero, anclado al tercio inferior. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10">
        <div className="mx-auto grid max-w-6xl gap-10 px-6 pb-14 md:grid-cols-[1.4fr_1fr] md:items-end">
          <div>
            <p className="mb-4 inline-flex items-center gap-2 rounded-full border border-border bg-card/60 px-3 py-1 font-mono text-xs uppercase tracking-widest text-muted-foreground backdrop-blur">
              <span className="relative flex h-2 w-2" aria-hidden="true">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75 motion-reduce:animate-none" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
              </span>
              {t('hero.badge')}
            </p>

            <h1 className="font-heading text-4xl font-bold leading-tight tracking-tight md:text-6xl">
              {t('hero.titleTop')}
              <br />
              <span className="text-primary">{t('hero.titleAccent')}</span>
            </h1>

            <p className="mt-5 max-w-xl text-base leading-relaxed text-muted-foreground md:text-lg">
              {t('hero.subtitle')}
            </p>

            <div className="pointer-events-auto mt-8 flex flex-wrap items-center gap-4">
              <Button asChild size="lg" className="min-h-12 px-6 text-base">
                <Link href="/login">
                  {t('hero.ctaPrimary')}
                  <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
                </Link>
              </Button>
              <Button asChild size="lg" variant="ghost" className="min-h-12 px-6 text-base">
                <a href="#como-funciona">{t('hero.ctaSecondary')}</a>
              </Button>
            </div>

            {stats && (
              <dl className="mt-8 flex flex-wrap gap-x-8 gap-y-3 font-mono text-sm tabular-nums text-muted-foreground">
                <div>
                  <dt className="sr-only">{t('hero.statsTracked')}</dt>
                  <dd>
                    <span className="text-foreground">{stats.total}</span>{' '}
                    {t('hero.statsTracked')}
                  </dd>
                </div>
                <div>
                  <dt className="sr-only">{t('hero.statsMax')}</dt>
                  <dd>
                    M
                    <span className="text-foreground">
                      {stats.magnitudMax.toFixed(1)}
                    </span>{' '}
                    {t('hero.statsMax')}
                  </dd>
                </div>
                <div>
                  <dt className="sr-only">{t('hero.statsLast')}</dt>
                  <dd>
                    {t('hero.statsLast')}{' '}
                    {format.relativeTime(new Date(stats.masReciente.hora_utc), now)}
                  </dd>
                </div>
              </dl>
            )}
          </div>

          {/* Columna derecha: ticker de actividad reciente. Sólo en desktop —
              en mobile el hero es título y globo. min-w-0: sin esto el grid
              item no puede achicarse por debajo de su contenido. */}
          <div className="pointer-events-auto hidden min-w-0 flex-col gap-4 md:flex">
            {recientes.length > 0 && (
              <aside
                className="rounded-xl border border-border bg-card/70 p-4 backdrop-blur"
                aria-label={t('hero.tickerTitle')}
              >
                <h2 className="mb-3 flex items-center gap-2 font-mono text-xs uppercase tracking-widest text-muted-foreground">
                  <Radio className="h-3.5 w-3.5" aria-hidden="true" />
                  {t('hero.tickerTitle')}
                </h2>
                <ol className="space-y-2.5">
                  {recientes.map((evento) => (
                    <li
                      key={evento.id}
                      className="flex items-baseline gap-3 font-mono text-sm tabular-nums"
                    >
                      <span
                        className="font-semibold"
                        style={{ color: magnitudeColor(evento.mag) }}
                      >
                        M{evento.mag.toFixed(1)}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-foreground/90">
                        {evento.lugar ?? `${evento.lat.toFixed(1)}, ${evento.lon.toFixed(1)}`}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {format.relativeTime(new Date(evento.hora_utc), now)}
                      </span>
                    </li>
                  ))}
                </ol>
              </aside>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

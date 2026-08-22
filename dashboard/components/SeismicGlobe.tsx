/**
 * Globo 3D con los eventos sísmicos, los límites de placas y el área activa.
 *
 * Complementa a los mapas Leaflet, no los reemplaza: en una proyección plana
 * el Anillo de Fuego queda partido por el antimeridiano y las zonas polares
 * exageradas, que es justo lo que una esfera resuelve sin trucos.
 *
 * Se monta SIEMPRE con next/dynamic y ssr:false (ver app/(app)/globe/page.tsx):
 * three.js toca `window` en tiempo de import y romper el render del servidor
 * es garantizado, no probable.
 */

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import Globe, { type GlobeMethods } from 'react-globe.gl';

import {
  eventsToPoints,
  globePointId,
  plateBoundariesToPaths,
  pointRadius,
  ringColorInterpolator,
  ringMaxRadius,
  ringRepeatPeriod,
  type GlobePath,
  type GlobePoint,
} from '@/lib/globe-data';
import type { GlobeFocus } from '@/lib/area-view-bounds';
import type { SeismicEvent } from '@/lib/types';

/**
 * Cartel HTML anclado a una coordenada del globo (capa htmlElementsData).
 *
 * `render` fabrica el nodo cada vez que el spotlight cambia — el dueño del
 * contenido es quien lo pasa (la landing arma su infocard ahí), este
 * componente sólo lo ancla a la esfera y lo mueve con ella.
 */
export interface GlobeSpotlight {
  lat: number;
  lng: number;
  render: () => HTMLElement;
}

interface SeismicGlobeProps {
  eventos: SeismicEvent[];
  /** Se muestran las placas tectónicas. Default: true. */
  showPlates?: boolean;
  /**
   * Se muestran los controles de zoom/reset. Default: true. La landing lo
   * apaga: ahí el globo es escenografía, no herramienta de análisis.
   */
  showControls?: boolean;
  /**
   * Rotación automática. Default: true. La landing lo apaga cuando el
   * visitante pidió prefers-reduced-motion: la rotación continua es
   * exactamente el tipo de movimiento que esa preferencia quiere evitar.
   */
  autoRotate?: boolean;
  /**
   * Política de rotación (pedido del usuario 2026-08-22).
   *
   * - 'continuous': gira siempre (comportamiento histórico, y el de la
   *   landing donde el globo es escenografía).
   * - 'on-event': queda QUIETO y gira sólo un momento cuando llega un sismo
   *   nuevo, como reacción visible. Así el movimiento pasa a significar algo
   *   —"acaba de entrar un evento"— en vez de ser decoración permanente que
   *   además arrastra fuera de la vista lo que uno está mirando.
   *
   * Default: 'continuous' para no cambiarle el comportamiento a la landing
   * ni a los llamadores existentes; /globe lo pone en 'on-event'.
   */
  rotationPolicy?: 'continuous' | 'on-event';
  /**
   * Cambia cada vez que llega un sismo nuevo (basta con un contador o el id
   * del último evento). Sólo se usa con `rotationPolicy: 'on-event'`: cada
   * cambio de este valor dispara un pulso de rotación.
   */
  eventPulse?: string | number | null;
  /**
   * Zoom con la rueda del mouse / pinch. Default: true. La landing lo apaga:
   * con enableZoom activo OrbitControls hace preventDefault del wheel sobre
   * el canvas, y como ahí el globo ocupa toda la pantalla, la página queda
   * imposible de scrollear con rueda. Desactivado, el wheel atraviesa el
   * canvas y la página scrollea normal; arrastrar para rotar sigue andando.
   */
  enableZoom?: boolean;
  /**
   * Altitud inicial de cámara, en radios de globo. Sin definir, queda la
   * default de react-globe.gl (2.5, globo completo con margen). La landing
   * usa ~1.35: la esfera llena la pantalla y los epicentros se ven grandes.
   */
  initialAltitude?: number;
  /**
   * Multiplicador del radio de puntos y anillos. Default: 1 (la escala
   * calibrada para el dashboard). La landing lo sube: a pantalla completa y
   * de un vistazo, un M5 tiene que verse desde la otra punta del living.
   */
  pointScale?: number;
  /**
   * Cartel destacado anclado al globo. Al cambiar, la cámara gira hacia la
   * coordenada manteniendo la altitud actual (no pelea con initialAltitude).
   * Se anima sólo si autoRotate está activo: autoRotate apagado significa
   * prefers-reduced-motion, y ahí el salto sin animación es lo correcto.
   */
  spotlight?: GlobeSpotlight | null;
  /**
   * Color y grosor del halo atmosférico. Defaults = los de react-globe.gl,
   * así el dashboard no cambia. La landing usa un teal más presente: el
   * scattering marcado es puro impacto visual en el hero.
   */
  atmosphereColor?: string;
  atmosphereAltitude?: number;
  /** Alto del canvas en píxeles. */
  height?: number;
  /** Se avisa al padre qué evento se clickeó, o null al deseleccionar. */
  onSelectEvent?: (evento: SeismicEvent | null) => void;
  /**
   * Se avisa al padre el id del evento clickeado (sin la semántica de
   * deselección de `onSelectEvent`: siempre lleva el id, nunca null). Lo usa
   * la cartelera para setear el spotlight al clickear un punto del globo.
   */
  onEventClick?: (eventId: string) => void;
  /** Id del evento enfocado. El globo gira hacia él y frena la rotación. */
  selectedEventId?: string | null;
  /**
   * Centro y altitud del área activa. Gana sobre `selectedEventId`: cambiar de
   * área es una acción explícita del usuario y no debería quedar tapada por un
   * evento que ya estaba enfocado.
   */
  focusArea?: GlobeFocus | null;
}

/**
 * Velocidad de rotación automática.
 *
 * Lenta a propósito: el globo gira para mostrar que hay datos del otro lado,
 * no para animar. A más de ~0.5 marea y hace imposible apuntar a un punto.
 */
const AUTO_ROTATE_SPEED = 0.35;

/**
 * Cuánto gira el globo al llegar un sismo, con `rotationPolicy: 'on-event'`.
 *
 * 4 s a AUTO_ROTATE_SPEED es poco más de un grado y medio de arco: alcanza
 * para que el ojo registre "algo se movió" sin que la escena se vaya de
 * lugar. Más largo y vuelve a ser la rotación continua que este modo evita.
 */
const EVENT_ROTATION_PULSE_MS = 4_000;

/**
 * Duración del giro hacia un evento, en ms.
 *
 * Se anima en vez de saltar: un corte seco a la otra punta del globo hace
 * perder la referencia de dónde se estaba mirando.
 */
const FOCUS_TRANSITION_MS = 900;

/**
 * Altitud de cámara al enfocar, en radios de globo.
 *
 * Acerca sin llegar a tapar el contexto: se quiere ver el evento Y la fosa que
 * tiene al lado, que es la mitad de la razón para mirar esto en una esfera.
 */
const FOCUS_ALTITUDE = 1.6;

/**
 * Rango de altitud para zoom manual y factor de paso por click.
 *
 * El mínimo no llega a 1 (superficie): a esa distancia three-globe empieza a
 * recortar el near plane y el globo se ve por dentro. El máximo es bastante
 * más que MAX_AREA_ALTITUDE (2.8) para que zoom-out siga teniendo margen
 * incluso partiendo de la vista más alejada que produce un área.
 */
const MIN_ZOOM_ALTITUDE = 0.5;
const MAX_ZOOM_ALTITUDE = 4;
const ZOOM_STEP_FACTOR = 0.7;
const ZOOM_TRANSITION_MS = 300;

export function SeismicGlobe({
  eventos,
  showPlates = true,
  showControls = true,
  autoRotate = true,
  rotationPolicy = 'continuous',
  eventPulse = null,
  enableZoom = true,
  initialAltitude,
  pointScale = 1,
  spotlight = null,
  atmosphereColor = 'lightskyblue',
  atmosphereAltitude = 0.15,
  height = 600,
  onSelectEvent,
  onEventClick,
  selectedEventId = null,
  focusArea = null,
}: SeismicGlobeProps) {
  const t = useTranslations('globe');
  const globeRef = useRef<GlobeMethods | undefined>(undefined);
  const [plates, setPlates] = useState<GlobePath[]>([]);
  const [width, setWidth] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  // El canvas de WebGL no es responsive por CSS: necesita ancho en píxeles y
  // hay que recalcularlo a mano cuando cambia el contenedor.
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const update = () => setWidth(element.clientWidth);
    update();

    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Mismo archivo que usa AdvancedSeismicMap: un solo dataset de placas para
  // los dos, así no divergen (tener dos mapas desincronizados ya costó un bug).
  useEffect(() => {
    if (!showPlates) return;
    let cancelled = false;

    fetch('/geo/plate-boundaries.json')
      .then((res) => res.json())
      .then((geojson) => {
        if (!cancelled) setPlates(plateBoundariesToPaths(geojson));
      })
      .catch(() => {
        // Las placas son contexto visual: si fallan, el globo sigue mostrando
        // los eventos, que es el dato que importa.
        if (!cancelled) setPlates([]);
      });

    return () => {
      cancelled = true;
    };
  }, [showPlates]);

  // A diferencia del foco de evento (que frena la rotación mientras el panel
  // sigue abierto), el foco de área es una animación de paso: acompaña el
  // giro hacia la zona elegida y devuelve la rotación libre apenas termina.
  // Si no fuera así, como siempre hay un área activa (hay preset por
  // defecto), el globo quedaría frenado para siempre después del primer
  // foco. `isAreaAnimating` vive el mismo tiempo que la transición de
  // pointOfView; no hay callback de "terminó" en react-globe.gl.
  const [isAreaAnimating, setIsAreaAnimating] = useState(false);

  // Pulso de rotación en curso (sólo con rotationPolicy: 'on-event').
  const [isPulsing, setIsPulsing] = useState(false);

  // Los controles de órbita viven fuera de React: se configuran sobre la
  // instancia imperativa que expone react-globe.gl.
  //
  // `selectedEventId`/`isAreaAnimating` están en las dependencias porque la
  // rotación se frena mientras hay algo enfocado: sin esa dependencia el
  // efecto corre una sola vez y el globo sigue girando bajo el panel abierto,
  // llevándose de la vista justo lo que se quiso mirar.
  useEffect(() => {
    const globe = globeRef.current;
    if (!globe) return;

    const controls = globe.controls();
    // Con 'on-event' el reposo es NO girar: sólo rota durante el pulso que
    // dispara un sismo nuevo. Con 'continuous' manda el comportamiento
    // histórico. En los dos casos el foco y la animación de área frenan la
    // rotación, para no llevarse de la vista justo lo que se quiso mirar.
    const wantsRotation =
      rotationPolicy === 'on-event' ? isPulsing : true;
    controls.autoRotate =
      autoRotate && wantsRotation && selectedEventId === null && !isAreaAnimating;
    controls.autoRotateSpeed = AUTO_ROTATE_SPEED;
    controls.enableDamping = true;
    controls.enableZoom = enableZoom;
  }, [
    width,
    selectedEventId,
    isAreaAnimating,
    autoRotate,
    enableZoom,
    rotationPolicy,
    isPulsing,
  ]);

  // Pulso de rotación al llegar un sismo (rotationPolicy: 'on-event').
  //
  // `isPulsing` es ESTADO y no un ref: el efecto de los controles de arriba
  // tiene que volver a correr cuando el pulso arranca y cuando termina, y un
  // ref no dispara re-render. Es la trampa documentada del proyecto —un
  // efecto que lee un ref sin tenerlo en deps corre una vez y nunca más—,
  // acá evitada publicando el pulso como estado.
  useEffect(() => {
    if (rotationPolicy !== 'on-event') return;
    // Sin evento todavía (montaje) no se pulsa: el globo arranca quieto.
    if (eventPulse === null || eventPulse === undefined) return;

    setIsPulsing(true);
    const timer = setTimeout(() => setIsPulsing(false), EVENT_ROTATION_PULSE_MS);
    return () => {
      clearTimeout(timer);
      // Si llega otro sismo antes de que termine el pulso anterior, este
      // cleanup corre y el efecto vuelve a arrancarlo: el pulso se extiende
      // en vez de cortarse a la mitad.
    };
  }, [eventPulse, rotationPolicy]);

  // Los labels del canvas se arman en lib pura con los strings YA traducidos
  // por parámetro (Decision 5): `t` en las deps regenera los puntos —y sus
  // tooltips— al cambiar de idioma.
  const points = useMemo(
    () => eventsToPoints(eventos, { unknownLocation: t('unknownLocation') }),
    [eventos, t],
  );

  // Acerca la cámara apenas el canvas existe. Corre también si cambia el
  // ancho (resize): pointOfView() con sólo altitude preserva lat/lng, así
  // que re-fijarla no pelea con la rotación ni con el arrastre del usuario.
  useEffect(() => {
    const globe = globeRef.current;
    if (!globe || width === 0 || initialAltitude === undefined) return;

    globe.pointOfView({ altitude: initialAltitude }, 0);
  }, [width, initialAltitude]);

  // Gira la cámara hacia el spotlight preservando la altitud actual: es un
  // recorrido cinematográfico, no un zoom. Cede ante el foco explícito de
  // evento/área (acciones del usuario > coreografía automática).
  useEffect(() => {
    const globe = globeRef.current;
    if (!globe || !spotlight || selectedEventId || isAreaAnimating) return;

    const { altitude } = globe.pointOfView();
    globe.pointOfView(
      { lat: spotlight.lat, lng: spotlight.lng, altitude },
      autoRotate ? FOCUS_TRANSITION_MS : 0,
    );
  }, [spotlight, selectedEventId, isAreaAnimating, autoRotate]);

  // Gira la cámara hacia el área activa. Gana sobre el foco de evento: cambiar
  // de área es la acción más reciente del usuario, y el padre ya cierra el
  // panel de evento cuando esto pasa (ver GlobeView), así que no compiten de
  // hecho — pero el orden de los efectos igual documenta la prioridad.
  useEffect(() => {
    const globe = globeRef.current;
    if (!globe || !focusArea) return;

    setIsAreaAnimating(true);
    globe.pointOfView(focusArea, FOCUS_TRANSITION_MS);

    const timer = setTimeout(() => setIsAreaAnimating(false), FOCUS_TRANSITION_MS);
    return () => clearTimeout(timer);
  }, [focusArea]);

  // Gira la cámara hacia el evento enfocado.
  //
  // Se busca el punto en `points` y no en `eventos` porque points ya descartó
  // los que no tienen coordenadas usables: apuntar la cámara a un evento sin
  // lat/lon la mandaría a (0,0) sin que nadie entienda por qué.
  //
  // `isAreaAnimating` (no `focusArea`) es la condición de exclusión: focusArea
  // queda no-null para siempre en cuanto hay área activa, así que usarlo acá
  // bloquearía el foco de evento permanentemente. Lo que importa es no pisar
  // la animación de área MIENTRAS ocurre, no para siempre.
  useEffect(() => {
    const globe = globeRef.current;
    if (!globe || !selectedEventId || isAreaAnimating) return;

    const target = points.find((p) => p.id === selectedEventId);
    if (!target) return;

    globe.pointOfView(
      { lat: target.lat, lng: target.lng, altitude: FOCUS_ALTITUDE },
      FOCUS_TRANSITION_MS,
    );
  }, [selectedEventId, points, isAreaAnimating]);

  // Índice de id de punto al evento original: globe.gl entrega el punto que
  // dibujó, no el evento del que salió.
  const eventsById = useMemo(() => {
    const index = new Map<string, SeismicEvent>();
    for (const evento of eventos) index.set(globePointId(evento), evento);
    return index;
  }, [eventos]);

  // Clickear el punto ya enfocado lo deselecciona: es la forma de cerrar el
  // panel sin ir hasta la X y de devolverle la rotación al globo.
  const handlePointClick = useCallback(
    (point: object) => {
      const { id } = point as GlobePoint;
      const evento = eventsById.get(id);
      if (!evento) return;

      onSelectEvent?.(id === selectedEventId ? null : evento);
      onEventClick?.(id);
    },
    [eventsById, onSelectEvent, onEventClick, selectedEventId],
  );

  // Zoom manual: reusa la posición actual de pointOfView() y sólo cambia la
  // altitud, para no perder de dónde se estaba mirando al acercar/alejar.
  const zoom = useCallback((factor: number) => {
    const globe = globeRef.current;
    if (!globe) return;

    const current = globe.pointOfView();
    const altitude = Math.min(
      MAX_ZOOM_ALTITUDE,
      Math.max(MIN_ZOOM_ALTITUDE, current.altitude * factor),
    );

    globe.pointOfView({ altitude }, ZOOM_TRANSITION_MS);
  }, []);

  const handleZoomIn = useCallback(() => zoom(ZOOM_STEP_FACTOR), [zoom]);
  const handleZoomOut = useCallback(() => zoom(1 / ZOOM_STEP_FACTOR), [zoom]);

  // Reset vuelve al área activa si hay una, o a una vista neutral del globo
  // completo si todavía no cargó ninguna (usuario anónimo sin sesión, por ej).
  const handleResetView = useCallback(() => {
    const globe = globeRef.current;
    if (!globe) return;

    setIsAreaAnimating(true);
    globe.pointOfView(focusArea ?? { lat: 0, lng: 0, altitude: 2.5 }, FOCUS_TRANSITION_MS);
    setTimeout(() => setIsAreaAnimating(false), FOCUS_TRANSITION_MS);
  }, [focusArea]);

  return (
    <div ref={containerRef} className="relative w-full overflow-hidden rounded-xl">
      {width > 0 && showControls && (
        <div className="absolute right-3 top-3 z-10 flex flex-col gap-1">
          <button
            type="button"
            onClick={handleZoomIn}
            aria-label={t('zoomIn')}
            className="flex h-8 w-8 items-center justify-center rounded-lg border-2 border-gray-300 bg-background/80 text-lg leading-none backdrop-blur transition-colors hover:bg-muted/60 dark:border-gray-700"
          >
            +
          </button>
          <button
            type="button"
            onClick={handleZoomOut}
            aria-label={t('zoomOut')}
            className="flex h-8 w-8 items-center justify-center rounded-lg border-2 border-gray-300 bg-background/80 text-lg leading-none backdrop-blur transition-colors hover:bg-muted/60 dark:border-gray-700"
          >
            −
          </button>
          <button
            type="button"
            onClick={handleResetView}
            aria-label={t('resetView')}
            className="flex h-8 w-8 items-center justify-center rounded-lg border-2 border-gray-300 bg-background/80 text-xs backdrop-blur transition-colors hover:bg-muted/60 dark:border-gray-700"
          >
            ⟲
          </button>
        </div>
      )}
      {width > 0 && (
        <Globe
          ref={globeRef}
          width={width}
          height={height}
          // Fondo transparente para que tome el color de la página y funcione
          // igual en tema claro y oscuro.
          backgroundColor="rgba(0,0,0,0)"
          // Textura servida desde /public, no desde unpkg: es un asset de
          // runtime y depender de un CDN de terceros significa que el globo se
          // ve negro cuando ese CDN falla. El archivo viene con three-globe
          // (dependencia de react-globe.gl), así que copiarlo no agrega fuentes.
          globeImageUrl="/textures/earth-night.jpg"
          atmosphereColor={atmosphereColor}
          atmosphereAltitude={atmosphereAltitude}
          // Los eventos van en la capa de labels, no en la de points: points
          // dibuja cilindros 3D SIEMPRE y por más baja que sea la altura la
          // pared se ve al acercarse ("cilindros verticales cortos", feedback
          // del usuario). El dot del label sí es un disco plano conformado a
          // la esfera, como los circleMarker del mapa 2D. Sin texto: la
          // magnitud se lee por tamaño, color y el pulso de abajo.
          labelsData={points}
          labelLat={(d) => (d as GlobePoint).lat}
          labelLng={(d) => (d as GlobePoint).lng}
          labelText={() => ''}
          labelColor={(d) => (d as GlobePoint).color}
          labelDotRadius={(d) => pointRadius((d as GlobePoint).magnitude) * pointScale}
          labelAltitude={0.002}
          labelLabel={(d: object) => (d as GlobePoint).label}
          onLabelClick={handlePointClick}
          // Pulso expandiéndose desde cada epicentro: radio y frecuencia
          // escalan con la magnitud, así un M7 llama la atención antes que un
          // M3 aun con el globo girando. Reusa `points`: misma fuente que los
          // discos, no puede divergir.
          ringsData={points}
          ringLat={(d) => (d as GlobePoint).lat}
          ringLng={(d) => (d as GlobePoint).lng}
          ringColor={(d: object) => ringColorInterpolator((d as GlobePoint).color)}
          ringMaxRadius={(d) => ringMaxRadius((d as GlobePoint).magnitude) * pointScale}
          ringPropagationSpeed={(d) =>
            (ringMaxRadius((d as GlobePoint).magnitude) * pointScale) / 2.5
          }
          ringRepeatPeriod={(d) => ringRepeatPeriod((d as GlobePoint).magnitude)}
          // Cartel del spotlight: un solo elemento HTML anclado a la esfera.
          // Sin transición de posición — el cartel se recrea al cambiar de
          // evento, no se desliza de un sismo al otro.
          htmlElementsData={spotlight ? [spotlight] : []}
          htmlLat={(d) => (d as GlobeSpotlight).lat}
          htmlLng={(d) => (d as GlobeSpotlight).lng}
          htmlElement={(d: object) => (d as GlobeSpotlight).render()}
          htmlAltitude={0.015}
          htmlTransitionDuration={0}
          pathsData={plates}
          pathPoints={(d) => (d as GlobePath).coords}
          pathPointLat={(p) => (p as [number, number])[0]}
          pathPointLng={(p) => (p as [number, number])[1]}
          pathColor={(d: object) => (d as GlobePath).color}
          pathStroke={0.5}
          // Sin animación de dibujado: con ~900 segmentos de placas, animarlos
          // hace que el globo tarde varios segundos en verse completo.
          pathTransitionDuration={0}
        />
      )}
    </div>
  );
}

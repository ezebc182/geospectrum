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

interface SeismicGlobeProps {
  eventos: SeismicEvent[];
  /** Se muestran las placas tectónicas. Default: true. */
  showPlates?: boolean;
  /** Alto del canvas en píxeles. */
  height?: number;
  /** Se avisa al padre qué evento se clickeó, o null al deseleccionar. */
  onSelectEvent?: (evento: SeismicEvent | null) => void;
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
  height = 600,
  onSelectEvent,
  selectedEventId = null,
  focusArea = null,
}: SeismicGlobeProps) {
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
    controls.autoRotate = selectedEventId === null && !isAreaAnimating;
    controls.autoRotateSpeed = AUTO_ROTATE_SPEED;
    controls.enableDamping = true;
  }, [width, selectedEventId, isAreaAnimating]);

  const points = useMemo(() => eventsToPoints(eventos), [eventos]);

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
    },
    [eventsById, onSelectEvent, selectedEventId],
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
      {width > 0 && (
        <div className="absolute right-3 top-3 z-10 flex flex-col gap-1">
          <button
            type="button"
            onClick={handleZoomIn}
            aria-label="Acercar"
            className="flex h-8 w-8 items-center justify-center rounded-lg border-2 border-gray-300 bg-background/80 text-lg leading-none backdrop-blur transition-colors hover:bg-muted/60 dark:border-gray-700"
          >
            +
          </button>
          <button
            type="button"
            onClick={handleZoomOut}
            aria-label="Alejar"
            className="flex h-8 w-8 items-center justify-center rounded-lg border-2 border-gray-300 bg-background/80 text-lg leading-none backdrop-blur transition-colors hover:bg-muted/60 dark:border-gray-700"
          >
            −
          </button>
          <button
            type="button"
            onClick={handleResetView}
            aria-label="Restablecer vista"
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
          labelDotRadius={(d) => pointRadius((d as GlobePoint).magnitude)}
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
          ringMaxRadius={(d) => ringMaxRadius((d as GlobePoint).magnitude)}
          ringPropagationSpeed={(d) => ringMaxRadius((d as GlobePoint).magnitude) / 2.5}
          ringRepeatPeriod={(d) => ringRepeatPeriod((d as GlobePoint).magnitude)}
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

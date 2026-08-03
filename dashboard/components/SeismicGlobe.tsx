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
  type GlobePath,
  type GlobePoint,
} from '@/lib/globe-data';
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

export function SeismicGlobe({
  eventos,
  showPlates = true,
  height = 600,
  onSelectEvent,
  selectedEventId = null,
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

  // Los controles de órbita viven fuera de React: se configuran sobre la
  // instancia imperativa que expone react-globe.gl.
  //
  // `selectedEventId` está en las dependencias porque la rotación se frena
  // mientras hay un evento enfocado: sin esa dependencia el efecto corre una
  // sola vez y el globo sigue girando bajo el panel abierto, llevándose de la
  // vista justo el evento que se quiso mirar.
  useEffect(() => {
    const globe = globeRef.current;
    if (!globe) return;

    const controls = globe.controls();
    controls.autoRotate = selectedEventId === null;
    controls.autoRotateSpeed = AUTO_ROTATE_SPEED;
    controls.enableDamping = true;
  }, [width, selectedEventId]);

  const points = useMemo(() => eventsToPoints(eventos), [eventos]);

  // Gira la cámara hacia el evento enfocado.
  //
  // Se busca el punto en `points` y no en `eventos` porque points ya descartó
  // los que no tienen coordenadas usables: apuntar la cámara a un evento sin
  // lat/lon la mandaría a (0,0) sin que nadie entienda por qué.
  useEffect(() => {
    const globe = globeRef.current;
    if (!globe || !selectedEventId) return;

    const target = points.find((p) => p.id === selectedEventId);
    if (!target) return;

    globe.pointOfView(
      { lat: target.lat, lng: target.lng, altitude: FOCUS_ALTITUDE },
      FOCUS_TRANSITION_MS,
    );
  }, [selectedEventId, points]);

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

  return (
    <div ref={containerRef} className="w-full overflow-hidden rounded-xl">
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
          pointsData={points}
          pointLat={(d) => (d as GlobePoint).lat}
          pointLng={(d) => (d as GlobePoint).lng}
          pointColor={(d) => (d as GlobePoint).color}
          pointAltitude={(d) => (d as GlobePoint).altitude}
          pointRadius={0.28}
          pointLabel={(d) => (d as GlobePoint).label}
          onPointClick={handlePointClick}
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

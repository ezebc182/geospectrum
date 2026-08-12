/**
 * Hook que encapsula driver.js para el tour de onboarding (Decision 7).
 *
 * driver.js es vanilla JS que manipula el DOM directamente: el módulo se
 * carga con import dinámico (client-only) para que nunca se evalúe durante
 * SSR ni engorde el bundle inicial del shell. El CSS sí se importa estático:
 * es inerte y Next lo extrae sin problema.
 *
 * Distinción fin vs cierre: driver.js 1.8 dispara `onDestroyed` tanto al
 * terminar ("Listo" en el último paso) como al cerrar (X, Escape, click en el
 * overlay). El hook recibe el estado PRE-reset en opts.state (verificado en
 * el source de la 1.8.0), así que `activeIndex === último paso` distingue
 * "terminó" de "cerró antes". Cerrar con la X en el último paso cuenta como
 * fin — inofensivo: para el gate ambos caminos persisten el onboarding.
 */

'use client';

import { useCallback, useEffect, useRef } from 'react';

import 'driver.js/dist/driver.css';
import type { Driver } from 'driver.js';

import { TOUR_STEPS } from './tour-steps';

type DriverFactory = typeof import('driver.js').driver;

export interface TourHandlers {
  /** El usuario llegó al final del tour y apretó "Listo". */
  onFinish: () => void;
  /** El usuario cerró el tour antes de terminarlo (X, Escape u overlay). */
  onClose: () => void;
}

export function useTour() {
  const factoryRef = useRef<DriverFactory | null>(null);
  const driverRef = useRef<Driver | null>(null);
  // Al desmontar el componente que corre el tour (navegación, logout) el
  // destroy de limpieza NO debe disparar onClose: eso es abandono, no un
  // cierre explícito del usuario, y el abandono no persiste nada (spec).
  const suppressCallbacksRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    // Precarga del módulo. Si startTour() corre antes de que resuelva, ahí
    // se vuelve a hacer await del mismo import (el cache de módulos dedupea).
    import('driver.js')
      .then((mod) => {
        if (!cancelled) factoryRef.current = mod.driver;
      })
      .catch(() => {
        // Sin red para el chunk: startTour() reintenta y falla ruidoso allá.
      });

    return () => {
      cancelled = true;
      suppressCallbacksRef.current = true;
      driverRef.current?.destroy();
      driverRef.current = null;
    };
  }, []);

  const startTour = useCallback(async ({ onFinish, onClose }: TourHandlers) => {
    const factory = factoryRef.current ?? (await import('driver.js')).driver;

    // Nunca dos tours a la vez; el destroy del anterior no debe reportar
    // cierre (es un reemplazo interno, no una acción del usuario).
    if (driverRef.current) {
      suppressCallbacksRef.current = true;
      driverRef.current.destroy();
    }
    suppressCallbacksRef.current = false;

    const instance = factory({
      steps: TOUR_STEPS,
      showProgress: true,
      progressText: '{{current}} de {{total}}',
      nextBtnText: 'Siguiente',
      prevBtnText: 'Anterior',
      doneBtnText: 'Listo',
      // Resiliencia: si un ancla no está en el DOM (p. ej. AreaSelector no
      // renderiza cuando /areas falló), el paso se saltea en vez de romper.
      skipMissingElement: true,
      onDestroyed: (_element, _step, opts) => {
        driverRef.current = null;
        if (suppressCallbacksRef.current) return;
        // opts.state es el estado previo al reset: activeIndex del último
        // paso mostrado. En el último índice = terminó; antes = cerró.
        if (opts.state.activeIndex === TOUR_STEPS.length - 1) {
          onFinish();
        } else {
          onClose();
        }
      },
    });

    driverRef.current = instance;
    instance.drive();
  }, []);

  return { startTour };
}

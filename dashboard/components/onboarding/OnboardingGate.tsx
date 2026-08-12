/**
 * Gate del onboarding (email-invitations, Decision 6/7): montado en el layout
 * de `(app)`, decide si el wizard aparece.
 *
 * Fuente de verdad: `GET /auth/me` con `onboarding_completed_at` leído de la
 * BASE (nunca del JWT — dato mutable). `null` = onboarding pendiente.
 *
 * Contrato de persistencia (spec):
 * - Completar el tour O saltarlo → `POST /auth/me/onboarding-complete` y el
 *   wizard se desmonta. El endpoint es idempotente.
 * - Si ese POST falla, el wizard se cierra IGUAL en esta sesión — nunca
 *   bloqueante; a lo sumo reaparece en el próximo login.
 * - Abandono (cerrar la pestaña, sesión expirada) no persiste nada: el
 *   wizard vuelve a ofrecerse.
 */

'use client';

import { useCallback, useEffect, useState } from 'react';

import { completeOnboarding, getMe } from '@/lib/auth';

import { OnboardingWizard } from './OnboardingWizard';

export function OnboardingGate() {
  const [showWizard, setShowWizard] = useState(false);

  useEffect(() => {
    let cancelled = false;

    // Fetch propio en vez de leer useAuth(): el provider tipa `user` como
    // UserPublic (login no devuelve onboarding_completed_at) y castearlo
    // sería apostar a un shape que el tipo no garantiza. Es un PK lookup —
    // costo despreciable frente a la fragilidad del cast.
    getMe()
      .then((me) => {
        if (!cancelled && me !== null && me.onboarding_completed_at === null) {
          setShowWizard(true);
        }
      })
      .catch(() => {
        // Error de red al decidir el gate: no se muestra nada. El wizard no
        // es crítico y volverá a evaluarse en el próximo mount del shell.
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const handleFinished = useCallback(() => {
    // Primero desmonta, después persiste: la UX nunca espera a la red y un
    // fallo del POST no reabre nada (best-effort, spec "La falla del endpoint
    // de persistencia no bloquea al usuario").
    setShowWizard(false);
    completeOnboarding().catch(() => {
      // Queda pendiente en el backend: el wizard reaparecerá en el próximo
      // login, que es exactamente el comportamiento especificado.
    });
  }, []);

  if (!showWizard) return null;

  return <OnboardingWizard onFinished={handleFinished} />;
}

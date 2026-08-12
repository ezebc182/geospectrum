/**
 * Wizard de onboarding del primer login (email-invitations, Decision 7).
 *
 * Dos pasos en un Dialog (patrón ui/ existente) + tour driver.js:
 *   1. Bienvenida + nombre — persiste vía el PATCH de perfil existente
 *      (`updateProfile()`/`full_name`), con prefill si ya hay valor.
 *   2. Área de interés inicial — reusa AreaSelector (AOI-1) tal cual.
 *   Después cierra el modal y lanza el tour sobre la página real.
 *
 * Idempotencia (spec): re-entrar con datos ya cargados no duplica nada — el
 * nombre viene prefilled y solo se PATCHea si cambió; el área es la misma
 * preferencia de siempre (setActiveArea pisa, no acumula).
 *
 * "Saltar" está visible en TODO momento y converge con terminar el tour:
 * ambos llaman onFinished() y el gate persiste el onboarding. Cerrar el
 * Dialog con la X o Escape también cuenta como saltar (es una dismissal
 * explícita del usuario; el "abandono" que NO persiste es cerrar la pestaña).
 */

'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { AreaSelector } from '@/components/AreaSelector';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { getProfile, updateProfile } from '@/lib/auth';
import { emitAreaChanged } from '@/lib/area-events';

import { useTour } from './useTour';

/** Pausa entre cerrar el Dialog y arrancar el tour: le da tiempo a Radix a
 * desmontar overlay y liberar el scroll lock del body — arrancar driver.js
 * con el lock todavía puesto deja el overlay del tour sin interacción. */
const TOUR_START_DELAY_MS = 250;

interface OnboardingWizardProps {
  /** El flujo terminó por cualquier camino explícito (tour completo, saltar,
   * cierre del modal): el gate persiste y desmonta. El abandono (cerrar la
   * pestaña) NO pasa por acá — nada se persiste, el wizard vuelve. */
  onFinished: () => void;
}

export function OnboardingWizard({ onFinished }: OnboardingWizardProps) {
  const t = useTranslations('onboarding');
  const router = useRouter();
  const { startTour } = useTour();

  const [step, setStep] = useState<1 | 2>(1);
  const [dialogOpen, setDialogOpen] = useState(true);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  // Valor con el que se prefilló: si el usuario no lo cambió, no hay nada que
  // PATCHear (idempotencia barata — re-entrar no re-escribe el perfil).
  const initialNameRef = useRef('');

  useEffect(() => {
    let cancelled = false;

    // Prefill del nombre desde el perfil extendido. Si falla (red, 401 en
    // carrera), el input arranca vacío: molesto pero no bloqueante.
    getProfile()
      .then((profile) => {
        if (cancelled) return;
        const fullName = profile.full_name ?? '';
        initialNameRef.current = fullName;
        setName(fullName);
      })
      .catch(() => {
        // Sin prefill; el paso sigue funcionando.
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const handleSkip = () => {
    setDialogOpen(false);
    onFinished();
  };

  const handleStep1Next = async () => {
    const trimmed = name.trim();
    // Vacío o sin cambios = no tocar el perfil: el PATCH parcial existente no
    // debe recibir un null que borre un nombre ya guardado por otro lado.
    if (trimmed === '' || trimmed === initialNameRef.current) {
      setStep(2);
      return;
    }

    setSaving(true);
    setSaveError(false);
    try {
      await updateProfile({ full_name: trimmed });
      initialNameRef.current = trimmed;
      setStep(2);
    } catch {
      // Se queda en el paso 1 con el error visible: el usuario puede
      // reintentar o directamente saltar — nunca queda trabado.
      setSaveError(true);
    } finally {
      setSaving(false);
    }
  };

  const handleStartTour = () => {
    setDialogOpen(false);
    window.setTimeout(() => {
      // Terminar el tour y cerrarlo antes de tiempo convergen: ambos son un
      // final explícito del flujo y el gate persiste el onboarding.
      void startTour({ onFinish: onFinished, onClose: onFinished });
    }, TOUR_START_DELAY_MS);
  };

  return (
    <Dialog
      open={dialogOpen}
      onOpenChange={(open) => {
        // Solo dispara por interacción del usuario (X, Escape, overlay) —
        // los cierres programáticos de arriba no pasan por acá.
        if (!open) handleSkip();
      }}
    >
      <DialogContent className="sm:max-w-md">
        {step === 1 ? (
          <>
            <DialogHeader>
              <DialogTitle>{t('welcomeTitle')}</DialogTitle>
              <DialogDescription>{t('welcomeDescription')}</DialogDescription>
            </DialogHeader>

            <div className="space-y-2">
              <label htmlFor="onboarding-name" className="text-sm font-medium">
                {t('nameLabel')}
              </label>
              <Input
                id="onboarding-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={t('namePlaceholder')}
                autoComplete="name"
                disabled={saving}
              />
              {saveError && (
                <p role="alert" className="text-sm text-destructive">
                  {t('nameSaveError')}
                </p>
              )}
            </div>

            <DialogFooter>
              <Button variant="ghost" onClick={handleSkip} disabled={saving}>
                {t('skip')}
              </Button>
              <Button onClick={handleStep1Next} disabled={saving}>
                {saving ? t('saving') : t('continue')}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{t('areaTitle')}</DialogTitle>
              <DialogDescription>{t('areaDescription')}</DialogDescription>
            </DialogHeader>

            <div className="flex justify-center py-2">
              {/* Mismo refresco que AreaHeader: el evento avisa a los datos de
                  cliente (SWR) y router.refresh() a lo que rinda el servidor. */}
              <AreaSelector
                onAreaChange={() => {
                  emitAreaChanged();
                  router.refresh();
                }}
              />
            </div>

            <DialogFooter>
              <Button variant="ghost" onClick={handleSkip}>
                {t('skip')}
              </Button>
              <Button onClick={handleStartTour}>{t('startTour')}</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

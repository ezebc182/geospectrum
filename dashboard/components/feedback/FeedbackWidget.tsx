'use client';

/**
 * Widget flotante de feedback para beta testers (change feedback-beta-testers,
 * design Decision 8). Se monta UNA vez en `app/(app)/layout.tsx`: lo global va
 * en el layout, no página por página.
 *
 * - El contexto (ruta, URL completa, user agent) se captura EN EL SUBMIT y se
 *   trunca a los límites del backend (300/2000/400): es metadata defensiva,
 *   mejor un UA recortado que un 422 que se come el reporte.
 * - El body NUNCA se trunca: el `maxLength` del textarea y la validación local
 *   lo acotan; si igual excede, se bloquea el envío con indicación visible.
 * - Estados `idle → open → sending → sent | error`; en `error` el texto se
 *   conserva y el submit funciona como reintento. El resultado se guarda como
 *   DATO (`outcome.kind`), no como string traducido (patrón UsersPanel), para
 *   que un cambio de idioma en caliente no deje texto viejo.
 * - Tras el 201 revalida la key del tablero (`mutate(FEEDBACK_SWR_KEY)`): si
 *   `/feedback` está montado la tarjeta aparece en Nuevo; si no, es un no-op.
 *   El widget NO navega solo: ofrece un link y el tester decide.
 */

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useSWRConfig } from 'swr';
import { MessageSquarePlus } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ApiStatusError } from '@/lib/auth';
import { FEEDBACK_SWR_KEY, submitFeedback, type FeedbackType } from '@/lib/feedback';
import { cn } from '@/lib/utils';

/** Límites espejo de los CHECK de la migración 019 y de los Field de Pydantic. */
const MAX_BODY = 2000;
const MAX_ROUTE = 300;
const MAX_URL = 2000;
const MAX_USER_AGENT = 400;

const FEEDBACK_TYPES: readonly FeedbackType[] = ['bug', 'suggestion'];

type Phase = 'idle' | 'open' | 'sending' | 'sent' | 'error';

/** Resultado del último envío fallido, como dato: la traducción ocurre al
 * renderizar. `status: null` cubre fallo de red (sin respuesta HTTP). */
type Outcome = { kind: 'failed'; status: number | null } | { kind: 'sessionExpired' };

// Clases del `ui/input.tsx` adaptadas a un textarea (no existe ui/textarea.tsx
// y no se agrega un primitivo para un solo uso).
const TEXTAREA_CLASS =
  'min-h-28 w-full min-w-0 resize-y rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40';

export function FeedbackWidget() {
  const t = useTranslations('feedback.widget');
  const pathname = usePathname();
  const { mutate } = useSWRConfig();

  const [phase, setPhase] = React.useState<Phase>('idle');
  const [type, setType] = React.useState<FeedbackType>('bug');
  const [body, setBody] = React.useState('');
  const [outcome, setOutcome] = React.useState<Outcome | null>(null);
  // Guardia sincrónica contra el doble click: el estado `sending` se aplica
  // en el próximo render, el ref se aplica YA.
  const inFlightRef = React.useRef(false);

  const isOpen = phase !== 'idle';
  const isSending = phase === 'sending';
  const isBlank = body.trim().length === 0;
  const isTooLong = body.length > MAX_BODY;

  const handleOpenChange = (open: boolean) => {
    if (open) {
      setPhase('open');
      return;
    }
    // Cerrar no borra el texto: si el tester cerró sin enviar, lo recupera al
    // reabrir. El formulario solo se vacía tras un 201.
    setPhase('idle');
    setOutcome(null);
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (inFlightRef.current) return;
    // El body NO se trunca: si excede el tope se bloquea el envío y el
    // textarea queda marcado como inválido con el contador en rojo.
    if (isBlank || isTooLong) return;

    inFlightRef.current = true;
    setPhase('sending');
    setOutcome(null);

    // Captura del contexto EN EL SUBMIT, no al abrir: la URL de una vista de
    // análisis cambia con cada ajuste de ventana.
    const payload = {
      type,
      body,
      route: pathname.slice(0, MAX_ROUTE),
      url: window.location.href.slice(0, MAX_URL),
      user_agent: navigator.userAgent.slice(0, MAX_USER_AGENT),
    };

    try {
      const created = await submitFeedback(payload);
      if (created === null) {
        // 401: la sesión venció. No hay confirmación posible; el texto se queda.
        setOutcome({ kind: 'sessionExpired' });
        setPhase('error');
        return;
      }
      setBody('');
      setType('bug');
      setPhase('sent');
      void mutate(FEEDBACK_SWR_KEY);
    } catch (err) {
      setOutcome({ kind: 'failed', status: err instanceof ApiStatusError ? err.status : null });
      setPhase('error');
    } finally {
      inFlightRef.current = false;
    }
  };

  const submitLabel = isSending ? t('sending') : phase === 'error' ? t('retry') : t('submit');

  return (
    <>
      <Button
        type="button"
        size="icon-lg"
        aria-label={t('button')}
        title={t('button')}
        onClick={() => handleOpenChange(true)}
        // z-[1050]: por encima de los panes de Leaflet (z-[1000]) y por debajo
        // de los overlays de Radix (z-[1100]) para que el dialog lo tape.
        className="fixed right-6 bottom-6 z-[1050] rounded-full shadow-lg"
      >
        <MessageSquarePlus />
      </Button>

      <Dialog open={isOpen} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('title')}</DialogTitle>
            {/* Honestidad sobre lo capturado: qué viaja con el reporte. */}
            <DialogDescription>{t('contextNotice')}</DialogDescription>
          </DialogHeader>

          {phase === 'sent' ? (
            <div className="flex flex-col gap-3" role="status">
              <p className="text-sm font-medium">{t('sent')}</p>
              <DialogFooter>
                <Button asChild variant="outline">
                  <Link href="/feedback">{t('viewBoard')}</Link>
                </Button>
                <Button type="button" onClick={() => handleOpenChange(false)}>
                  {t('close')}
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <form className="flex flex-col gap-3" onSubmit={handleSubmit} noValidate>
              <div role="radiogroup" aria-label={t('typeLabel')} className="flex gap-2">
                {FEEDBACK_TYPES.map((option) => (
                  <Button
                    key={option}
                    type="button"
                    role="radio"
                    aria-checked={type === option}
                    variant={type === option ? 'default' : 'outline'}
                    size="sm"
                    disabled={isSending}
                    onClick={() => setType(option)}
                  >
                    {t(`types.${option}`)}
                  </Button>
                ))}
              </div>

              <div className="flex flex-col gap-1">
                <textarea
                  value={body}
                  onChange={(event) => setBody(event.target.value)}
                  maxLength={MAX_BODY}
                  placeholder={t('placeholder')}
                  aria-label={t('placeholder')}
                  aria-invalid={isTooLong || undefined}
                  disabled={isSending}
                  className={TEXTAREA_CLASS}
                />
                <p
                  className={cn('text-right text-xs', isTooLong ? 'text-destructive' : 'text-muted-foreground')}
                  aria-live="polite"
                >
                  {t('counter', { count: String(body.length), max: String(MAX_BODY) })}
                </p>
                {isTooLong && <p className="text-xs text-destructive">{t('tooLong')}</p>}
              </div>

              {/* Aviso de transparencia: dicho ANTES de enviar (riesgo del proposal). */}
              <p className="text-xs text-muted-foreground">{t('visibilityNotice')}</p>

              {phase === 'error' && outcome && (
                <p className="text-sm text-destructive" role="alert">
                  {outcome.kind === 'sessionExpired' ? t('sessionExpired') : t('error')}
                </p>
              )}

              <DialogFooter>
                <Button type="submit" disabled={isSending || isBlank} aria-busy={isSending || undefined}>
                  {submitLabel}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

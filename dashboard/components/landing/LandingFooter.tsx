/**
 * Footer de la landing: marca, navegación, fuentes de datos y alta a la beta.
 *
 * El form postea al endpoint público /beta-signups. Anti-spam del lado del
 * cliente: el input oculto `website` es un honeypot — está fuera de la vista
 * y del orden de tabulación, ningún humano lo completa; un bot que rellena
 * todo, sí. El backend descarta en silencio los payloads con ese campo lleno
 * (ver src/models/beta.py) y además rate-limita por IP.
 */

'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Activity, CheckCircle2, Loader2 } from 'lucide-react';

import { signupBeta } from '@/lib/api';
import { toAppLocale } from '@/lib/locale';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

type FormStatus = 'idle' | 'sending' | 'success' | 'invalid' | 'error';

/**
 * Validación mínima de forma en el cliente: algo@algo.algo. La validación
 * real (EmailStr) vive en el backend — esto sólo evita el round-trip para
 * el error obvio y da feedback inmediato.
 */
function looksLikeEmail(value: string): boolean {
  return /^\S+@\S+\.\S+$/.test(value);
}

export function LandingFooter() {
  const t = useTranslations('landing.footer');
  // Locale activo de la landing → viaja en el POST de beta: el backend lo
  // persiste (Fase 1) y de ahí sale el idioma del email de confirmación,
  // de la invitación y de la aprobación (cadena beta→invitación→emails).
  const locale = toAppLocale(useLocale());
  const [email, setEmail] = useState('');
  const [website, setWebsite] = useState(''); // honeypot
  const [status, setStatus] = useState<FormStatus>('idle');

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const trimmed = email.trim();
    if (!looksLikeEmail(trimmed)) {
      setStatus('invalid');
      return;
    }

    setStatus('sending');
    try {
      await signupBeta(trimmed, website, locale);
      setStatus('success');
    } catch {
      // 429 (rate limit) y 5xx terminan igual acá: el mensaje pide
      // reintentar más tarde, que es la acción correcta en ambos casos.
      setStatus('error');
    }
  }

  return (
    <footer className="border-t border-border">
      <div className="mx-auto grid max-w-6xl gap-12 px-6 py-16 md:grid-cols-[2fr_1fr_1fr_2fr]">
        {/* Marca */}
        <div>
          <p className="flex items-center gap-2">
            <Activity className="h-5 w-5 text-primary" aria-hidden="true" />
            <span className="font-heading text-lg font-semibold">GeoSpectrum</span>
          </p>
          <p className="mt-3 max-w-xs text-sm leading-relaxed text-muted-foreground">
            {t('tagline')}
          </p>
        </div>

        {/* Producto */}
        <nav aria-label={t('productColumn')}>
          <h2 className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
            {t('productColumn')}
          </h2>
          <ul className="mt-4 space-y-3 text-sm">
            <li>
              <a
                href="#como-funciona"
                className="text-foreground/80 transition-colors hover:text-foreground"
              >
                {t('linkHow')}
              </a>
            </li>
            <li>
              <a
                href="#capacidades"
                className="text-foreground/80 transition-colors hover:text-foreground"
              >
                {t('linkFeatures')}
              </a>
            </li>
            <li>
              <Link
                href="/login"
                className="text-foreground/80 transition-colors hover:text-foreground"
              >
                {t('linkLogin')}
              </Link>
            </li>
          </ul>
        </nav>

        {/* Datos */}
        <div>
          <h2 className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
            {t('dataColumn')}
          </h2>
          <ul className="mt-4 space-y-3 font-mono text-xs text-muted-foreground">
            <li>{t('sources')}</li>
            <li>{t('coverage')}</li>
            <li>{t('history')}</li>
          </ul>
        </div>

        {/* Beta */}
        <div>
          <h2 className="font-heading text-base font-semibold">{t('beta.title')}</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            {t('beta.subtitle')}
          </p>

          {status === 'success' ? (
            <p
              className="mt-4 flex items-center gap-2 text-sm text-primary"
              role="status"
            >
              <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
              {t('beta.success')}
            </p>
          ) : (
            <form onSubmit={handleSubmit} className="mt-4" noValidate>
              {/* Honeypot: invisible y fuera del tab order. aria-hidden para
                  que tampoco lo anuncie un screen reader. */}
              <div className="absolute -left-[9999px] top-auto" aria-hidden="true">
                <label htmlFor="beta-website">Website</label>
                <input
                  id="beta-website"
                  type="text"
                  name="website"
                  tabIndex={-1}
                  autoComplete="off"
                  value={website}
                  onChange={(e) => setWebsite(e.target.value)}
                />
              </div>

              <div className="flex flex-col gap-2 sm:flex-row">
                <div className="flex-1">
                  <label htmlFor="beta-email" className="sr-only">
                    {t('beta.emailLabel')}
                  </label>
                  <Input
                    id="beta-email"
                    type="email"
                    name="email"
                    inputMode="email"
                    autoComplete="email"
                    required
                    placeholder={t('beta.placeholder')}
                    value={email}
                    onChange={(e) => {
                      setEmail(e.target.value);
                      if (status === 'invalid') setStatus('idle');
                    }}
                    aria-invalid={status === 'invalid'}
                    aria-describedby={
                      status === 'invalid' || status === 'error'
                        ? 'beta-feedback'
                        : undefined
                    }
                    className="min-h-11"
                  />
                </div>
                <Button
                  type="submit"
                  disabled={status === 'sending'}
                  className="min-h-11 shrink-0"
                >
                  {status === 'sending' ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                      {t('beta.sending')}
                    </>
                  ) : (
                    t('beta.button')
                  )}
                </Button>
              </div>

              {(status === 'invalid' || status === 'error') && (
                <p
                  id="beta-feedback"
                  role="alert"
                  className="mt-2 text-sm text-destructive"
                >
                  {status === 'invalid'
                    ? t('beta.invalid')
                    : t('beta.error')}
                </p>
              )}
            </form>
          )}
        </div>
      </div>

      <div className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-2 px-6 py-6 text-xs text-muted-foreground md:flex-row">
          <p>{t('legal')}</p>
          <p className="font-mono">{t('sources')}</p>
        </div>
      </div>
    </footer>
  );
}

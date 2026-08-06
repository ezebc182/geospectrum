/**
 * Wrapper client de la landing: es el dueño del locale.
 *
 * El estado inicial es 'es' fijo (no detectLandingLocale()) a propósito: el
 * HTML del servidor se renderiza una sola vez y detectar el idioma durante el
 * render inicial del cliente produciría un mismatch de hidratación para los
 * visitantes en inglés. Se detecta post-hydration en un efecto — el flash de
 * español para un visitante anglo es de un frame y es el costo de no partir
 * el routing en rutas [locale] por una sola página.
 */

'use client';

import { useCallback, useEffect, useState } from 'react';

import {
  LANDING_COPY,
  detectLandingLocale,
  storeLandingLocale,
  type LandingLocale,
} from '@/lib/landing-i18n';
import { LandingHero } from '@/components/landing/LandingHero';
import { LandingSections } from '@/components/landing/LandingSections';
import { LandingFooter } from '@/components/landing/LandingFooter';

export function LandingContent() {
  const [locale, setLocale] = useState<LandingLocale>('es');

  useEffect(() => {
    setLocale(detectLandingLocale());
  }, []);

  const toggleLocale = useCallback(() => {
    setLocale((current) => {
      const next: LandingLocale = current === 'es' ? 'en' : 'es';
      storeLandingLocale(next);
      return next;
    });
  }, []);

  const copy = LANDING_COPY[locale];

  return (
    <>
      <LandingHero copy={copy} locale={locale} onToggleLocale={toggleLocale} />
      <LandingSections copy={copy} />
      <LandingFooter copy={copy} />
    </>
  );
}

/**
 * Wrapper client de la landing: es el dueño del TOGGLE de idioma.
 *
 * El locale ya no vive acá (i18n-dashboard, Fase 7): lo resuelve la cascada
 * server-side de i18n/request.ts (cookie NEXT_LOCALE → Accept-Language →
 * 'es') y los hijos consumen useTranslations directo. El toggle escribe la
 * cookie común y hace router.refresh() — la misma mecánica que el switcher
 * del dashboard — así la elección hecha en la landing se propaga a /login y
 * al resto de la app sin re-elegir. La vieja preferencia de
 * localStorage['landing-locale'] NO se migra (Decision 3, pérdida aceptada):
 * la primera visita post-deploy re-detecta por Accept-Language.
 */

'use client';

import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale } from 'next-intl';

import { setLocaleCookie, toAppLocale } from '@/lib/locale';
import { LandingHero } from '@/components/landing/LandingHero';
import { LandingSections } from '@/components/landing/LandingSections';
import { LandingFooter } from '@/components/landing/LandingFooter';

export function LandingContent() {
  const router = useRouter();
  // useLocale() da el locale de FORMATO (es-AR/en-US); se colapsa al
  // identificador de app para calcular el destino del toggle.
  const locale = toAppLocale(useLocale());

  const toggleLocale = useCallback(() => {
    setLocaleCookie(locale === 'es' ? 'en' : 'es');
    router.refresh();
  }, [locale, router]);

  return (
    <>
      <LandingHero onToggleLocale={toggleLocale} />
      <LandingSections />
      <LandingFooter />
    </>
  );
}

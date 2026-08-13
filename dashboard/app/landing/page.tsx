/**
 * Landing pública de geospectrum.org.
 *
 * Nunca se navega directamente: el middleware hace rewrite de `/` sin sesión
 * hacia acá (la URL del navegador queda en `/`). Con sesión, `/` sigue siendo
 * el dashboard. Ver middleware.ts.
 *
 * Dark-only a propósito: el wrapper fuerza la clase `dark` sin importar el
 * tema elegido por next-themes, porque el visitante anónimo no tiene tema y
 * la identidad "sala de control" (globals.css) está pensada sobre fondo
 * oscuro — el globo con la textura nocturna sobre fondo claro se ve flotando.
 */

import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { LandingContent } from '@/components/landing/LandingContent';

// Metadata según el locale de la cascada server-side (antes era Metadata
// estática en español — el <title> del tab es superficie user-facing).
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('landing.meta');
  return { title: t('title'), description: t('description') };
}

export default function LandingPage() {
  return (
    <div className="dark min-h-dvh bg-background text-foreground">
      <LandingContent />
    </div>
  );
}

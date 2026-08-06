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

import { LandingContent } from '@/components/landing/LandingContent';

export const metadata: Metadata = {
  title: 'GeoSpectrum — Monitoreo sísmico global en tiempo real',
  description:
    'Sismos de todo el planeta en un globo 3D en vivo: ingesta continua de USGS, EMSC e INPRES, detección de enjambres, espectrogramas y alertas sobre sus áreas de interés.',
};

export default function LandingPage() {
  return (
    <div className="dark min-h-dvh bg-background text-foreground">
      <LandingContent />
    </div>
  );
}

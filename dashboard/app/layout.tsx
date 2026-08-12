import type { Metadata } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale } from 'next-intl/server';
import { Familjen_Grotesk, IBM_Plex_Sans, JetBrains_Mono } from 'next/font/google';
import './globals.css';
import { Providers } from './providers';
import { cn } from '@/lib/utils';

const fontHeading = Familjen_Grotesk({
  subsets: ['latin'],
  variable: '--font-heading',
});
const fontSans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-sans',
});
const fontMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
});

export const metadata: Metadata = {
  title: 'GeoSpectrum Dashboard',
  description: 'Real-time seismic monitoring with USGS and INPRES integration',
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Locale de formato (es-AR/en-US) resuelto por la cascada de
  // i18n/request.ts — reemplaza el lang="es" hardcodeado.
  const locale = await getLocale();

  return (
    <html
      lang={locale}
      suppressHydrationWarning
      className={cn(fontHeading.variable, fontSans.variable, fontMono.variable)}
    >
      <body className="font-sans antialiased">
        {/* El provider de mensajes va POR FUERA de Providers (Decision 1):
            los diccionarios no dependen de theme/auth/tooltip. Sin props:
            hereda locale, messages y formats del request config server. */}
        <NextIntlClientProvider>
          <Providers>{children}</Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}

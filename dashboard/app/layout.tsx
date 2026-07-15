import type { Metadata } from 'next';
import { Familjen_Grotesk, IBM_Plex_Sans, JetBrains_Mono } from 'next/font/google';
import './globals.css';
import { Providers } from './providers';
import { AppSidebar } from '@/components/AppSidebar';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { Separator } from '@/components/ui/separator';
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

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="es"
      suppressHydrationWarning
      className={cn(fontHeading.variable, fontSans.variable, fontMono.variable)}
    >
      <body className="font-sans antialiased">
        <Providers>
          <SidebarProvider>
            <AppSidebar />
            <SidebarInset>
              <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4">
                <SidebarTrigger />
                <Separator orientation="vertical" className="h-5" />
                <span className="font-data text-xs text-muted-foreground">
                  Estación de monitoreo · Región Andes AR/CL
                </span>
              </header>
              <main className="flex-1 px-4 py-8 sm:px-6 lg:px-8">{children}</main>
            </SidebarInset>
          </SidebarProvider>
        </Providers>
      </body>
    </html>
  );
}

/**
 * Índice de estaciones.
 *
 * Antes de esta página, `/stations/[channel]` sólo era alcanzable desde una
 * etiqueta chiquita sobre el canvas de un espectrograma —y sólo cuando el
 * metadata traía `channel`—, así que en la práctica había que saberse la URL
 * de memoria. Esta es la puerta de entrada que faltaba.
 */

import { getTranslations } from 'next-intl/server';

import { StationSearch } from '@/components/StationSearch';

export default async function StationsPage() {
  const t = await getTranslations('stations');

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 p-4 md:p-6">
      <header>
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </header>
      <StationSearch />
    </div>
  );
}

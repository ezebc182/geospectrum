/**
 * Área activa en el header del shell: etiqueta + selector.
 *
 * Vive en el LAYOUT y no en una página porque el área de interés es global de
 * la aplicación — condiciona lo que muestran el dashboard, /live, el explorador
 * y el análisis por igual. Tenerlo en una sola pantalla obligaba a ir hasta
 * /live para cambiarlo y dejaba al resto del dashboard mostrando otra región.
 *
 * Reemplaza al literal "Región Andes AR/CL" que estaba hardcodeado en el
 * header: decía Andes aunque el backend estuviera sirviendo otra área.
 *
 * Al cambiar de área se recarga la ruta actual (router.refresh() + un evento
 * propio): los datos cuelgan de SWR en cada página, y sin la señal se quedarían
 * mostrando la región anterior hasta el próximo refresco automático.
 */

'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { AreaSelector } from '@/components/AreaSelector';
import { emitAreaChanged } from '@/lib/area-events';

export function AreaHeader() {
  const t = useTranslations('areas');
  const router = useRouter();

  const handleAreaChange = () => {
    // El evento es para los datos de cliente (SWR); router.refresh() es para lo
    // que renderice el servidor. Hacen falta los dos: ninguno cubre al otro.
    emitAreaChanged();
    router.refresh();
  };

  return (
    <div className="flex items-center gap-2">
      <span className="font-data text-xs text-muted-foreground">
        {t('monitoringStation')}
      </span>
      <AreaSelector onAreaChange={handleAreaChange} />
    </div>
  );
}

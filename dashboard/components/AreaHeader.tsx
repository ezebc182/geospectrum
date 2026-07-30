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

import { AreaSelector } from '@/components/AreaSelector';

/**
 * Nombre del evento que avisa "cambió el área activa". Las páginas que tengan
 * datos dependientes del área lo escuchan y revalidan (ver /live).
 */
export const AREA_CHANGED_EVENT = 'geospectrum:area-changed';

export function AreaHeader() {
  const router = useRouter();

  const handleAreaChange = () => {
    window.dispatchEvent(new CustomEvent(AREA_CHANGED_EVENT));
    router.refresh();
  };

  return (
    <div className="flex items-center gap-2">
      <span className="font-data text-xs text-muted-foreground">
        Estación de monitoreo
      </span>
      <AreaSelector onAreaChange={handleAreaChange} />
    </div>
  );
}

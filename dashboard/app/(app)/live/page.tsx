/**
 * /live se fusionó con el Dashboard (2026-08-05): eran dos vistas casi
 * iguales por debajo del mismo /report, con un mapa más pobre acá
 * (SeismicMapWithCities, sin capas ni sync tabla→mapa). El control de
 * cadencia de refresco que era exclusivo de esta página ahora vive en el
 * Dashboard. Se mantiene la ruta como redirect para no romper links/favoritos
 * viejos.
 */
import { redirect } from 'next/navigation';

export default function LivePage() {
  redirect('/');
}

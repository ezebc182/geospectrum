import Script from 'next/script';

// UserWay es un OVERLAY de accesibilidad: se monta encima de la página y
// ofrece ajustes al visitante (tamaño de texto, contraste, guía de lectura).
// No corrige el markup de abajo. O sea: complementa el trabajo real de
// accesibilidad —HTML semántico, nombres accesibles, orden de foco,
// contraste— pero no lo reemplaza.

// ID de cuenta de UserWay, opcional. Al ser NEXT_PUBLIC_*, Next la inlinea en
// el bundle del cliente durante el build: viaja al navegador y cualquiera
// puede leerla desde el código fuente de la página. Es PÚBLICA por
// construcción (de hecho el snippet oficial la pone en un atributo HTML a la
// vista), así que no hay secreto que proteger acá; la var existe para poder
// separar preview de producción y para apagar el widget SIN tocar código.
// Ausente o vacía, el componente no renderiza nada: ni etiqueta `<script>` ni
// pedido a cdn.userway.org (dev local y tests no necesitan configurar nada).
const USERWAY_ACCOUNT = process.env.NEXT_PUBLIC_USERWAY_ACCOUNT?.trim() || '';

/**
 * Carga el widget de accesibilidad de UserWay en todo el sitio.
 *
 * Va en el layout raíz, así que corre en la landing pública, en el login y en
 * el dashboard autenticado.
 */
export function UserWayWidget() {
  if (!USERWAY_ACCOUNT) return null;

  return (
    <Script
      src="https://cdn.userway.org/widget.js"
      data-account={USERWAY_ACCOUNT}
      // `afterInteractive`: el widget es de terceros y no participa del
      // primer pintado, así que no tiene por qué competir con el JS de la app
      // por el ancho de banda de la carga inicial. Tampoco sirve
      // `lazyOnload` (esperaría al onload de TODA la página): el botón de
      // accesibilidad tiene que estar disponible apenas la página responde,
      // porque es justamente lo primero que busca quien lo necesita.
      strategy="afterInteractive"
    />
  );
}

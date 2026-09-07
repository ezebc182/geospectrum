/**
 * Widget de accesibilidad de UserWay, opcional por variable de entorno.
 *
 * Lo que se protege acá es la AUSENCIA: sin `NEXT_PUBLIC_USERWAY_ACCOUNT` no
 * se tiene que inyectar NINGÚN `<script>`. Un `data-account="undefined"` no
 * rompe el build ni los tipos: pega igual contra cdn.userway.org en cada
 * carga de cada pantalla del sitio, con una cuenta que no existe, y eso sólo
 * se ve en la pestaña de red del navegador.
 *
 * La var se lee a nivel de módulo, así que cada rama necesita su propio
 * `vi.resetModules()` + import dinámico: un import estático arriba dejaría
 * clavado el valor del primer test (mismo patrón que lib/map-layers.test.ts).
 *
 * `next/script` SE MOCKEA, y conviene decir por qué. Sin mock funciona en
 * este jsdom (la estrategia `afterInteractive` appendea un `<script>` real a
 * `document.body`), pero `loadScript()` mantiene un `ScriptCache` global por
 * `src` en el scope del módulo: la segunda vez que se monta la misma URL sale
 * temprano y NO appendea nada. Ese caché vive dentro de `node_modules`, así
 * que `vi.resetModules()` no lo limpia —verificado con una sonda: montaje 1
 * inyecta 1 script, montaje 2 tras el reset inyecta 0—. O sea: sin mock, del
 * segundo test en adelante las aserciones medirían el caché de Next, no el
 * componente.
 *
 * El mock renderiza un `<script>` de verdad con las props que recibe, que es
 * exactamente el contrato que este componente tiene que cumplir: qué `src`,
 * qué `data-account` y qué `strategy` le pasa a next/script. La carga en sí
 * es responsabilidad de Next y no se testea acá.
 */

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const SRC = 'https://cdn.userway.org/widget.js';

// Doble de next/script: vuelca las props a un <script> real del DOM, para que
// las aserciones miren atributos y no llamadas a un spy. `strategy` no es un
// atributo HTML válido, así que viaja como data-strategy.
vi.mock('next/script', () => ({
  default: ({ src, strategy, ...rest }: { src: string; strategy?: string } & Record<string, unknown>) => (
    <script src={src} data-strategy={strategy} {...rest} />
  ),
}));

/** Selecciona los scripts de UserWay que quedaron en el documento. */
function scriptsDeUserWay(): HTMLScriptElement[] {
  return Array.from(document.querySelectorAll<HTMLScriptElement>(`script[src="${SRC}"]`));
}

/**
 * Importa el componente fresco con la var puesta (o borrada si es `undefined`).
 *
 * El `resetModules()` va ANTES del import porque el módulo lee la env var a
 * nivel de módulo: sin reset, la primera rama que se ejecute queda clavada
 * para todo el archivo.
 */
async function importarConCuenta(cuenta: string | undefined) {
  vi.resetModules();
  if (cuenta === undefined) {
    delete process.env.NEXT_PUBLIC_USERWAY_ACCOUNT;
  } else {
    process.env.NEXT_PUBLIC_USERWAY_ACCOUNT = cuenta;
  }
  const mod = await import('./UserWayWidget');
  return mod.UserWayWidget;
}

afterEach(() => {
  cleanup();
  delete process.env.NEXT_PUBLIC_USERWAY_ACCOUNT;
  vi.resetModules();
});

describe('UserWayWidget con la cuenta configurada', () => {
  it('inyecta el script con el src y el data-account exactos', async () => {
    const UserWayWidget = await importarConCuenta('6s9F7XAeLa');
    render(<UserWayWidget />);

    const scripts = scriptsDeUserWay();
    expect(scripts).toHaveLength(1);
    expect(scripts[0].getAttribute('src')).toBe(SRC);
    expect(scripts[0].getAttribute('data-account')).toBe('6s9F7XAeLa');
  });

  it('recorta los espacios de la var antes de usarla como cuenta', async () => {
    const UserWayWidget = await importarConCuenta('  6s9F7XAeLa  ');
    render(<UserWayWidget />);

    expect(scriptsDeUserWay()[0].getAttribute('data-account')).toBe('6s9F7XAeLa');
  });

  it('usa la estrategia afterInteractive (no bloquea el render inicial)', async () => {
    const UserWayWidget = await importarConCuenta('6s9F7XAeLa');
    render(<UserWayWidget />);

    expect(scriptsDeUserWay()[0].getAttribute('data-strategy')).toBe('afterInteractive');
  });
});

describe('UserWayWidget sin la cuenta configurada', () => {
  it('sin la var no inyecta NINGÚN script (ni con data-account="undefined")', async () => {
    const UserWayWidget = await importarConCuenta(undefined);
    const { container } = render(<UserWayWidget />);

    expect(scriptsDeUserWay()).toHaveLength(0);
    expect(container.innerHTML).toBe('');
    // Nada del documento apunta a userway.org: ni un pedido de red se dispara.
    expect(document.documentElement.innerHTML).not.toContain('userway.org');
    expect(document.documentElement.innerHTML).not.toContain('undefined');
  });

  it('con la var vacía o en blanco degrada igual que si no estuviera', async () => {
    for (const vacia of ['', '   ', '\t\n']) {
      const UserWayWidget = await importarConCuenta(vacia);
      const { container } = render(<UserWayWidget />);

      expect(scriptsDeUserWay()).toHaveLength(0);
      expect(container.innerHTML).toBe('');
      cleanup();
    }
  });

  it('el componente devuelve null: es seguro montarlo en el layout raíz', async () => {
    const UserWayWidget = await importarConCuenta(undefined);
    expect(UserWayWidget()).toBeNull();
  });
});

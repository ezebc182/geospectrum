/**
 * Contraste del cromo de los paneles de gráfico del dashboard.
 *
 * El bug reportado: `MagnitudeTimeChart` — el molde que copiaron todos los
 * paneles nuevos — hardcodeaba `stroke="#374151"` (grilla) y `stroke="#9ca3af"`
 * (ejes). Son valores FIJOS: iguales en claro y en oscuro. En oscuro quedan
 * gris medio sobre casi-negro y no se leen.
 *
 * Este test mira el FUENTE de cada panel, no el render: las props de cromo se
 * pierden en los mocks de Recharts de los otros archivos (`XAxis: () => null`),
 * así que assertear el DOM no probaría nada. Lo que se prohíbe es la causa
 * raíz — un hex fijo en cualquier atributo de cromo — de modo que el test
 * falla ante CUALQUIER panel nuevo que vuelva a copiar el molde viejo.
 *
 * Los colores que CODIFICAN dato (magnitud, profundidad, series) quedan
 * fuera: esos son escala semántica, no cromo, y siguen siendo hex a propósito.
 *
 * ## Cómo elige los archivos: descubrimiento, no whitelist
 *
 * Antes había un array literal con los cinco paneles de la Fase 5, resuelto con
 * `join(__dirname, archivo)`. Doble defecto: (a) un panel nuevo quedaba afuera
 * hasta que alguien se acordara de agregarlo al array, y (b) `__dirname` es
 * `components/analytics/`, así que los dos paneles heredados que viven un nivel
 * arriba (`components/`) eran INALCANZABLES aunque se los nombrara —
 * `readFileSync` habría tirado ENOENT.
 *
 * El criterio ahora es por contenido, sobre DOS raíces explícitas:
 *
 *   raíces      = components/ y components/analytics/  (no recursivo: son dos
 *                 niveles conocidos)
 *   candidatos  = ficheros con extensión .tsx, excluyendo los .test.tsx
 *   filtro      = el fuente importa `recharts`
 *   piso        = el conjunto debe tener al menos PISO_CONOCIDO archivos
 *
 * `import.meta.dirname` y no `__dirname`: es la forma ESM nativa y no depende
 * del shim de interop CJS que inyecta Vite. `import.meta.glob` no sirve acá —
 * es una transformación de build de un plugin de Vite y `vitest.config.ts` no
 * carga ninguno, así que llega `undefined` en runtime.
 *
 * ## Cada caso recibe DOS valores: etiqueta y ruta. No son intercambiables.
 *
 * `PANELES` son pares `[etiqueta, rutaAbsoluta]`, así que todo `it.each` los
 * desestructura como `(archivo, ruta)`: `archivo` es para el MENSAJE de error y
 * `ruta` es lo único que puede ir a `readFileSync`. Pasarle la etiqueta —
 * `fuente(archivo)` — tira `ENOENT: open 'analytics/TremorPanel.tsx'`, porque
 * la etiqueta lleva el prefijo del directorio pero es relativa al cwd, no una
 * ruta real. Ya pasó: una copia mal pegada de los dos casos de tooltip y grises
 * duplicó los bloques con la firma `(archivo)` y dejó 14 de 44 en rojo.
 *
 * ## Filo conocido: esto protege por ADYACENCIA LITERAL, no por semántica
 *
 * `CROMO_HEX` matchea un hex PEGADO a un atributo de cromo (`stroke="#..."`,
 * `color: '#...'`). Es una regla de texto: no puede saber si ese hex es cromo
 * (grilla, ejes, tooltip → debe tematizarse) o DATO (escala de magnitud, de
 * profundidad, umbrales de severidad → debe quedarse fijo).
 *
 * Consecuencia práctica para el próximo panel: si escribís un hex de DATO
 * pegado al atributo, este test te va a marcar un falso positivo. El patrón
 * para convivir —ya usado por `TremorPanel.THRESHOLD_COLOR`,
 * `MagnitudeTimeChart.M5_THRESHOLD_COLOR` y
 * `DepthDistributionChart.DEPTH_BIN_COLORS`— es hoistear el valor a una
 * constante de módulo con nombre y usarla como `stroke={LA_CONSTANTE}`. No es
 * un truco para esquivar el test: el nombre es justamente lo que documenta que
 * ese color codifica dato y no cromo.
 *
 * Relajar el regex para tolerar hex de dato NO es la salida: debilitaría la
 * regla para los siete paneles con tal de acomodar dos, y reintroduciría por la
 * ventana la lista de excepciones que este archivo vino a eliminar.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/** Los dos directorios donde viven los paneles de gráfico. */
const ANALYTICS_DIR = import.meta.dirname;
const COMPONENTS_DIR = join(import.meta.dirname, '..');

/**
 * Piso de archivos descubiertos. Sin él, un criterio roto que devuelva `[]`
 * dejaría la suite en VERDE con cero paneles cubiertos — el modo de fallo
 * exacto que este archivo viene a cerrar (ya pasó una vez: la whitelist estaba
 * verde sin proteger ninguno de los dos paneles heredados). Es la diferencia
 * entre un test que protege y uno que no puede fallar.
 *
 * 7 = los 5 paneles de `components/analytics/` + `MagnitudeTimeChart.tsx` y
 * `DepthDistributionChart.tsx` de `components/`. Si se agrega un panel nuevo,
 * este número puede subir; nunca debe bajar sin borrar un panel de verdad.
 */
const PISO_CONOCIDO = 7;

/**
 * Atributos que son CROMO (chrome) y por lo tanto tienen que ser tematizados.
 * `fill` NO entra: en Cell/Bar/Scatter codifica dato.
 */
const CROMO_HEX = /(?:stroke|backgroundColor|borderColor|color)\s*[=:]\s*['"]#[0-9a-fA-F]{3,8}['"]/g;

/**
 * Descubre los paneles: pares `[etiqueta, rutaAbsoluta]`. La etiqueta lleva el
 * directorio (`analytics/BValueChart.tsx` vs `MagnitudeTimeChart.tsx`) para que
 * el nombre del caso de `it.each` sea inequívoco si dos directorios llegan a
 * tener homónimos.
 */
function descubrirPaneles(): Array<[string, string]> {
  const raices: Array<[string, string]> = [
    ['', COMPONENTS_DIR],
    ['analytics/', ANALYTICS_DIR],
  ];

  return raices.flatMap(([prefijo, dir]) =>
    readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.tsx') && !e.name.endsWith('.test.tsx'))
      .map((e): [string, string] => [`${prefijo}${e.name}`, join(dir, e.name)])
      .filter(([, ruta]) => /from 'recharts'/.test(readFileSync(ruta, 'utf8'))),
  );
}

const PANELES = descubrirPaneles();

function fuente(ruta: string): string {
  return readFileSync(ruta, 'utf8');
}

describe('cromo de los paneles de analytics', () => {
  it('descubre al menos los paneles conocidos', () => {
    const etiquetas = PANELES.map(([etiqueta]) => etiqueta);

    expect(
      etiquetas.length,
      `el descubrimiento devolvió ${etiquetas.length} archivos (piso ${PISO_CONOCIDO}). ` +
        `Encontrados: ${etiquetas.join(', ') || '(ninguno)'}`,
    ).toBeGreaterThanOrEqual(PISO_CONOCIDO);
  });

  it.each(PANELES)('%s no hardcodea hex en grilla, ejes ni tooltip', (archivo, ruta) => {
    const encontrados = [...fuente(ruta).matchAll(CROMO_HEX)].map((m) => m[0]);

    expect(encontrados, `${archivo} usa cromo fijo que no se adapta al tema oscuro`).toEqual([]);
  });

  it.each(PANELES)('%s consume los tokens compartidos de chart-theme', (archivo, ruta) => {
    expect(fuente(ruta), `${archivo} no importa @/lib/chart-theme`).toMatch(
      /from '@\/lib\/chart-theme'/,
    );
  });

  /**
   * Bug reportado con captura (modo oscuro): las FILAS del tooltip salían en
   * gris oscuro sobre panel oscuro mientras la etiqueta se leía bien.
   *
   * Recharts estila el tooltip por defecto en TRES tramos independientes:
   * `contentStyle` (contenedor), `labelStyle` (etiqueta) e `itemStyle` (cada
   * fila). El `color` de `contentStyle` no cascadea a las filas — a falta de
   * `itemStyle`, Recharts le pinta a cada fila el color de SU serie. Por eso
   * `contentStyle` solo no alcanza y hay que pasar las tres props.
   *
   * Los paneles con `content={...}` propio quedan fuera: ahí el markup es
   * nuestro y ya usa `text-popover-foreground` de Tailwind.
   */
  it.each(PANELES)('%s usa las tres props si estila el tooltip por defecto', (archivo, ruta) => {
    const src = fuente(ruta);
    if (!src.includes('contentStyle')) return; // tooltip con `content` propio

    expect(src, `${archivo} estila el contenedor del tooltip pero no la etiqueta`).toMatch(
      /labelStyle=\{CHART_TOOLTIP_LABEL_STYLE\}/,
    );
    expect(src, `${archivo} estila el contenedor del tooltip pero no las filas`).toMatch(
      /itemStyle=\{CHART_TOOLTIP_ITEM_STYLE\}/,
    );
  });

  /**
   * Un gris de Tailwind SIN pareja `dark:` es el mismo valor en los dos temas,
   * igual que un hex. Medido con la fórmula WCAG contra los tokens reales:
   * `text-gray-400` (#9ca3af) sobre `--popover` da 2,54:1 en claro — falla AA
   * (4,5:1) — aunque en oscuro dé 7,05:1.
   *
   * El par `text-gray-700 dark:text-gray-300` SÍ se adapta y queda fuera: lo
   * que se prohíbe es el gris huérfano, que es el que rompe en un tema.
   */
  it.each(PANELES)('%s no deja grises de Tailwind sin variante dark', (archivo, ruta) => {
    const GRIS = String.raw`text-(?:gray|slate|zinc|neutral|stone)-\d{2,3}`;
    // Solo dentro de listas de clases: un gris NOMBRADO en un comentario que
    // explica el arreglo no es un gris APLICADO, y si contara, el test no
    // podría satisfacerse nunca sin borrar su propia documentación.
    const huerfanos = [...fuente(ruta).matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\}|\{([^}]*)\})/g)]
      .flatMap((m) => {
        const clases = m[1] ?? m[2] ?? m[3] ?? '';
        // La pareja `dark:` vive en el MISMO className.
        if (new RegExp(`dark:(?:${GRIS}|text-white)`).test(clases)) return [];
        return [...clases.matchAll(new RegExp(`(?<!dark:)\\b${GRIS}`, 'g'))].map((g) => g[0]);
      });

    expect(huerfanos, `${archivo} tiene un gris fijo sin variante para oscuro`).toEqual([]);
  });

  it('el borde del tooltip tampoco queda fijo dentro de un string CSS', () => {
    for (const [archivo, ruta] of PANELES) {
      // `border: '1px solid #374151'` esquiva el patrón de atributo suelto.
      expect(fuente(ruta), `${archivo} tiene un borde de tooltip fijo`).not.toMatch(
        /solid\s+#[0-9a-fA-F]{3,8}/,
      );
    }
  });
});

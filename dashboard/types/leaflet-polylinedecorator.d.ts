/**
 * Tipos mínimos para leaflet-polylinedecorator 1.6.0, que no publica los suyos.
 *
 * Declara solo la superficie que usa AdvancedSeismicMap para los dientes de sierra
 * de las zonas de subducción: L.polylineDecorator + L.Symbol.arrowHead. El plugin
 * no exporta nada; extiende el namespace L por efecto secundario al importarse.
 *
 * Sobre la forma de este archivo, que es delicada:
 *  - No debe tener imports/exports de nivel superior: tiene que seguir siendo un
 *    script global para que `declare module 'leaflet-polylinedecorator'` registre
 *    el módulo. Con un import arriba, esa declaración quedaría anidada y el import
 *    del plugin volvería a ser implicit any (TS7016).
 *  - El bloque de abajo aumenta `namespace L`, NO `declare module 'leaflet'`.
 *    Declarar funciones de nivel superior dentro de `declare module 'leaflet'`
 *    reemplaza el módulo en vez de aumentarlo, y borra L.map/L.tileLayer/etc.
 *
 * Ver docs/superpowers/specs/2026-07-27-plate-boundaries-usgs-style-design.md
 */

/** El plugin no exporta nada: se importa por su efecto secundario sobre `L`. */
declare module 'leaflet-polylinedecorator';

declare namespace L {
  interface ArrowHeadOptions {
    /** Tamaño de la punta, en píxeles. */
    pixelSize?: number;
    /** Ángulo de apertura de la punta, en grados. Negativo invierte el sentido. */
    headAngle?: number;
    /** Si es true, dibuja la punta como polígono relleno en vez de dos trazos. */
    polygon?: boolean;
    pathOptions?: Record<string, unknown>;
  }

  /** Instancia opaca de símbolo: solo se pasa de vuelta a polylineDecorator. */
  interface PatternSymbol {
    readonly __brand?: 'leaflet-polylinedecorator-symbol';
  }

  interface Pattern {
    /** Desplazamiento del primer símbolo: píxeles (`10`) o porcentaje (`'5%'`). */
    offset?: number | string;
    /** Separación entre símbolos: píxeles (`40`) o porcentaje (`'10%'`). */
    repeat: number | string;
    symbol: PatternSymbol;
  }

  interface PolylineDecoratorOptions {
    patterns: Pattern[];
  }

  namespace Symbol {
    function arrowHead(options?: ArrowHeadOptions): PatternSymbol;
    function dash(options?: Record<string, unknown>): PatternSymbol;
  }

  function polylineDecorator(paths: unknown, options?: PolylineDecoratorOptions): unknown;
}

/**
 * Escala visual de magnitud con el evento marcado.
 *
 * Reemplaza al link "Ver en el mapa 2D" que había en el panel: ese link
 * llevaba a /explore sin pasarle el evento, así que prometía algo que no
 * cumplía. Una referencia visual dice más —un M5.2 suelto no significa nada
 * para quien no maneja la escala; verlo ubicado entre "moderado" y "fuerte"
 * sí.
 *
 * Se dibuja con un SVG a mano y no con Recharts: es una barra con un marcador,
 * y meter una librería de gráficos para esto agrega peso al bundle sin dar
 * nada a cambio.
 *
 * La escala de magnitud es logarítmica, pero acá se dibuja lineal a propósito:
 * lo que se quiere es ubicar el evento entre categorías nombradas, no comparar
 * energías. Poner la escala real dejaría todo amontonado a la izquierda.
 */

'use client';

import { useTranslations } from 'next-intl';

/** Identificador de tramo: la etiqueta visible sale del diccionario (`globe.scale.bands.<id>`). */
export type MagnitudeBand = 'minor' | 'light' | 'moderate' | 'strong' | 'major';

/**
 * Los cortes son los mismos que `getMagnitudeSeverity` y `getMagnitudeColor`:
 * 3 / 4 / 5 / 6. La leyenda tiene que pintar el mismo sismo del mismo color
 * que su chip.
 *
 * Los colores salen de los tokens `--severity-*` y no de hex sueltos. Hasta el
 * 2026-08-22 estaban hardcodeados y el primer tramo apuntaba a
 * `--color-severity-low`, una variable que no existe: caía siempre al fallback
 * (un verde puro) mientras el token real es un teal. Los otros cuatro ni
 * intentaban leer el token, así que la barra no cambiaba en modo oscuro y el
 * chip de al lado sí.
 */
const TRAMOS: { hasta: number; id: MagnitudeBand; color: string }[] = [
  { hasta: 3, id: 'minor', color: 'hsl(var(--severity-low))' },
  { hasta: 4, id: 'light', color: 'hsl(var(--severity-light))' },
  { hasta: 5, id: 'moderate', color: 'hsl(var(--severity-moderate))' },
  { hasta: 6, id: 'strong', color: 'hsl(var(--severity-high))' },
  { hasta: 8, id: 'major', color: 'hsl(var(--severity-critical))' },
];

/** Extremos de la escala dibujada. Un M2 y un M8 son los bordes útiles. */
const MIN_MAG = 2;
const MAX_MAG = 8;

interface MagnitudeScaleProps {
  magnitude: number;
}

/** Posición del marcador en la barra, 0..100 %. */
function positionPercent(magnitude: number): number {
  const acotada = Math.min(MAX_MAG, Math.max(MIN_MAG, magnitude));
  return ((acotada - MIN_MAG) / (MAX_MAG - MIN_MAG)) * 100;
}

/** Id del tramo en el que cae la magnitud (la etiqueta la traduce el componente). */
export function tramoDe(magnitude: number): MagnitudeBand {
  return TRAMOS.find((t) => magnitude < t.hasta)?.id ?? 'major';
}

export function MagnitudeScale({ magnitude }: MagnitudeScaleProps) {
  const t = useTranslations('globe.scale');
  const left = positionPercent(magnitude);
  const bandLabel = t(`bands.${tramoDe(magnitude)}`);

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between">
        <span className="text-sm text-muted-foreground">{t('title')}</span>
        <span className="text-sm font-medium">{bandLabel}</span>
      </div>

      <div className="relative pt-1">
        {/* Barra de tramos. Los anchos son proporcionales al rango que cubre
            cada categoría, por eso "Mayor" ocupa el doble: va de 6 a 8. */}
        <div
          className="flex h-2 overflow-hidden rounded-full"
          role="img"
          aria-label={t('aria', { magnitude: magnitude.toFixed(1), category: bandLabel })}
        >
          {TRAMOS.map((tramo, i) => {
            const desde = i === 0 ? MIN_MAG : TRAMOS[i - 1].hasta;
            return (
              <div
                key={tramo.id}
                style={{
                  width: `${((tramo.hasta - desde) / (MAX_MAG - MIN_MAG)) * 100}%`,
                  backgroundColor: tramo.color,
                }}
              />
            );
          })}
        </div>

        {/* Marcador del evento. -50% lo centra sobre su posición real. */}
        <div
          className="absolute top-0 flex -translate-x-1/2 flex-col items-center"
          style={{ left: `${left}%` }}
          aria-hidden="true"
        >
          <span className="font-data text-[10px] font-bold leading-none">
            {magnitude.toFixed(1)}
          </span>
          <span className="mt-0.5 h-3 w-0.5 rounded-full bg-foreground" />
        </div>
      </div>

      <div className="flex justify-between text-[10px] text-muted-foreground">
        <span>M{MIN_MAG}</span>
        <span>M{MAX_MAG}+</span>
      </div>
    </div>
  );
}

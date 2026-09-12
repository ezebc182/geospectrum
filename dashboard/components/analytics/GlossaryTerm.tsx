'use client';

/**
 * Disparador de definición del glosario v1: el término se muestra como un botón
 * y su definición vive en un Popover.
 *
 * Por qué Popover y no Tooltip ni HoverCard (Decisión 4 del design): el
 * desempate es TOUCH. `Tooltip` es hover/focus y en touch depende de un
 * long-press inconsistente entre navegadores; `HoverCard` es explícitamente
 * hover-only. Una definición de "b-value" que no se puede abrir con el dedo en
 * un tablet es una feature que no existe para la mitad de los usos de un panel
 * de monitoreo. Además lo que se muestra es un PÁRRAFO, y un párrafo dentro de
 * un tooltip es mal uso de la primitiva.
 *
 * El trigger es un `<button>` REAL (vía `asChild`): Enter/Space abre, Esc
 * cierra, el foco entra al contenido y vuelve al trigger al cerrar. Todo eso lo
 * da Radix; este componente NO lo reimplementa. Un `<span onClick>` perdería
 * las tres cosas de una.
 *
 * El contenido cerrado NO se monta a la fuerza: debe quedar fuera del árbol de
 * accesibilidad, que es el comportamiento por defecto de Radix.
 *
 * Sin `t.rich`: las definiciones son párrafos planos (Decisión 5). Meter markup
 * dentro de la clave obligaría a cada consumidor a pasar los mismos renderers y
 * convertiría el diccionario en código.
 */

import { useTranslations } from 'next-intl';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { GLOSSARY_MESSAGE_KEYS, type GlossaryTermId } from '@/lib/glossary';

type Props = {
  /**
   * Unión CERRADA de los cinco términos: pedir `'sigma_b'` NO COMPILA, no falla
   * en runtime. Es la fricción que se busca — un sexto término es un pedido
   * nuevo, no un `id` más.
   */
  id: GlossaryTermId;
  /** Texto visible del disparador. Por defecto, el término del glosario. */
  label?: string;
};

export function GlossaryTerm({ id, label }: Props) {
  const t = useTranslations('analytics.glossary');
  const clave = GLOSSARY_MESSAGE_KEYS[id];

  const termino = t(`${clave}.term` as 'bValue.term');
  const definicion = t(`${clave}.definition` as 'bValue.definition');

  // `note` es opcional EN EL CONTENIDO: si un término no la necesita, la clave
  // no existe en ninguno de los dos idiomas (`parity.test.ts` lo exige
  // simétrico) y acá no se renderiza el bloque. Un `note: ""` sería basura, no
  // ausencia, y la regla de "ningún valor vacío" de parity ya lo rechaza.
  const claveNota = `${clave}.note` as 'bValue.note';
  const nota = t.has(claveNota) ? t(claveNota) : null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t('trigger', { term: termino })}
          className="cursor-help underline decoration-dotted underline-offset-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {label ?? termino}
        </button>
      </PopoverTrigger>
      <PopoverContent className="space-y-2 text-xs">
        <p className="font-medium text-foreground">{termino}</p>
        <p className="text-muted-foreground">{definicion}</p>
        {nota !== null && <p className="text-muted-foreground">{nota}</p>}
      </PopoverContent>
    </Popover>
  );
}

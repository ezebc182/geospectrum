/**
 * Cromo de los gráficos de /analytics (contraste en claro y oscuro).
 *
 * El molde original (`MagnitudeTimeChart`) hardcodeaba `#374151` para la
 * grilla y `#9ca3af` para los ejes: valores FIJOS, idénticos en claro y en
 * oscuro. En oscuro eso es gris medio sobre casi-negro y no se lee.
 *
 * Se resuelve con los MISMOS tokens HSL que ya usa toda la app
 * (`app/globals.css`, patrón de `MagnitudeScale`): `hsl(var(--token))` viaja
 * como string a Recharts, que lo escupe tal cual al atributo SVG, y el
 * navegador lo resuelve contra la cascada viva. Al cambiar de tema, `.dark`
 * redefine el token y el gráfico se repinta solo — sin `useTheme`, sin
 * branchear en JS y sin re-render.
 *
 * Solo cromo: grilla, ejes, ticks y tooltip. Los colores que CODIFICAN dato
 * (magnitud, profundidad, series) no se tocan — esos son otra escala.
 *
 * Los tokens referenciados existen los cuatro en `:root` y en `.dark`; un
 * `var()` inexistente caería al fallback en silencio, así que no se inventan.
 */

/** Grilla: `--border`, el mismo separador que el resto de la UI. */
export const CHART_GRID_STROKE = 'hsl(var(--border))';

/**
 * Ejes y ticks: `--muted-foreground`. Es texto, así que tiene que cumplir
 * WCAG AA (4.5:1) contra `--card` en los DOS temas — por eso NO se usa
 * `--border`, que es un separador y no llega a ratio de texto.
 */
export const CHART_AXIS_STROKE = 'hsl(var(--muted-foreground))';

/** Tooltip: fondo de panel, borde y texto de primer plano, todos tematizados. */
export const CHART_TOOLTIP_CONTENT_STYLE = {
  backgroundColor: 'hsl(var(--popover))',
  border: '1px solid hsl(var(--border))',
  borderRadius: '0.5rem',
  color: 'hsl(var(--popover-foreground))',
} as const;

/** Texto de la etiqueta del tooltip (Recharts la estila aparte del contenido). */
export const CHART_TOOLTIP_LABEL_STYLE = {
  color: 'hsl(var(--popover-foreground))',
} as const;

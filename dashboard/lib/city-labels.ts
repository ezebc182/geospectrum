/**
 * Regla de visibilidad de las etiquetas de ciudades en el mapa.
 *
 * El problema que resuelve: las 30 ciudades dibujaban su nombre siempre. A
 * nivel continental los labels de Sudamérica caen en unos 200 píxeles y se
 * apilan hasta ser ilegibles —Bogotá encima de Quito encima de Trujillo—, que
 * es justo la zona donde más eventos hay.
 *
 * La regla es la de cualquier mapa: lejos solo las grandes, y al acercarse
 * aparecen las demás. Se filtra por población porque es el criterio que ya
 * usa el componente para el tamaño del marcador.
 *
 * Vive aparte de AdvancedSeismicMap porque es lógica pura —entra zoom y
 * población, sale un booleano— y así se testea sin montar Leaflet, que
 * necesita un DOM con dimensiones reales.
 */

/**
 * Población mínima para que una ciudad muestre su etiqueta a cada zoom.
 *
 * Los cortes salen de los niveles de Leaflet: 4 es "continente entero" (el del
 * problema), 5-6 "país grande", 7+ "región". El marcador circular se sigue
 * dibujando siempre: lo que se oculta es el texto, que es lo que se pisa.
 */
const LABEL_THRESHOLDS: { maxZoom: number; minPopulation: number }[] = [
  { maxZoom: 4, minPopulation: 15_000_000 },
  { maxZoom: 5, minPopulation: 10_000_000 },
  { maxZoom: 6, minPopulation: 5_000_000 },
  { maxZoom: 8, minPopulation: 1_500_000 },
];

/**
 * Población a partir de la cual una ciudad muestra etiqueta al zoom dado.
 *
 * Por encima del último corte no hay filtro: si el usuario se acercó tanto,
 * ya está mirando una sola región y los nombres no compiten entre sí.
 */
export function minPopulationForZoom(zoom: number): number {
  const threshold = LABEL_THRESHOLDS.find((t) => zoom <= t.maxZoom);
  return threshold?.minPopulation ?? 0;
}

/** La ciudad muestra su etiqueta al zoom dado. */
export function shouldShowCityLabel(population: number, zoom: number): boolean {
  return population >= minPopulationForZoom(zoom);
}

/**
 * Infocard del spotlight del globo: DOM imperativo porque htmlElementsData
 * de react-globe.gl ancla nodos, no componentes React. Los textos van por
 * textContent a propósito — `lugar` viene de feeds externos (USGS/EMSC) y
 * no se inyecta HTML de terceros ni por accidente. Recibe los strings YA
 * traducidos/formateados por parámetro (Decision 5: nada fuera de
 * componentes importa next-intl).
 *
 * Nació en LandingHero y se extrajo acá cuando el modo transmisión del
 * globo necesitó el mismo cartel.
 */

import type { SeismicEvent } from '@/lib/types';
import { magnitudeColor } from '@/lib/globe-data';

export function buildSpotlightCard(
  evento: SeismicEvent,
  depthLabel: string,
  relativeLabel: string,
): HTMLElement {
  const color = magnitudeColor(evento.mag);

  const root = document.createElement('div');
  root.style.pointerEvents = 'none';

  // El punto proyectado es la esquina del nodo: el ancla centra el cartel
  // sobre el epicentro y lo apoya en un conector vertical.
  const anchor = document.createElement('div');
  anchor.className =
    'absolute bottom-0 left-0 flex -translate-x-1/2 flex-col items-center animate-in fade-in slide-in-from-bottom-2 duration-300';

  const card = document.createElement('div');
  card.className = 'w-60 rounded-lg border border-border bg-card/90 p-3 font-mono backdrop-blur';
  card.style.borderLeft = `3px solid ${color}`;
  card.style.boxShadow = `0 0 28px ${color}55`;

  const mag = document.createElement('p');
  mag.className = 'text-xl font-bold leading-none tracking-tight';
  mag.style.color = color;
  mag.textContent = `M${evento.mag.toFixed(1)}`;

  const place = document.createElement('p');
  place.className = 'mt-2 truncate text-xs text-foreground/90';
  place.textContent =
    evento.lugar ?? `${evento.lat.toFixed(1)}, ${evento.lon.toFixed(1)}`;

  const meta = document.createElement('p');
  meta.className = 'mt-1 text-[10px] uppercase tracking-wider text-muted-foreground';
  const depth =
    evento.prof_km !== null ? `${depthLabel} ${Math.round(evento.prof_km)} km · ` : '';
  meta.textContent = `${depth}${relativeLabel}`;

  card.append(mag, place, meta);

  const connector = document.createElement('div');
  connector.className = 'h-4 w-px';
  connector.style.background = color;

  anchor.append(card, connector);
  root.appendChild(anchor);
  return root;
}

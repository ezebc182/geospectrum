import { describe, expect, it } from 'vitest';

import { buildShareText, EVENT_PARAM, eventUrl } from './share-event';
import type { SeismicEvent } from '@/lib/types';

function makeEvent(overrides: Partial<SeismicEvent> = {}): SeismicEvent {
  return {
    id: 'evt-1',
    fuentes: ['USGS'],
    hora_utc: '2026-08-01T14:30:00Z',
    lat: -33.4,
    lon: -70.6,
    prof_km: 35,
    mag: 5.2,
    mag_tipo: 'mww',
    lugar: 'Santiago, Chile',
    sentido: false,
    revisado: true,
    ...overrides,
  };
}

describe('eventUrl', () => {
  const BASE = 'http://localhost:3008/globe';

  it('agrega el id del evento como parámetro', () => {
    expect(eventUrl('usgs-abc123', BASE)).toContain(`${EVENT_PARAM}=usgs-abc123`);
  });

  it('reemplaza el evento anterior en vez de acumular parámetros', () => {
    // Sin esto, clickear cinco eventos deja una URL con cinco ?event= y el que
    // abre el link cae en el primero, no en el que se quiso compartir.
    const url = new URL(eventUrl('nuevo', `${BASE}?event=viejo`));

    expect(url.searchParams.getAll(EVENT_PARAM)).toEqual(['nuevo']);
  });

  it('conserva los demás parámetros de la URL', () => {
    const url = new URL(eventUrl('evt-1', `${BASE}?area=cascadia`));

    expect(url.searchParams.get('area')).toBe('cascadia');
    expect(url.searchParams.get(EVENT_PARAM)).toBe('evt-1');
  });

  it('escapa los ids que traen caracteres especiales', () => {
    // El id de respaldo se arma con coordenadas y hora: "-33.4,-70.6,2026-..."
    // Las comas y los dos puntos tienen que viajar codificados.
    const id = '-33.4,-70.6,2026-08-01T00:00:00Z';

    expect(new URL(eventUrl(id, BASE)).searchParams.get(EVENT_PARAM)).toBe(id);
  });
});

describe('buildShareText', () => {
  it('pone magnitud y lugar en la primera línea', () => {
    // Es lo único que se ve en la previsualización de WhatsApp antes de abrir.
    const [primera] = buildShareText(makeEvent()).split('\n');

    expect(primera).toBe('Sismo M5.2 — Santiago, Chile');
  });

  it('marca la hora como UTC', () => {
    // Un sismo lo comenta gente en varios husos: "14:30" a secas no significa
    // nada y lleva a confusión sobre cuándo pasó.
    expect(buildShareText(makeEvent())).toContain('2026-08-01 14:30 UTC');
  });

  it('incluye la profundidad redondeada', () => {
    expect(buildShareText(makeEvent({ prof_km: 34.7 }))).toContain('35 km de profundidad');
  });

  it('omite la profundidad cuando no se conoce', () => {
    const texto = buildShareText(makeEvent({ prof_km: null }));

    expect(texto).not.toContain('profundidad');
    expect(texto).toContain('UTC');
  });

  it('avisa cuando el evento no fue revisado', () => {
    // La magnitud de una solución automática puede corregirse después:
    // compartirla como definitiva es difundir un dato que va a cambiar.
    expect(buildShareText(makeEvent({ revisado: false }))).toContain('Solución automática');
  });

  it('no agrega la advertencia si el evento ya fue revisado', () => {
    expect(buildShareText(makeEvent({ revisado: true }))).not.toContain('automática');
  });

  it('no deja el texto a medias cuando falta el lugar', () => {
    expect(buildShareText(makeEvent({ lugar: null }))).toContain('ubicación desconocida');
  });

  it('no rompe el mensaje con una fecha inválida', () => {
    // Una fuente puede mandar basura en hora_utc: el resto del mensaje sigue
    // siendo útil y no tiene por qué salir "Invalid Date".
    const texto = buildShareText(makeEvent({ hora_utc: 'no soy una fecha' }));

    expect(texto).toContain('Sismo M5.2');
    expect(texto).not.toContain('Invalid Date');
  });

  it('mantiene un decimal en la magnitud', () => {
    expect(buildShareText(makeEvent({ mag: 6 }))).toContain('M6.0');
  });
});

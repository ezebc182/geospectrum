import { describe, expect, it } from 'vitest';

import { buildShareText, EVENT_PARAM, eventUrl, type ShareMessages } from './share-event';
import type { SeismicEvent } from '@/lib/types';

/** Mensajes ES reales (espejo de messages/es.json → share): los asserts miran
 * el texto que ve el usuario, no un stub — mismo criterio que EventsTable. */
const MESSAGES_ES: ShareMessages = {
  title: 'Monitor sísmico',
  headline: (magnitude, place) => `Sismo ${magnitude} — ${place}`,
  depth: (km) => `${km} km de profundidad`,
  unknownLocation: 'ubicación desconocida',
  unknownDate: 'fecha desconocida',
  unreviewedNotice: 'Solución automática, sin revisar por analista.',
};

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
    const [primera] = buildShareText(makeEvent(), MESSAGES_ES).split('\n');

    expect(primera).toBe('Sismo M5.2 — Santiago, Chile');
  });

  it('marca la hora como UTC', () => {
    // Un sismo lo comenta gente en varios husos: "14:30" a secas no significa
    // nada y lleva a confusión sobre cuándo pasó.
    expect(buildShareText(makeEvent(), MESSAGES_ES)).toContain('2026-08-01 14:30 UTC');
  });

  it('incluye la profundidad redondeada', () => {
    expect(buildShareText(makeEvent({ prof_km: 34.7 }), MESSAGES_ES)).toContain('35 km de profundidad');
  });

  it('omite la profundidad cuando no se conoce', () => {
    const texto = buildShareText(makeEvent({ prof_km: null }), MESSAGES_ES);

    expect(texto).not.toContain('profundidad');
    expect(texto).toContain('UTC');
  });

  it('avisa cuando el evento no fue revisado', () => {
    // La magnitud de una solución automática puede corregirse después:
    // compartirla como definitiva es difundir un dato que va a cambiar.
    expect(buildShareText(makeEvent({ revisado: false }), MESSAGES_ES)).toContain('Solución automática');
  });

  it('no agrega la advertencia si el evento ya fue revisado', () => {
    expect(buildShareText(makeEvent({ revisado: true }), MESSAGES_ES)).not.toContain('automática');
  });

  it('no deja el texto a medias cuando falta el lugar', () => {
    expect(buildShareText(makeEvent({ lugar: null }), MESSAGES_ES)).toContain('ubicación desconocida');
  });

  it('no rompe el mensaje con una fecha inválida', () => {
    // Una fuente puede mandar basura en hora_utc: el resto del mensaje sigue
    // siendo útil y no tiene por qué salir "Invalid Date".
    const texto = buildShareText(makeEvent({ hora_utc: 'no soy una fecha' }), MESSAGES_ES);

    expect(texto).toContain('Sismo M5.2');
    expect(texto).not.toContain('Invalid Date');
  });

  it('mantiene un decimal en la magnitud', () => {
    expect(buildShareText(makeEvent({ mag: 6 }), MESSAGES_ES)).toContain('M6.0');
  });

  it('respeta el orden de palabras del idioma de los mensajes', () => {
    // En inglés la magnitud antecede a "earthquake": la lib no puede asumir el
    // orden del español — por eso headline es función y no concatenación fija.
    const messagesEn: ShareMessages = {
      ...MESSAGES_ES,
      headline: (magnitude, place) => `${magnitude} earthquake — ${place}`,
      unreviewedNotice: 'Automatic solution, not reviewed by an analyst.',
    };

    const texto = buildShareText(makeEvent({ revisado: false }), messagesEn);

    expect(texto).toContain('M5.2 earthquake — Santiago, Chile');
    expect(texto).toContain('not reviewed by an analyst');
    expect(texto).not.toContain('Sismo');
  });
});

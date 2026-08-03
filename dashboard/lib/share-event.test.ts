import { describe, expect, it } from 'vitest';

import { buildShareText } from './share-event';
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

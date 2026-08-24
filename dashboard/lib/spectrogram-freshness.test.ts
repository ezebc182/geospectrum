import { describe, it, expect } from 'vitest';
import {
  STALE_AFTER_SECONDS,
  freshnessOf,
  type ConnectionStatus,
} from './spectrogram-freshness';

const AHORA = new Date('2026-08-23T22:59:00Z');

/** Un endtime a `segundos` de antigüedad respecto de AHORA. */
function haceSegundos(segundos: number): string {
  return new Date(AHORA.getTime() - segundos * 1000).toISOString();
}

describe('umbral de frescura', () => {
  it('reusa los 300s del ingestor en vez de inventar un número', () => {
    // STALE_AFTER_SECONDS de src/services/seedlink_ingestor.py: un canal sin
    // datos por 5 min ya se considera mudo del lado del backend. Que la UI
    // use OTRO corte daría dos verdades distintas sobre el mismo canal.
    expect(STALE_AFTER_SECONDS).toBe(300);
  });
});

describe('freshnessOf — dato viejo', () => {
  it('es "live" cuando la columna acaba de llegar', () => {
    expect(freshnessOf(haceSegundos(12), AHORA, 'live')).toBe('live');
  });

  it('sigue siendo "live" justo antes del umbral', () => {
    expect(freshnessOf(haceSegundos(299), AHORA, 'live')).toBe('live');
  });

  it('pasa a "stale" al cruzar los 5 minutos aunque el socket siga abierto', () => {
    // El caso que hizo perder el diagnóstico: prod tenía dato de hace 1
    // segundo y la pantalla mostraba una hora de 21h antes con la misma
    // cara de "en vivo". Un socket abierto NO prueba que el dato sea fresco.
    expect(freshnessOf(haceSegundos(301), AHORA, 'live')).toBe('stale');
  });

  it('marca "stale" un dato de horas atrás', () => {
    expect(freshnessOf(haceSegundos(66 * 3600), AHORA, 'live')).toBe('stale');
  });
});

describe('freshnessOf — conexión caída', () => {
  it('es "stale" si el socket se cortó, por fresco que sea el último dato', () => {
    // El bug de la pestaña congelada: al cortarse el WebSocket, lastUpdate
    // queda clavado en el último mensaje recibido y la etiqueta lo muestra
    // como si nada. Sin conexión no hay forma de saber si el dato sigue
    // valiendo, así que la UI no puede seguir afirmando que está en vivo.
    expect(freshnessOf(haceSegundos(5), AHORA, 'error')).toBe('stale');
  });

  it('es "connecting" mientras todavía no llegó ningún dato', () => {
    expect(freshnessOf(null, AHORA, 'connecting')).toBe('connecting');
  });

  it('es "connecting" y no "stale" si aún no hay dato pero el socket abre', () => {
    // Sin endtime no hay antigüedad que medir: pintar "viejo" en el arranque
    // sería alarmar por un canvas que todavía se está llenando.
    expect(freshnessOf(null, AHORA, 'live')).toBe('connecting');
  });
});

describe('freshnessOf — entradas rotas', () => {
  it('trata un endtime ilegible como "stale" y no revienta', () => {
    // Preferir el estado degradado ante la duda: mentir "en vivo" es el
    // fallo caro, mostrar de más un cartel de viejo no lastima a nadie.
    expect(freshnessOf('no-es-una-fecha', AHORA, 'live')).toBe('stale');
  });

  it('trata un endtime del futuro como fresco', () => {
    // Desfasaje de reloj entre el navegador y el servidor: unos segundos
    // negativos son normales y no significan dato viejo.
    expect(freshnessOf(haceSegundos(-3), AHORA, 'live')).toBe('live');
  });
});

describe('freshnessOf — cobertura de estados', () => {
  const estados: ConnectionStatus[] = ['connecting', 'live', 'error'];

  it('nunca devuelve "live" si el estado de conexión no es live', () => {
    for (const estado of estados.filter((e) => e !== 'live')) {
      expect(freshnessOf(haceSegundos(1), AHORA, estado)).not.toBe('live');
    }
  });
});

import { describe, it, expect } from 'vitest';
import { asyncStateOf } from './async-state';

/**
 * El bug que motiva esto: `eventos ?? []` colapsa "todavía no llegó" y "no hay
 * nada" en el mismo valor. El globo recibía `[]` mientras cargaba y se
 * renderizaba pelado, indistinguible de "no hubo sismos en 24 h".
 */
describe('asyncStateOf', () => {
  it('es "loading" mientras el dato es undefined', () => {
    expect(asyncStateOf(undefined)).toBe('loading');
  });

  it('distingue "empty" de "loading" — el bug que colapsaba `?? []`', () => {
    // ESTA es la distinción que no existía: una lista vacía YA RESPONDIDA no
    // es lo mismo que una petición en vuelo, aunque ambas se dibujen sin
    // contenido si nadie las diferencia.
    expect(asyncStateOf([])).toBe('empty');
    expect(asyncStateOf(undefined)).toBe('loading');
  });

  it('es "ready" cuando hay al menos un elemento', () => {
    expect(asyncStateOf([1, 2, 3])).toBe('ready');
  });

  it('un error gana sobre todo lo demás', () => {
    expect(asyncStateOf(undefined, new Error('boom'))).toBe('error');
    // Con SWR el dato viejo sobrevive al fallo del refetch: igual hay que
    // avisar, o la pantalla muestra datos rancios como si estuvieran bien.
    expect(asyncStateOf([1], new Error('boom'))).toBe('error');
  });

  it('trata null igual que undefined: sigue sin haber respuesta', () => {
    expect(asyncStateOf(null)).toBe('loading');
  });

  it('sirve para datos que no son listas', () => {
    // Un objeto (perfil, muro) también tiene los tres estados; sólo que
    // "vacío" no aplica y un objeto presente es siempre `ready`.
    expect(asyncStateOf({ id: 'x' })).toBe('ready');
    expect(asyncStateOf(undefined)).toBe('loading');
  });
});

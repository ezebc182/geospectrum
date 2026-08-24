/**
 * Setup global de la suite del dashboard.
 *
 * El `waitFor` de testing-library trae 1000 ms por defecto, y ese presupuesto
 * no alcanza para los componentes que montan Leaflet: el mapa entra por
 * `import('leaflet')` dinámico y recién ahí bindea sus popups. Corriendo un
 * archivo solo sobra tiempo (~300 ms), pero con los 58 archivos de la suite
 * peleando por CPU el import se pasa del segundo y el test se cae por timeout
 * sin que haya nada roto.
 *
 * Diagnosticado el 2026-08-22 con `map-locale-popups.test.tsx`: fallaba en la
 * suite completa y pasaba aislado, en el árbol limpio igual que con cambios —
 * o sea, flakiness por concurrencia, no una regresión.
 *
 * El arreglo va acá y no en cada `waitFor` porque el problema es de toda la
 * clase de tests que esperan trabajo asíncrono real, no de un archivo. Subir
 * el techo NO hace más lentos a los tests que pasan: `waitFor` resuelve apenas
 * la aserción se cumple, y el timeout sólo marca cuánto está dispuesto a
 * esperar antes de rendirse.
 */

import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/react';

configure({ asyncUtilTimeout: 5000 });

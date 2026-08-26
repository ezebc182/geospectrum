/**
 * Página de detalle de estación (PR A: sólo la pestaña Helicorder viva).
 *
 * Usa `NextIntlClientProvider` con los mensajes REALES en vez de mockear
 * `useTranslations`: así el test falla si una clave i18n no existe. Con el
 * mock de identidad (`(k) => k`) cualquier clave inventada pasaría.
 *
 * El mock de `next/navigation` devuelve la MISMA referencia siempre — un
 * objeto nuevo por render cuelga vitest (lección del proyecto).
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { SWRConfig } from 'swr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import es from '@/messages/es.json';
import en from '@/messages/en.json';
import { AREA_CHANGED_EVENT } from '@/lib/area-events';
import type { ActiveAreaResponse, Area, AreaBbox, StationCatalogEntry } from '@/lib/types';

const { paramsMock, activeAreaMock, catalogMock } = vi.hoisted(() => ({
  paramsMock: { channel: 'IU.MAJO..BHZ' },
  // Se leen desde el mock de `useActiveArea`/`seismicAPI.getStationCatalog` en
  // cada render: mutar estos objetos ANTES de disparar el evento de cambio de
  // área es lo que simula la revalidación real de SWR.
  activeAreaMock: { current: null as ActiveAreaResponse | null },
  catalogMock: { current: [] as StationCatalogEntry[] },
}));

vi.mock('next/navigation', () => ({
  useParams: () => paramsMock,
}));

// La ventana que el helicorder simulado "señala" va inline en el mock: `vi.mock`
// se hoistea por encima de cualquier constante del módulo.
vi.mock('@/components/HelicorderCanvas', () => ({
  HelicorderCanvas: ({
    channel,
    clipMult,
    barMult,
    timeChunkMinutes,
    onSelectWindow,
  }: {
    channel: string;
    clipMult?: number;
    barMult?: number;
    timeChunkMinutes: number;
    onSelectWindow?: (w: { startMs: number; endMs: number }) => void;
  }) => (
    <div
      data-testid="helicorder-canvas"
      data-channel={channel}
      data-clip-mult={String(clipMult)}
      data-bar-mult={String(barMult)}
      data-chunk={String(timeChunkMinutes)}
      // Refleja si la página cableó el callback: sin esto, "el clic abre la
      // ventana" pasaría igual con la prop nunca conectada.
      data-selectable={onSelectWindow ? 'true' : 'false'}
      onClick={() =>
        onSelectWindow?.({
          startMs: Date.UTC(2026, 7, 24, 12, 0, 0),
          endMs: Date.UTC(2026, 7, 24, 12, 2, 0),
        })
      }
    />
  ),
}));

vi.mock('@/components/SpectrogramLarge', () => ({
  // El testid real del componente es `spectrogram-large-canvas`; se agrega acá
  // además del histórico `spectrogram-large` para no romper los tests
  // preexistentes que ya dependían de este último.
  SpectrogramLarge: ({ channel }: { channel: string }) => (
    <div data-testid="spectrogram-large" data-channel={channel}>
      <span data-testid="spectrogram-large-canvas" />
    </div>
  ),
}));

/**
 * `useActiveArea` NO se mockea: se mockea sólo el fetcher de más abajo
 * (`lib/areas.getActiveArea`).
 *
 * Mockear el hook entero rompía justo el test que importa. El valor del hook
 * es que fusiona leer el área con SUSCRIBIRSE al cambio; un mock que devuelve
 * `activeAreaMock.current` no tiene suscripción, así que disparar
 * AREA_CHANGED_EVENT no re-renderiza nada y el test se muere por timeout. Con
 * el hook real, la cadena evento → revalidación → re-render se ejercita de
 * punta a punta, que es exactamente lo que hay que probar.
 */
// El componente real pide el espectro por red; acá se prueba el CABLEADO de la
// página (progresividad + ventana + filtro), no el componente — igual que con
// el helicorder y el espectrograma de arriba.
vi.mock('@/components/SpectrumView', () => ({
  SpectrumView: ({
    channel,
    window: w,
    filter,
  }: {
    channel: string;
    window: { startMs: number; endMs: number };
    filter: string;
  }) => (
    <div
      data-testid="spectrum-view"
      data-channel={channel}
      data-filter={filter}
      data-start={String(w.startMs)}
    />
  ),
}));

// Mismo criterio que SpectrumView: la página prueba el cableado, no la serie.
vi.mock('@/components/RsamChart', () => ({
  RsamChart: ({
    channel,
    window: w,
  }: {
    channel: string;
    window: { startMs: number; endMs: number };
  }) => (
    <div data-testid="rsam-chart" data-channel={channel} data-start={String(w.startMs)} />
  ),
}));

vi.mock('@/lib/areas', () => ({
  getActiveArea: () => Promise.resolve(activeAreaMock.current),
}));

vi.mock('@/lib/api', () => ({
  seismicAPI: {
    getStationCatalog: () => Promise.resolve(catalogMock.current),
  },
}));

import StationPage from './[channel]/page';

/**
 * Cache de SWR FRESCA por render.
 *
 * La página lee el catálogo de estaciones con `useSWR` real (sólo se mockea el
 * fetcher). Sin un provider nuevo, la key `/spectrograms/station-catalog` es
 * global al módulo: el primer test deja su catálogo cacheado y el siguiente lo
 * recibe de arranque, aunque `catalogMock` ya diga otra cosa. El verde pasa a
 * depender del orden de ejecución. Mismo criterio que `use-active-area.test.tsx`.
 */
function renderPage(locale: 'es-AR' | 'en-US' = 'es-AR') {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <NextIntlClientProvider
        locale={locale}
        messages={locale === 'es-AR' ? es : en}
        timeZone="UTC"
      >
        <StationPage />
      </NextIntlClientProvider>
    </SWRConfig>,
  );
}

/** Alias del brief de la task D3: mismo render, nombre pedido en la spec. */
function renderStationPage(channel: string, locale: 'es-AR' | 'en-US' = 'es-AR') {
  paramsMock.channel = channel;
  return renderPage(locale);
}

function buildArea(bbox: AreaBbox): Area {
  return {
    id: 'a1',
    slug: 'test',
    name: 'Test',
    is_system: true,
    geometry: { type: 'Polygon', coordinates: [] },
    bbox,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

/**
 * Fixture con la forma REAL del contrato (verificado en `lib/types.ts`):
 *   ActiveAreaResponse = { area: Area, is_default: boolean }   // :105-108
 *   AreaBbox           = { minlat, maxlat, minlon, maxlon }     // :63-68
 *
 * `is_default` va en la RAÍZ, no dentro de `area`. Los campos del bbox van
 * pegados, sin guion bajo. Si el fixture miente sobre la forma, el test pasa
 * contra un componente roto.
 */
function areaActiva(bbox: AreaBbox, isDefault = false): ActiveAreaResponse {
  return { area: buildArea(bbox), is_default: isDefault };
}

function mockActiveArea(response: ActiveAreaResponse) {
  activeAreaMock.current = response;
}

function mockStationCatalog(entries: StationCatalogEntry[]) {
  catalogMock.current = entries;
}

/**
 * `lib/seismic-cities` NO se mockea a propósito.
 *
 * El intento anterior mockeaba ese módulo exportando `SEISMIC_CITIES`, un
 * símbolo que NO EXISTE en el fuente (el export real es
 * `HIGH_RISK_SEISMIC_CITIES`, y el acceso por id es `getCityById`). El mock le
 * fabricaba a la página el símbolo que la página necesitaba, así que los tests
 * quedaban verdes contra un import que en producción es `undefined`: el test
 * validaba una suposición contra sí misma.
 *
 * Usando el dataset REAL, si alguien renombra el export o cambia la forma de
 * `SeismicCity`, estos tests se caen — que es exactamente lo que se busca.
 */
const CITY_SANTIAGO = { id: 'santiago', lat: -33.4489, lon: -70.6693 };
const CITY_TOKYO = { id: 'tokyo', lat: 35.6762, lon: 139.6503 };

/**
 * Enlaza un canal con una ciudad real del catálogo de ciudades. Se llama ANTES
 * de renderizar: el catálogo tiene que estar puesto cuando SWR resuelve.
 */
function mockStationCity(channel: string, cityId: string) {
  mockStationCatalog([
    {
      channel,
      city_id: cityId,
      network: channel.split('.')[0] ?? '',
      station: channel.split('.')[1] ?? '',
      is_live: true,
      is_primary: true,
    },
  ]);
}

// Bboxes elegidos alrededor de las ciudades REALES de arriba: Santiago cae
// dentro de ANDES, Tokyo dentro de JAPON, y cada una fuera de la otra.
const ANDES: AreaBbox = { minlat: -40, maxlat: -30, minlon: -72, maxlon: -68 };
const JAPON: AreaBbox = { minlat: 30, maxlat: 40, minlon: 135, maxlon: 145 };

afterEach(cleanup);
// Los settings se persisten por canal: sin limpiar, un test le deja la escala
// puesta al siguiente y el verde depende del orden de ejecución.
beforeEach(() => {
  localStorage.clear();
  paramsMock.channel = 'IU.MAJO..BHZ';
  activeAreaMock.current = null;
  catalogMock.current = [];
});

describe('StationPage', () => {
  it('muestra el canal y la pestaña Helicorder activa', () => {
    renderPage();
    expect(screen.getByText('IU.MAJO..BHZ')).toBeTruthy();
    expect(screen.getByTestId('helicorder-canvas')).toBeTruthy();
  });

  it('las cuatro pestañas están habilitadas desde la Fase 4', () => {
    renderPage();
    // La regla del plan sigue vigente: ninguna pestaña habilitada apunta a una
    // pantalla vacía — rsam sin ventana explica cómo abrir una, y sin progreso
    // muestra el candado de progresividad.
    expect(screen.getByRole('tab', { name: /onda/i })).toHaveProperty('disabled', false);
    expect(screen.getByRole('tab', { name: /rsam/i })).toHaveProperty('disabled', false);
    expect(screen.getByRole('tab', { name: /helicorder/i })).toHaveProperty('disabled', false);
    expect(screen.getByRole('tab', { name: /espectrograma/i })).toHaveProperty('disabled', false);
  });

  describe('cableado del wave view (Fase 2)', () => {
    it('el helicorder recibe el callback de selección', () => {
      // Sin este aserto, el test del clic pasaría igual con la prop nunca
      // cableada: el mock llamaría a un `onSelectWindow` opcional inexistente
      // y no rompería nada.
      renderPage();
      expect(
        screen.getByTestId('helicorder-canvas').getAttribute('data-selectable'),
      ).toBe('true');
    });

    it('el clic en el helicorder cambia a la pestaña Onda con esa ventana', async () => {
      renderPage();
      fireEvent.click(screen.getByTestId('helicorder-canvas'));

      await waitFor(() => expect(screen.getByTestId('wave-view')).toBeTruthy());
      // La pestaña activa cambió: el usuario ve la onda, no se queda en el
      // helicorder preguntándose qué pasó con su clic.
      const seleccionadas = screen
        .getAllByRole('tab')
        .filter((b) => b.getAttribute('aria-selected') === 'true');
      expect(seleccionadas).toHaveLength(1);
      expect(seleccionadas[0].textContent).toMatch(/onda/i);
      // Y el helicorder se desmontó, así que no hay dos vistas compitiendo.
      expect(screen.queryByTestId('helicorder-canvas')).toBeNull();
    });

    it('la pestaña Onda sin ventana elegida explica cómo abrir una', () => {
      // La regla del plan: una pestaña habilitada NO puede apuntar a una
      // pantalla vacía.
      renderPage();
      fireEvent.click(screen.getByRole('tab', { name: /onda/i }));
      expect(screen.getByTestId('wave-empty')).toBeTruthy();
      expect(screen.queryByTestId('wave-view')).toBeNull();
    });
  });

  it('sólo la pestaña activa está aria-selected, no todas las habilitadas', () => {
    // El PR A ponía aria-selected={tab.enabled}: con dos pestañas vivas eso le
    // dice al lector de pantalla que hay dos seleccionadas a la vez.
    renderPage();
    const seleccionadas = screen
      .getAllByRole('tab')
      .filter((b) => b.getAttribute('aria-selected') === 'true');
    expect(seleccionadas).toHaveLength(1);
    expect(seleccionadas[0].textContent).toMatch(/helicorder/i);
  });

  it('cambiar a Espectrograma monta el espectrograma y desmonta el helicorder', () => {
    renderPage();
    expect(screen.queryByTestId('spectrogram-large')).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: /espectrograma/i }));

    expect(screen.getByTestId('spectrogram-large')).toBeTruthy();
    // Son vistas excluyentes: dejar los dos canvas montados duplicaría el
    // fetch de 24 h y el WS por gusto.
    expect(screen.queryByTestId('helicorder-canvas')).toBeNull();
  });

  it('los controles de escala son del helicorder y no aparecen en el espectrograma', () => {
    renderPage();
    expect(screen.getByLabelText(/umbral de saturación/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: /espectrograma/i }));
    expect(screen.queryByLabelText(/umbral de saturación/i)).toBeNull();
  });

  it('el espectrograma recibe el canal decodificado', () => {
    renderPage();
    fireEvent.click(screen.getByRole('tab', { name: /espectrograma/i }));
    expect(screen.getByTestId('spectrogram-large').getAttribute('data-channel')).toBe(
      'IU.MAJO..BHZ',
    );
  });

  it('le pasa al canvas el canal decodificado de la URL', () => {
    renderPage();
    // El SCNL llega URL-encoded en el path y tiene que llegar limpio al canvas.
    expect(screen.getByTestId('helicorder-canvas').getAttribute('data-channel')).toBe(
      'IU.MAJO..BHZ',
    );
  });

  it('mover el clip llega al canvas: es el fix del sismo tapado de rojo', async () => {
    // El bug de QA era que el sismo salía clampado y rojo porque el clip
    // automático (percentil del día) lo recorta. Si el slider no llega al
    // canvas, el arreglo es decorativo.
    renderPage();
    const slider = screen.getByLabelText(/umbral de saturación/i);
    fireEvent.change(slider, { target: { value: '6' } });

    expect(screen.getByTestId('helicorder-canvas').getAttribute('data-clip-mult')).toBe('6');
  });

  it('los settings se persisten por canal en localStorage', () => {
    renderPage();
    fireEvent.change(screen.getByLabelText(/amplitud/i), { target: { value: '3' } });

    const guardado = JSON.parse(localStorage.getItem('helicorder-settings:IU.MAJO..BHZ') ?? '{}');
    expect(guardado.barMult).toBe(3);
  });

  it('los settings guardados se aplican al montar', () => {
    localStorage.setItem(
      'helicorder-settings:IU.MAJO..BHZ',
      JSON.stringify({ clipMult: 5, barMult: 2, timeChunkMinutes: 15 }),
    );
    renderPage();

    const canvas = screen.getByTestId('helicorder-canvas');
    expect(canvas.getAttribute('data-clip-mult')).toBe('5');
    expect(canvas.getAttribute('data-bar-mult')).toBe('2');
    expect(canvas.getAttribute('data-chunk')).toBe('15');
  });

  it('restablecer vuelve a los defaults sin tocar el timeChunk elegido', () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: '15m' }));
    fireEvent.change(screen.getByLabelText(/umbral de saturación/i), { target: { value: '7' } });
    fireEvent.click(screen.getByRole('button', { name: /restablecer/i }));

    const canvas = screen.getByTestId('helicorder-canvas');
    expect(canvas.getAttribute('data-clip-mult')).toBe('1');
    // El reset es de escala, no de franja: cambiarle el eje X al operador
    // sería una sorpresa.
    expect(canvas.getAttribute('data-chunk')).toBe('15');
  });

  it('renderiza en inglés sin claves faltantes', () => {
    // next-intl renderiza el path de la clave cuando falta la traducción:
    // si aparece "station." en la pantalla, en.json quedó incompleto.
    const { container } = renderPage('en-US');
    expect(container.textContent).not.toMatch(/station\./);
    expect(screen.getByRole('tab', { name: /rsam/i })).toHaveProperty('disabled', false);
    expect(screen.getByRole('tab', { name: /spectrogram/i })).toHaveProperty('disabled', false);
  });
});

describe('StationPage - contexto de área activa (Task D3)', () => {
  // El contexto es independiente de la pestaña activa (se calcula desde el
  // catálogo, no desde el helicorder/espectrograma), pero la pestaña que
  // arranca activa es Helicorder: se cambia a Espectrograma para tener un
  // testid estable (`spectrogram-large-canvas`) que confirme que el catálogo
  // ya resolvió antes de aserir sobre `station-area-context`.
  async function irAEspectrograma() {
    fireEvent.click(screen.getByRole('tab', { name: /espectrograma|spectrogram/i }));
    await screen.findByTestId('spectrogram-large-canvas');
  }

  it('dice que la estacion esta dentro del area activa', async () => {
    mockActiveArea(areaActiva(ANDES));
    mockStationCity('C1.SANT..HHZ', CITY_SANTIAGO.id);
    renderStationPage('C1.SANT..HHZ');
    await irAEspectrograma();

    expect(await screen.findByTestId('station-area-context')).toHaveTextContent(/dentro/i);
  });

  it('dice que la estacion esta fuera del area activa', async () => {
    mockActiveArea(areaActiva(ANDES));
    mockStationCity('IU.MAJO..BHZ', CITY_TOKYO.id); // Tokyo, fuera de los Andes
    renderStationPage('IU.MAJO..BHZ');
    await irAEspectrograma();

    expect(await screen.findByTestId('station-area-context')).toHaveTextContent(/fuera/i);
  });

  it('se actualiza al cambiar de area sin recargar', async () => {
    // El bug que este test previene: la página monta el selector (viene del
    // layout) pero no lo consumía, así que cambiar de área no hacía nada.
    mockActiveArea(areaActiva(ANDES));
    mockStationCity('IU.MAJO..BHZ', CITY_TOKYO.id);
    renderStationPage('IU.MAJO..BHZ');
    await irAEspectrograma();
    expect(await screen.findByTestId('station-area-context')).toHaveTextContent(/fuera/i);

    mockActiveArea(areaActiva(JAPON));
    await act(async () => {
      window.dispatchEvent(new CustomEvent(AREA_CHANGED_EVENT));
      // Le da a la revalidación de SWR el tiempo de resolver y re-renderizar.
      // Un `waitFor` acá haría que la versión rota muera por TIMEOUT en vez de
      // por aserción, y un timeout no dice qué se rompió.
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(screen.getByTestId('station-area-context')).toHaveTextContent(/dentro/i);
  });

  it('no muestra el contexto si no se conocen las coordenadas de la estacion', async () => {
    // El canal SÍ está en el catálogo, pero su `city_id` no resuelve a ninguna
    // ciudad conocida: sin ciudad no hay lat/lon. Es un caso distinto al de
    // "el canal no está en el catálogo" — se corta un eslabón más adelante.
    mockActiveArea(areaActiva(ANDES));
    mockStationCity('AR.TEST..HHZ', 'ciudad-que-no-existe');
    renderStationPage('AR.TEST..HHZ');
    await irAEspectrograma();

    expect(screen.queryByTestId('station-area-context')).not.toBeInTheDocument();
  });

  it('no muestra el contexto con el area por defecto (mundo entero)', async () => {
    // `is_default: true` en la raíz — el usuario no eligió nada.
    mockActiveArea(areaActiva(ANDES, true));
    mockStationCity('C1.SANT..HHZ', CITY_SANTIAGO.id);
    renderStationPage('C1.SANT..HHZ');
    await irAEspectrograma();

    expect(screen.queryByTestId('station-area-context')).not.toBeInTheDocument();
  });

  it('no muestra el contexto si el canal no esta en el catalogo', async () => {
    // Un canal escrito a mano en la URL, o una estación que el ingestor no
    // sigue: sin entrada en el catálogo no hay city_id, y sin city_id no hay
    // coordenadas. Mismo caso que "no se conocen las coordenadas".
    mockActiveArea(areaActiva(ANDES));
    mockStationCatalog([]);
    renderStationPage('XX.NADA..HHZ');
    await irAEspectrograma();

    expect(screen.queryByTestId('station-area-context')).not.toBeInTheDocument();
  });

  it('el fixture usa la forma real del contrato — minlat, no min_lat', () => {
    // Guarda contra el error que este plan casi comete: `bbox.min_lat` da
    // `undefined`, la comparación da `false`, y el componente diría "fuera"
    // SIEMPRE. Un bug mudo que ningún otro test de acá detectaría.
    expect(areaActiva(ANDES).area.bbox).toHaveProperty('minlat');
    expect(areaActiva(ANDES).area.bbox).not.toHaveProperty('min_lat');
    expect(areaActiva(ANDES)).toHaveProperty('is_default');
  });
});

describe('StationPage - espectro 1D (Fase 3)', () => {
  /** Abre una ventana con el clic del helicorder simulado y cae en la pestaña Onda. */
  function abrirVentana() {
    fireEvent.click(screen.getByTestId('helicorder-canvas'));
  }

  it('sin progreso suficiente el botón de espectro NO aparece', () => {
    renderPage();
    abrirVentana(); // 1 ventana < spectrumAfterWindows (3)

    expect(screen.queryByText(es.station.spectrumShow)).toBeNull();
    expect(screen.queryByTestId('spectrum-view')).toBeNull();
  });

  it('el toggle de herramientas es honesto: queda visible, marcado, y apagarlo re-bloquea', () => {
    renderPage();
    const checkbox = () => screen.getByLabelText(es.station.showAllTools) as HTMLInputElement;

    fireEvent.click(checkbox());
    // La versión vieja desaparecía al activarse ("no hace nada y desaparece"):
    // ahora sigue en pantalla, marcada, y muestra qué desbloqueó.
    expect(checkbox().checked).toBe(true);
    expect(screen.getByText(es.station.showAllToolsActive)).toBeTruthy();

    fireEvent.click(checkbox());
    expect(checkbox().checked).toBe(false);
    expect(screen.queryByText(es.station.showAllToolsActive)).toBeNull();
  });

  it('con "mostrar todas las herramientas" el botón aparece y abre el espectro de la ventana vigente', () => {
    renderPage();
    // El escape hatch de la progresividad revela el escalón sin ganárselo.
    fireEvent.click(screen.getByLabelText(es.station.showAllTools));
    abrirVentana();

    const boton = screen.getByText(es.station.spectrumShow);
    expect(screen.queryByTestId('spectrum-view')).toBeNull(); // opt-in: no monta solo

    fireEvent.click(boton);
    const vista = screen.getByTestId('spectrum-view');
    expect(vista.getAttribute('data-channel')).toBe('IU.MAJO..BHZ');
    expect(vista.getAttribute('data-filter')).toBe('none');
    // La ventana del espectro es la del wave view (la que abrió el clic).
    expect(vista.getAttribute('data-start')).toBe(String(Date.UTC(2026, 7, 24, 12, 0, 0)));
  });

  it('abrir el espectro registra la interacción en el progreso persistido', async () => {
    const { loadProgress } = await import('@/lib/progressive-disclosure');
    renderPage();
    fireEvent.click(screen.getByLabelText(es.station.showAllTools));
    abrirVentana();

    expect(loadProgress().spectraViewed).toBe(0);
    fireEvent.click(screen.getByText(es.station.spectrumShow));
    expect(loadProgress().spectraViewed).toBe(1);

    // Cerrar y reabrir cuenta de nuevo: "en cada uso", dice la tarea 3.12.
    fireEvent.click(screen.getByText(es.station.spectrumShow));
    fireEvent.click(screen.getByText(es.station.spectrumShow));
    expect(loadProgress().spectraViewed).toBe(2);
  });
});

describe('StationPage - RSAM (Fase 4)', () => {
  function abrirVentana() {
    fireEvent.click(screen.getByTestId('helicorder-canvas'));
  }

  function irARsam() {
    fireEvent.click(screen.getByRole('tab', { name: /rsam/i }));
  }

  it('sin progreso suficiente la pestaña muestra el candado, no la serie', () => {
    renderPage();
    irARsam();

    expect(screen.getByTestId('rsam-locked').textContent).toContain(
      es.station.rsamLocked,
    );
    expect(screen.queryByTestId('rsam-chart')).toBeNull();
  });

  it('con la herramienta revelada pero sin ventana explica cómo abrir una', () => {
    renderPage();
    fireEvent.click(screen.getByLabelText(es.station.showAllTools));
    irARsam();

    expect(screen.getByTestId('rsam-no-window').textContent).toContain(
      es.station.waveEmpty,
    );
    expect(screen.queryByTestId('rsam-chart')).toBeNull();
  });

  it('con herramienta y ventana monta la serie de la ventana vigente', () => {
    renderPage();
    fireEvent.click(screen.getByLabelText(es.station.showAllTools));
    abrirVentana(); // cae en la pestaña Onda con la ventana del clic
    irARsam();

    const chart = screen.getByTestId('rsam-chart');
    expect(chart.getAttribute('data-channel')).toBe('IU.MAJO..BHZ');
    expect(chart.getAttribute('data-start')).toBe(String(Date.UTC(2026, 7, 24, 12, 0, 0)));
  });

  it('abrir la serie registra la interacción; mirar el candado no', async () => {
    const { loadProgress } = await import('@/lib/progressive-disclosure');
    renderPage();
    irARsam(); // candado: no cuenta
    expect(loadProgress().rsamViewed ?? 0).toBe(0);

    fireEvent.click(screen.getByLabelText(es.station.showAllTools));
    // Las pestañas son vistas excluyentes: para clicar el helicorder hay que
    // volver a su pestaña (el canvas no existe mientras rsam está activa).
    fireEvent.click(screen.getByRole('tab', { name: /helicorder/i }));
    abrirVentana();
    irARsam(); // serie visible: cuenta
    expect(loadProgress().rsamViewed ?? 0).toBe(1);
  });
});

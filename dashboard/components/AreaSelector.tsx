/**
 * Selector del área de interés activa (AOI-1).
 *
 * Sólo se muestra con sesión iniciada: los endpoints /areas responden 401 a los
 * anónimos y acá eso se traduce en no renderizar nada.
 *
 * En la práctica el dashboard entero ya está detrás del middleware (sólo
 * /login es pública, ver dashboard/middleware.ts), así que el caso anónimo no
 * debería darse navegando. Se contempla igual porque la cookie puede expirar
 * ENTRE el chequeo del middleware y este fetch: ahí el 401 llega igual, y la
 * alternativa sería romper la página por una preferencia que no es crítica.
 */

'use client';

import { useEffect, useState } from 'react';
import { Check, ChevronDown, Globe, Search } from 'lucide-react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { groupAreas } from '@/lib/area-groups';
import { countAreas, filterGroups, normalize } from '@/lib/area-search';
import { getActiveArea, listAreas, setActiveArea } from '@/lib/areas';
import type { Area } from '@/lib/types';
import { cn } from '@/lib/utils';

const DEFAULT_AREA_LABEL = 'Área por defecto';

/**
 * A partir de cuántas áreas aparece el buscador.
 *
 * Con pocas opciones el input es ruido: se ven todas de un vistazo y el filtro
 * agrega un paso para no ahorrar ninguno. El catálogo del sistema ya son 18, así
 * que en la práctica se muestra siempre; el umbral existe para el caso raro de
 * un despliegue con el catálogo recortado.
 */
const SEARCH_THRESHOLD = 8;

interface AreaSelectorProps {
  /** Se llama después de cambiar el área, para refrescar el reporte. */
  onAreaChange?: () => void;
}

export function AreaSelector({ onAreaChange }: AreaSelectorProps) {
  const [areas, setAreas] = useState<Area[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState('');

  useEffect(() => {
    let cancelled = false;

    // Las dos lecturas van en paralelo: son independientes y encadenarlas sólo
    // agregaría un round-trip al primer pintado.
    Promise.all([listAreas(), getActiveArea()])
      .then(([lista, activa]) => {
        if (cancelled) return;
        setAreas(lista);
        // is_default=true significa que el usuario NO eligió: se deja el
        // select en "por defecto" en vez de marcar un área que nunca eligió.
        setActiveId(activa && !activa.is_default ? activa.area.id : null);
      })
      .catch(() => {
        // Un fallo acá deja el selector oculto (areas queda null). El reporte
        // sigue andando con el área por defecto: es una preferencia, no una
        // función crítica.
        if (!cancelled) setAreas(null);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // Sin sesión (401 -> null) o mientras carga: no se muestra nada.
  if (!areas) return null;

  const handleChange = async (value: string) => {
    const nuevo = value === '' ? null : value;
    const previo = activeId;

    setActiveId(nuevo); // optimista: el select responde sin esperar la red
    setSaving(true);
    try {
      await setActiveArea(nuevo);
      onAreaChange?.();
    } catch {
      setActiveId(previo); // revertir: el área real sigue siendo la anterior
    } finally {
      setSaving(false);
    }
  };

  const activeArea = areas.find((area) => area.id === activeId) ?? null;
  const activeLabel = activeArea ? activeArea.name : DEFAULT_AREA_LABEL;
  const groups = groupAreas(areas);

  const showSearch = areas.length >= SEARCH_THRESHOLD;
  const visibleGroups = showSearch ? filterGroups(groups, query) : groups;
  const hasResults = countAreas(visibleGroups) > 0;
  // "Área por defecto" es una opción más y se filtra con el mismo criterio, si
  // no quedaría fija arriba contradiciendo al buscador.
  const showDefaultOption =
    !showSearch || normalize(DEFAULT_AREA_LABEL).includes(normalize(query));

  return (
    <DropdownMenu
      // El texto tipeado no sobrevive al cierre: al reabrir se espera la lista
      // completa, no el filtro de la vez pasada.
      onOpenChange={(open) => {
        if (!open) setQuery('');
      }}
    >
      <DropdownMenuTrigger
        disabled={saving}
        aria-label={`Área de interés: ${activeLabel}`}
        className="flex max-w-[16rem] items-center gap-2 rounded-lg border-2 border-gray-300 px-3 py-2 text-sm transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 dark:border-gray-700"
      >
        <Globe className="h-4 w-4 shrink-0 text-gray-500" aria-hidden="true" />
        {/* `truncate` porque hay nombres largos ("Papúa Nueva Guinea y
            Melanesia") que si no ensanchan el header y descolocan el resto. */}
        <span className="truncate">{activeLabel}</span>
        <ChevronDown className="h-4 w-4 shrink-0 text-gray-500" aria-hidden="true" />
      </DropdownMenuTrigger>

      {/* Reemplaza a un <select> nativo, cuyo desplegable posiciona el SISTEMA
          OPERATIVO y no el CSS: con 17 áreas y el header pegado arriba, macOS
          lo abría hacia arriba y la lista se salía de la ventana, tapando la
          barra de pestañas. Radix mide el viewport y voltea o desplaza solo.
          `collisionPadding` le deja aire al borde y `max-h` fuerza el scroll
          adentro del panel en vez de estirarlo más allá de la pantalla. */}
      <DropdownMenuContent
        align="end"
        collisionPadding={12}
        className="max-h-[min(28rem,var(--radix-dropdown-menu-content-available-height))] w-[18rem] overflow-y-auto"
      >
        <DropdownMenuLabel className="text-xs uppercase tracking-wider text-muted-foreground">
          Área de interés
        </DropdownMenuLabel>

        {showSearch && (
          <div className="px-2 pb-2 pt-1">
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              {/* Sin autoFocus a propósito: Radix enfoca el primer item al
                  abrir, y robarle el foco al input rompería la navegación por
                  flechas de quien usa teclado. Se llega con Tab o con click. */}
              <input
                type="text"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Buscar área…"
                aria-label="Buscar área de interés"
                // Radix trata cada tecla como typeahead para mover el foco
                // entre items: sin esto, escribir acá salta a una opción en vez
                // de llenar el input. Escape sí se deja pasar, para que siga
                // cerrando el menú.
                onKeyDown={(event) => {
                  if (event.key !== 'Escape') event.stopPropagation();
                }}
                className="w-full rounded-md border border-input bg-transparent py-1.5 pl-8 pr-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
          </div>
        )}

        <DropdownMenuSeparator />

        {showDefaultOption && (
          <AreaOption
            label={DEFAULT_AREA_LABEL}
            isActive={activeId === null}
            onSelect={() => handleChange('')}
          />
        )}

        {/* Con 18 áreas del sistema, una lista plana obliga a leerlas todas
            para encontrar una. Los grupos vacíos no se renderizan: "Mis áreas"
            no existe hasta que el usuario cree la primera. */}
        {visibleGroups.map((group) => (
          <div key={group.id}>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs uppercase tracking-wider text-muted-foreground">
              {group.label}
            </DropdownMenuLabel>
            {group.areas.map((area) => (
              <AreaOption
                key={area.id}
                label={area.name}
                isActive={area.id === activeId}
                onSelect={() => handleChange(area.id)}
              />
            ))}
          </div>
        ))}

        {/* Sin esto el panel queda vacío y parece colgado. */}
        {showSearch && !hasResults && !showDefaultOption && (
          <p className="px-2 py-6 text-center text-sm text-muted-foreground">
            No hay áreas que coincidan con «{query}»
          </p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface AreaOptionProps {
  label: string;
  isActive: boolean;
  onSelect: () => void;
}

function AreaOption({ label, isActive, onSelect }: AreaOptionProps) {
  return (
    <DropdownMenuItem
      onSelect={onSelect}
      // El check ocupa lugar SIEMPRE (invisible cuando no aplica) para que las
      // etiquetas queden alineadas y la lista no salte al cambiar de área.
      className={cn('cursor-pointer gap-2', isActive && 'font-semibold')}
    >
      <Check
        className={cn('h-4 w-4 shrink-0 text-seismic-600', !isActive && 'invisible')}
        aria-hidden="true"
      />
      <span className="truncate">{label}</span>
    </DropdownMenuItem>
  );
}

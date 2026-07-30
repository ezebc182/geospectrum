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
import { Globe } from 'lucide-react';

import { getActiveArea, listAreas, setActiveArea } from '@/lib/areas';
import type { Area } from '@/lib/types';

interface AreaSelectorProps {
  /** Se llama después de cambiar el área, para refrescar el reporte. */
  onAreaChange?: () => void;
}

export function AreaSelector({ onAreaChange }: AreaSelectorProps) {
  const [areas, setAreas] = useState<Area[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

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

  return (
    <div className="flex items-center gap-2">
      <Globe className="h-4 w-4 text-gray-500" aria-hidden="true" />
      <label htmlFor="area-selector" className="sr-only">
        Área de interés
      </label>
      <select
        id="area-selector"
        value={activeId ?? ''}
        disabled={saving}
        onChange={(e) => handleChange(e.target.value)}
        className="rounded-lg border-2 border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-4 py-2 text-sm disabled:opacity-60"
      >
        <option value="">Área por defecto</option>
        {areas.map((area) => (
          <option key={area.id} value={area.id}>
            {area.name}
            {area.is_system ? '' : ' (propia)'}
          </option>
        ))}
      </select>
    </div>
  );
}

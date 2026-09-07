'use client';

import * as React from 'react';
import { Tabs as TabsPrimitive } from 'radix-ui';

import { cn } from '@/lib/utils';

/** Valor de la pestaña activa, espejado para `TabsContent keepMounted` (Radix
 * no expone su contexto). `null` = nadie lo está espejando. */
const TabsActiveValueContext = React.createContext<string | null>(null);

function Tabs({
  className,
  value,
  defaultValue,
  onValueChange,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root>) {
  const [uncontrolled, setUncontrolled] = React.useState(defaultValue);
  const active = value ?? uncontrolled ?? null;

  const handleValueChange = React.useCallback(
    (next: string) => {
      setUncontrolled(next);
      onValueChange?.(next);
    },
    [onValueChange],
  );

  return (
    <TabsActiveValueContext.Provider value={active}>
      <TabsPrimitive.Root
        data-slot="tabs"
        value={value}
        defaultValue={defaultValue}
        onValueChange={handleValueChange}
        className={cn('flex flex-col gap-6', className)}
        {...props}
      />
    </TabsActiveValueContext.Provider>
  );
}

function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn(
        'inline-flex w-fit items-center justify-center gap-1 rounded-lg border-2 border-gray-200 bg-gray-100 p-1 dark:border-gray-700 dark:bg-gray-800',
        className,
      )}
      {...props}
    />
  );
}

function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md px-4 py-2 text-sm font-semibold text-gray-600 transition-colors hover:text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-seismic-500 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-white data-[state=active]:text-seismic-700 data-[state=active]:shadow-sm dark:text-gray-300 dark:hover:text-white dark:data-[state=active]:bg-gray-900 dark:data-[state=active]:text-seismic-300 [&_svg]:pointer-events-none [&_svg]:shrink-0",
        className,
      )}
      {...props}
    />
  );
}

/**
 * `keepMounted` monta el panel SIEMPRE y lo oculta con el atributo `hidden`
 * nativo cuando no es el activo. Es para contenido que se autocarga: si Radix
 * desmontara los hijos, volver a la pestaña re-dispararía sus efectos (y sus
 * peticiones). Ojo con el `forceMount` pelado de Radix: apaga su propio
 * `hidden`, así que dejaría el panel inactivo VISIBLE y expuesto al lector de
 * pantalla — por eso acá se repone a mano.
 */
function TabsContent({
  className,
  keepMounted,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Content> & { keepMounted?: boolean }) {
  const { value } = props;
  const context = React.useContext(TabsActiveValueContext);
  const isHidden = keepMounted ? context !== null && context !== value : undefined;

  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn('flex-1 outline-none', className)}
      forceMount={keepMounted || undefined}
      hidden={isHidden}
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsTrigger, TabsContent };

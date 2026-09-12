"use client"

/**
 * Wrapper de `Popover` del paquete unificado `radix-ui`, calcado del molde de
 * `components/ui/tooltip.tsx` — del ARCHIVO DE AL LADO, no de la doc de shadcn.
 *
 * Dos detalles se copian a propósito y NO se deben "simplificar" al molde de
 * shadcn:
 *
 * 1. `Portal`: sin él, un popover dentro de un contenedor con `overflow-y-auto`
 *    (el `max-h-56` del ranking de uptime, `StationUptimeChart.tsx:167`) sale
 *    RECORTADO. Ese bug ya mordió en este repo (commit `42fa3bb`, "el panel de
 *    espectrogramas quedaba recortado en el HUD embebido").
 * 2. `z-[1100]`: el comentario de `tooltip.tsx:45` documenta que es un fix
 *    sistémico para ganarle a los `z-[1000]` de Leaflet. El `z-50` que trae el
 *    molde de shadcn reproduciría el bug exacto en el tab que tiene mapa.
 *
 * Lo que NO se hace, explícitamente: montar a la fuerza el contenido cerrado.
 * Esa prop deja el contenido inactivo visible al lector de pantalla (lección ya
 * registrada con Radix Tabs en este repo). Un popover cerrado debe quedar FUERA
 * del árbol de accesibilidad, que es el comportamiento por defecto de Radix.
 * El nombre literal de esa prop no se escribe acá a propósito: los tests de los
 * componentes que consumen este wrapper prohíben el literal en el fuente.
 *
 * Honestidad sobre la verificación: que el Portal y el z-index FUNCIONEN es
 * inverificable en jsdom (no hace layout, nada recorta, todo mide 0×0). Los
 * tests de esta fase solo comprueban que estén DECLARADOS.
 */

import * as React from "react"
import { Popover as PopoverPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

function Popover({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />
}

function PopoverTrigger({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}

function PopoverAnchor({
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Anchor>) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />
}

function PopoverContent({
  className,
  align = "center",
  sideOffset = 4,
  children,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          // z-[1100]: por encima de los z-[1000] del mapa Leaflet (fix sistémico QA).
          "z-[1100] w-72 origin-[var(--radix-popover-content-transform-origin)] rounded-md border border-border bg-popover p-4 text-popover-foreground shadow-md outline-hidden data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className
        )}
        {...props}
      >
        {children}
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  )
}

export { Popover, PopoverAnchor, PopoverContent, PopoverTrigger }

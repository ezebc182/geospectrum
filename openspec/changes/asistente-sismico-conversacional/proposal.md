# Proposal: Asistente Sísmico Conversacional

## Intent

Hoy el dashboard expone datos sísmicos (eventos, picks, RSAM, espectros) solo a través de tablas, gráficos y filtros manuales. Un usuario que quiere responder "¿hubo sismos mayores a 4 cerca de la estación X en las últimas 24 horas?" tiene que armar esa consulta a mano combinando filtros de UI. Este change agrega un asistente conversacional en lenguaje natural que responde preguntas sobre datos ya persistidos (eventos sísmicos, picks de señal) traduciendo la pregunta del usuario a llamadas a herramientas (tools) sobre el backend existente, sin inventar datos ni exponer fuentes que el usuario no debería ver.

El riesgo central que este change gestiona es la ALUCINACIÓN: un LLM libre puede inventar magnitudes, ubicaciones o fechas de eventos sísmicos, lo cual es inaceptable en un dominio de monitoreo de riesgo. Por eso el enfoque obliga tool-calling estricto para cualquier dato numérico.

## Scope

### In Scope

- Nuevo router FastAPI (`src/api/routers/assistant.py`) montado en el proceso backend existente, siguiendo el patrón de `areas.py`.
- Integración directa con la Messages API de Anthropic (tool_use / function calling), SIN LangChain ni LangGraph.
- Tool `buscar_eventos(min_magnitude, since_hours, near_station=None, near_lat=None, near_lon=None, radius_km=None)` que invoca `EventStore.recent()` (src/services/event_store.py) y aplica filtro de distancia en Python (patrón haversine ya usado en `event_store.py.candidates_around`) cuando se pide cercanía a una estación o coordenada.
- Tool `buscar_picks(channel)` sobre `SignalPickService.list_for_window` (src/services/signal_picks.py), que SIEMPRE inyecta `user_id` desde la sesión autenticada en el backend — el LLM nunca elige ni ve ese parámetro.
- Loop de tool-calling propio (sin SDK de orquestación) dentro del router: recibe la pregunta del usuario, la pasa al modelo con las tools declaradas, ejecuta las tools solicitadas, devuelve los resultados al modelo y retorna la respuesta final.
- Autenticación de los nuevos endpoints usando el patrón existente en `src/api/deps.py` (`get_current_user` obligatorio, dado que `buscar_picks` requiere identidad de usuario).
- Reglas explícitas de grounding: el modelo NO puede afirmar magnitudes, fechas, ubicaciones o valores numéricos sin que provengan de un resultado de tool. Prompt de sistema que refuerza esto.

### Out of Scope

- LangChain, LangGraph o cualquier framework de orquestación de agentes.
- Streaming de la respuesta (SSE/WebSocket) — se define en Open Questions, no se implementa en este change salvo que se resuelva a favor.
- Cacheo de resultados de tools — se define en Open Questions.
- Que el asistente responda sobre picks de usuarios distintos al autenticado (rol admin) — se define en Open Questions.
- Frontend: cualquier componente de chat/UI en `dashboard/` queda fuera de este change (se abordará en un change posterior una vez validado el backend).
- Selección final de modelo Anthropic y estimación de costo en producción — pendiente de cargar el skill `claude-api` en la fase de diseño.
- Cualquier tool que escriba datos (el asistente es de solo lectura sobre datos ya persistidos).

## Approach

Function calling directo contra la Anthropic Messages API (tool_use), implementado como un `APIRouter` nuevo dentro del proceso FastAPI actual — no un servicio separado, no un framework de agentes.

Razones (ya evaluadas y decididas, no reabrir en diseño):
- El set de tools es pequeño y fijo; no justifica el overhead operativo de LangChain/LangGraph.
- Reusa `app.state.event_store` y `SignalPickService` sin reimplementar SQL ni pasar por HTTP interno.
- Un loop de tool-calling propio es más auditable para grounding estricto que delegar el control de flujo a un framework externo.
- Es coherente con el resto del backend, que usa `httpx` puro para integraciones externas (USGS/INPRES/EMSC) sin SDKs pesados de orquestación.

Asimetría de permisos a respetar en el diseño: `seismic_events` es un dato público/global (sin `user_id`), mientras que `signal_picks` tiene ownership real (`WHERE user_id = $1`). La tool de eventos puede tomar filtros libres del LLM; la tool de picks NUNCA debe aceptar `user_id` como parámetro elegible por el modelo — debe inyectarse server-side desde la sesión, igual que hace `SignalPickService.list_for_window` hoy vía `deps.py`.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/api/routers/assistant.py` | New | Router nuevo con endpoint(s) del asistente conversacional, montado igual que `areas.py` |
| `src/main.py` | Modified | Registrar el nuevo router y, si aplica, inicializar cliente de Anthropic en `app.state` |
| `src/services/event_store.py` | Read-only (reused) | `EventStore.recent()` se invoca directo desde la tool `buscar_eventos`, sin pasar por HTTP |
| `src/services/signal_picks.py` | Read-only (reused) | `SignalPickService.list_for_window` se invoca desde la tool `buscar_picks`, con `user_id` inyectado por el backend |
| `src/api/deps.py` | Reused | `get_current_user` protege los endpoints del asistente (picks requieren identidad) |
| `requirements.txt` / `requirements-minimal.txt` | Modified | Agregar dependencia del SDK de Anthropic (`anthropic`) — hoy el proyecto tiene CERO dependencias de LLM |
| `src/models/` | Possibly New | Modelos Pydantic de request/response del asistente (pregunta, respuesta, tool calls ejecutados) |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Alucinación de datos numéricos (magnitud, fecha, ubicación) por el LLM | Med | Tool-calling obligatorio para cualquier dato numérico; prompt de sistema explícito; el diseño debe incluir un mecanismo de verificación de que la respuesta final solo cita valores presentes en resultados de tools |
| Fuga de picks de un usuario hacia otro usuario | Low (si se implementa como se especifica) | `user_id` NUNCA es parámetro del LLM; se inyecta server-side siempre, sin excepción, hasta que se resuelva la Open Question de rol admin |
| Costo/latencia impredecible de la API de Anthropic en producción | Med | Cargar skill `claude-api` en fase de diseño para elegir modelo y estimar costo antes de implementar; considerar límites de uso por usuario/sesión |
| `seismic_events` cambia constantemente (ingesta continua) y las respuestas pueden quedar desactualizadas si se cachea mal | Low | Ver Open Question de TTL de cache; por defecto (sin cache) no hay riesgo de datos stale |
| Nueva dependencia externa (Anthropic API) introduce un punto de falla en el backend | Med | Manejo de errores explícito en el router (timeout, rate limit, API caída) devolviendo error honesto al usuario, no una respuesta silenciosa o inventada |

## Rollback Plan

El asistente es aditivo: un router nuevo, tools nuevas, sin modificar contratos ni tablas existentes. Rollback consiste en:
1. Desregistrar el router `assistant` de `src/main.py` (una línea).
2. Remover la dependencia `anthropic` de requirements si no se usa en ningún otro lado.
3. No hay migraciones de base de datos involucradas en este change (se reusa `seismic_events` y `signal_picks` tal cual existen) — nada que revertir en TimescaleDB.
4. Si se detecta alucinación en producción antes de poder arreglarla, el router puede desactivarse por feature flag o remoción directa sin afectar el resto del dashboard.

## Dependencies

- Cuenta y API key de Anthropic configurada como variable de entorno en Railway (no existe hoy en el proyecto).
- Skill `claude-api` debe cargarse en la fase de diseño para decidir modelo y pricing actuales antes de fijar el approach de costos.
- Ninguna dependencia de LangChain/LangGraph (explícitamente excluidas).

## Open Questions

1. ¿Streaming de la respuesta (SSE/WS) o respuesta completa (request/response simple)?
2. ¿Cachear resultados de tool calls con TTL corto (30-60s), dado que `seismic_events` cambia constantemente por la ingesta continua? ¿O se resuelve sin cache dado el volumen esperado de uso?
3. ¿El asistente debe poder responder sobre picks de OTROS usuarios (caso admin)? Si la respuesta es sí, requiere una tool separada que use `require_role` de `deps.py`, con params explícitos y auditoría de que un admin efectivamente lo es antes de exponer datos de otro usuario.
4. ¿Qué modelo de Anthropic usar y cuál es la estimación de costo por consulta/sesión? Pendiente: cargar el skill `claude-api` en la fase de diseño para tomar esta decisión con datos de pricing y capacidades actuales, no de memoria.

## Success Criteria

- [ ] El asistente responde preguntas sobre eventos sísmicos recientes (magnitud, ventana horaria, cercanía a estación/coordenadas) usando exclusivamente datos de `buscar_eventos`, verificable porque cada dato numérico en la respuesta es rastreable a un resultado de tool.
- [ ] El asistente responde preguntas sobre picks del usuario autenticado usando `buscar_picks`, sin que el `user_id` sea nunca un valor que el LLM pueda elegir o filtrar.
- [ ] Ante una pregunta fuera del alcance de las tools disponibles (ej. predicción de sismos futuros), el asistente responde honestamente que no tiene esa capacidad, sin inventar una respuesta.
- [ ] Los endpoints nuevos están protegidos con el mismo patrón de autenticación que el resto del backend (`get_current_user`).
- [ ] Las 4 Open Questions quedan resueltas antes de pasar de diseño a implementación (tasks).

# Mutation log: feedback-screenshot-attachment

## Baseline (2026-09-03, ANTES de tocar cualquier archivo)

Comando: `./venv/bin/python -m pytest tests/ -q -p no:cacheprovider --no-cov`

Resultado real de HOY (rama `feat/feedback-screenshot-attachment`, recién
creada desde `main` en `3456b04`):

```
9 failed, 1181 passed, 2 skipped, 8 warnings in 121.33s (0:02:01)
```

**No usar el `1181 passed` de `feedback-beta-testers` como referencia** —
que hoy coincida con ese número es casualidad de esta corrida, no una
suposición: se corrió fresco, en esta rama, después del merge de
`feedback-beta-testers` (#46) y del commit `3456b04`.

### Fallos preexistentes (NO atribuibles a este change)

Los 9 fallos están confinados a `tests/unit/test_ws_events.py`, sin relación
con `feedback` ni con este change:

- `TestSnapshot::test_el_snapshot_llega_primero_y_con_su_sobre`
- `TestSnapshot::test_sin_base_manda_un_snapshot_vacio_en_vez_de_cerrar`
- `TestSnapshot::test_un_fallo_del_snapshot_no_tumba_la_conexion`
- `TestStream::test_los_eventos_nuevos_llegan_con_su_propio_sobre`
- `TestStream::test_se_suscribe_al_canal_del_worker`
- `TestEventsRecent::test_devuelve_los_eventos_de_la_tabla`
- `TestEventsRecent::test_sin_base_devuelve_503_y_NO_lista_vacia`
- `TestEventsRecent::test_pasa_los_filtros_al_store`
- `TestEventsRecent::test_rechaza_una_ventana_absurda`

Inspeccionado uno (`TestSnapshot::test_el_snapshot_llega_primero_y_con_su_sobre`)
en corrida aislada: mismo resultado, con un `RuntimeError: Event loop is
closed` en el teardown de una conexión Redis async (`redis.asyncio`) — pinta
a un problema de entorno/fixture de ese suite (Redis no disponible o
teardown desordenado), no a una regresión de código de producto. Cualquier
fallo futuro en `tests/unit/test_ws_events.py` durante este change NO cuenta
como regresión propia — ya estaba roto en la baseline.

### Fallos que SÍ importan a este change

Ninguno de los 9 toca `feedback`, `screenshot_key`, migraciones, o
`src/services/feedback_service.py` / `src/models/feedback.py` /
`src/api/routers/feedback.py`. Baseline limpia para el propósito de este
change: cualquier fallo nuevo en `tests/integration/test_feedback_*` o
`tests/unit/test_feedback_*` / `tests/unit/test_screenshot_storage.py` es
atribuible a este change.

## Tabla de mutaciones

| # | Archivo | Mutación | Salida de `rg` (confirma el cambio) | Test que se puso rojo | Revertido |
|---|---|---|---|---|---|
| M1 | `src/api/routers/feedback.py` | pendiente (Fase 2) | — | — | — |
| M2 | `src/api/routers/feedback.py` | pendiente (Fase 2) | — | — | — |
| M3 | `src/models/feedback.py` | pendiente (Fase 2) | — | — | — |
| M4 | `src/services/feedback_service.py` | pendiente (Fase 2) | — | — | — |
| M5 | `src/api/routers/feedback.py` | pendiente (Fase 2) | — | — | — |
| M6 | `src/api/routers/feedback.py` | pendiente (Fase 2) | — | — | — |
| M7 | `src/services/feedback_service.py` | pendiente (Fase 2) | — | — | — |
| M8 | `dashboard/lib/screenshot.ts` | pendiente (Fase 3) | — | — | — |
| M9 | `dashboard/lib/screenshot.ts` | pendiente (Fase 3) | — | — | — |
| M10 | `dashboard/lib/screenshot.ts` | pendiente (Fase 3) | — | — | — |
| M11 | `dashboard/components/feedback/FeedbackWidget.tsx` | pendiente (Fase 3) | — | — | — |
| M12 | `dashboard/components/feedback/FeedbackWidget.tsx` | pendiente (Fase 3) | — | — | — |
| M13 | `dashboard/components/feedback/FeedbackCard.tsx` | pendiente (Fase 4) | — | — | — |
| M14 | `dashboard/components/feedback/FeedbackCardDetail.tsx` | pendiente (Fase 4) | — | — | — |

Mecánica (idéntica a `feedback-beta-testers`): `sd -s` en modo LITERAL (sin
`-s` los paréntesis se leen como regex y la mutación no muta), `rm -rf
**/__pycache__` entre corridas (mismo segundo sirve el `.pyc` viejo), `rg`
que confirma el cambio ANTES de correr el test mutado, test rojo con la
aserción exacta, reversión verificada por `cmp` contra un snapshot tomado
antes de mutar, verde posterior. Si una mutación no pone rojo ningún test,
se arregla el test — nunca se anota como "pasada".

## Fase 1 — Migración 020 (CERRADA, 2026-09-03)

- **1.2 (RED)**: `tests/integration/test_feedback_screenshot_migration.py`
  creado; `4 failed in 3.54s`, los cuatro por
  `psycopg2.errors.UndefinedColumn: column "screenshot_key" of relation
  "feedback_reports" does not exist` — razón correcta, no error de setup.
- **1.3 (GREEN)**: `deploy/sql/migrations/020_feedback_screenshot.sql`
  creado (`ALTER TABLE feedback_reports ADD COLUMN IF NOT EXISTS
  screenshot_key TEXT NULL;`). Suite del archivo: `4 passed in 3.25s`,
  incluyendo la segunda ejecución REAL de `apply_migrations` (no-op,
  `screenshot_key` sobrevive intacta).
- **Mutación 020**: NO aplica (declarado en tasks.md 1.3) — se verifica por
  ejecución real doble del aplicador (mismo criterio que 019); mutar `ADD
  COLUMN IF NOT EXISTS` no agrega información que el escenario (d) de 1.2 no
  dé ya.
- **1.4 (gate)**: `ruff format` reformateó el archivo de test (1 file
  reformatted); `ruff check` limpio; `rm -rf
  tests/integration/__pycache__` + rerun ⇒ `4 passed in 4.55s` (sin .pyc
  viejo sirviéndose).

Estado al cerrar: baseline registrada; `feedback_reports` tiene la columna
`screenshot_key` en la base del testcontainer; idempotencia probada por
doble ejecución real del aplicador. Listo para Fase 2.

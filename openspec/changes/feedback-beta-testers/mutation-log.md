# Mutation log — feedback-beta-testers

## Baseline (tarea 1.1) — 2026-09-03 12:04 UTC, rama `feat/feedback-kanban-beta` recién creada desde `main` (b5624e7), working tree sin tocar

Comando: `./venv/bin/python -m pytest tests/ -q -p no:cacheprovider --no-cov`

Resultado REAL: **9 failed, 1069 passed, 2 skipped, 8 warnings in 125.57s (0:02:05)**

Fallos preexistentes (NO atribuibles a este change — fallan también corriendo el
archivo solo, con `RuntimeError: Event loop is closed`; es la trampa documentada de
`with TestClient(main.app)` que dispara el lifespan real):

- `tests/unit/test_ws_events.py::TestSnapshot::test_el_snapshot_llega_primero_y_con_su_sobre`
- `tests/unit/test_ws_events.py::TestSnapshot::test_sin_base_manda_un_snapshot_vacio_en_vez_de_cerrar`
- `tests/unit/test_ws_events.py::TestSnapshot::test_un_fallo_del_snapshot_no_tumba_la_conexion`
- `tests/unit/test_ws_events.py::TestStream::test_los_eventos_nuevos_llegan_con_su_propio_sobre`
- `tests/unit/test_ws_events.py::TestStream::test_se_suscribe_al_canal_del_worker`
- `tests/unit/test_ws_events.py::TestEventsRecent::test_devuelve_los_eventos_de_la_tabla`
- `tests/unit/test_ws_events.py::TestEventsRecent::test_sin_base_devuelve_503_y_NO_lista_vacia`
- `tests/unit/test_ws_events.py::TestEventsRecent::test_pasa_los_filtros_al_store`
- `tests/unit/test_ws_events.py::TestEventsRecent::test_rechaza_una_ventana_absurda`

Ningún otro fallo previo. Todo fallo nuevo que aparezca fuera de esa lista sí es de este change.

## Mutaciones críticas (M1–M18 del design)

Mecánica: `sd -s` (modo literal), `rm -rf src/**/__pycache__` entre corridas, `rg` que
confirme que el archivo cambió, test rojo, reversión, verde. Una mutación que no pone rojo
ningún test NO se anota como pasada: se arregla el test.

| # | archivo | mutación | salida del rg | test que se puso rojo | revertido |
|---|---------|----------|---------------|-----------------------|-----------|
| M1 | | | | | |
| M2 | | | | | |
| M3 | | | | | |
| M4 | | | | | |
| M5 | | | | | |
| M6 | | | | | |
| M7 | | | | | |
| M8 | | | | | |
| M9 | | | | | |
| M10 | | | | | |
| M11 | | | | | |
| M12 | | | | | |
| M13 | | | | | |
| M14 | | | | | |
| M15 | | | | | |
| M16 | | | | | |
| M17 | | | | | |
| M18 | | | | | |

Fase 1 no lleva mutaciones (1.3 y 1.4 son SQL declarativo verificado por ejecución real
doble y por `CHECK` probados con SQL directo; ver justificación en `tasks.md`).

"""Routers de FastAPI.

Paquete nuevo en AOI-1. Hasta acá los ~30 endpoints del proyecto vivían con
`@app.get` directo en src/main.py, que ya pasa las 1400 líneas. `/areas` es el
primer grupo que se monta como APIRouter; los existentes NO se migran en este
change (sería un refactor de toda la superficie de la API, con su propio
riesgo, y no es lo que AOI-1 necesita).
"""

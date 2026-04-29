# Correcciones Realizadas

Este documento detalla todas las correcciones aplicadas para hacer funcionar el servicio correctamente.

## Problemas Encontrados y Soluciones

### 1. Incompatibilidad con Python 3.14

**Problema**: Python 3.14 es demasiado nuevo y pydantic-core no puede compilarse (requiere hasta Python 3.13).

**Solución**:
- Actualizado `scripts/run-local.sh` para usar Python 3.11 preferentemente
- Python 3.11 es la versión recomendada para producción (LTS, máxima compatibilidad)

### 2. Problemas de compilación: lxml y psycopg2-binary

**Problema**:
- `lxml==5.3.0` falla al compilar en macOS con Python 3.14 (incompatibilidad de punteros de función)
- `psycopg2-binary==2.9.9` también falla en compilación

**Solución**:
- Creado `requirements-minimal.txt` con dependencias core sin paquetes problemáticos
- Reemplazado `lxml` por `html5lib` para parsing HTML (más portable)
- Eliminado `psycopg2-binary` (solo necesario si se usa TimescaleDB, opcional)
- Actualizado `src/adapters/inpres_adapter.py` línea 72: `BeautifulSoup(html, "html5lib")`

### 3. Paquete de testing incorrecto

**Problema**: `httpx-mock==0.16.0` no existe en PyPI

**Solución**:
- Cambiado a `pytest-httpx==0.30.0` (paquete correcto para mockear httpx en tests)

### 4. INPRES adapter no disponible en desarrollo local

**Problema**:
- Por defecto `.env` apunta a `http://inpres-adapter:8001/recent` (contenedor Docker)
- En desarrollo local sin Docker, esto genera errores de conexión

**Solución**:
- Actualizado `.env` para dejar `INPRES_PROXY_URL` vacío por defecto
- El servicio detecta automáticamente cuando INPRES no está configurado y corre en modo USGS-only
- Log warning: "⚠️ INPRES proxy not configured - running USGS-only mode"

### 5. Script run-local.sh no detectaba Python correcto

**Problema**: Script usaba `python3` genérico que puede ser cualquier versión

**Solución**:
- Actualizado para detectar `python3.11` primero, fallback a `python3`
- Muestra versión de Python que está usando
- Usa `requirements-minimal.txt` en lugar de `requirements.txt`

## Archivos Modificados

1. **requirements-minimal.txt** (NUEVO)
   - Dependencias core sin lxml, psycopg2, testing libs
   - Incluye html5lib como parser alternativo

2. **requirements.txt**
   - Línea 27: Cambiado `httpx-mock==0.16.0` → `pytest-httpx==0.30.0`

3. **src/adapters/inpres_adapter.py**
   - Línea 72: `BeautifulSoup(html, "lxml")` → `BeautifulSoup(html, "html5lib")`

4. **.env**
   - Línea 18-19: `INPRES_PROXY_URL=` (vacío, con comentario explicativo)

5. **scripts/run-local.sh**
   - Líneas 8-16: Detección inteligente de Python 3.11
   - Línea 32: Usa `requirements-minimal.txt`

## Estado Actual

✅ **Servicio funcionando correctamente**

- API corriendo en http://localhost:8000
- Endpoints operativos:
  - `GET /health` → "ok"
  - `GET /` → Info del servicio
  - `GET /report` → Reporte completo con KPIs
  - `GET /events` → Lista de eventos
  - `GET /alerts` → Alertas activas
  - `GET /metrics` → Prometheus metrics
  - `GET /docs` → Swagger UI

- Modo actual: **USGS-only** (INPRES opcional)
- Sin errores de dependencias
- Sin errores de compilación

## Cómo Ejecutar

### Opción 1: Script automatizado (recomendado)

```bash
./scripts/run-local.sh
```

### Opción 2: Manual

```bash
# Crear venv con Python 3.11
python3.11 -m venv venv

# Activar
source venv/bin/activate

# Instalar dependencias mínimas
pip install --upgrade pip setuptools wheel
pip install -r requirements-minimal.txt

# Crear .env (si no existe)
cp .env.example .env

# Ejecutar servicio
python -m uvicorn src.main:app --host 0.0.0.0 --port 8000
```

## Para Producción

Para producción con Docker, usar `requirements.txt` completo:

```bash
# Docker usa Ubuntu con Python 3.11 pre-instalado
docker-compose -f deploy/docker/docker-compose.yml up
```

En Docker, lxml y psycopg2-binary compilan sin problemas porque tienen las librerías del sistema necesarias.

## Dependencias Opcionales Removidas de Minimal

Estas solo son necesarias en escenarios específicos:

- `lxml` → Solo si scraping HTML complejo (reemplazado por html5lib)
- `psycopg2-binary` / `asyncpg` → Solo si usas TimescaleDB para histórico
- `pytest*` → Solo para desarrollo/testing
- `black`, `ruff`, `mypy` → Solo para desarrollo/linting

## Testing

Para ejecutar tests, instalar dependencias de desarrollo:

```bash
pip install -r requirements.txt  # Full con testing libs
pytest
```

Nota: Tests unitarios NO requieren lxml ni psycopg2, así que deberían funcionar incluso con requirements-minimal.txt + pytest.

## Troubleshooting

### Si ves errores de compilación

1. Verifica versión de Python: `python --version` (debe ser 3.11.x)
2. Usa requirements-minimal.txt
3. En macOS, instala Xcode Command Line Tools: `xcode-select --install`

### Si USGS no responde

Esto es normal si:
- No hay actividad sísmica en la región en la última hora
- USGS API está temporalmente lento

El servicio responde con `eventos: []` pero sin errores.

### Para usar INPRES

1. Levantar el adapter: `docker-compose -f deploy/docker/docker-compose.yml up inpres-adapter`
2. Configurar en .env: `INPRES_PROXY_URL=http://localhost:8001/recent`
3. Reiniciar servicio

---

**Última actualización**: 2025-10-28
**Versión probada**: Python 3.11.14, macOS 15.0 (arm64)

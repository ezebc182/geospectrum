#!/bin/bash
# Script para ejecutar el servicio localmente (desarrollo)

set -e

echo "🚀 Starting Seismic Monitor (local development)"

# Verificar Python 3.11
if command -v python3.11 &> /dev/null; then
    PYTHON_CMD=python3.11
elif command -v python3 &> /dev/null; then
    PYTHON_CMD=python3
else
    echo "❌ Python 3 no encontrado"
    exit 1
fi

echo "📦 Using $PYTHON_CMD ($(${PYTHON_CMD} --version))"

# Crear venv si no existe
if [ ! -d "venv" ]; then
    echo "📦 Creando virtual environment..."
    ${PYTHON_CMD} -m venv venv
fi

# Activar venv
source venv/bin/activate

# Instalar dependencias
echo "📦 Instalando dependencias..."
pip install -q --upgrade pip setuptools wheel
pip install -q -r requirements-minimal.txt

# Copiar .env.example si no existe .env
if [ ! -f ".env" ]; then
    echo "📝 Creando .env desde .env.example..."
    cp .env.example .env
fi

# Ejecutar servicio
echo "✅ Iniciando servicio en http://localhost:8000"
echo "   Docs: http://localhost:8000/docs"
echo "   Health: http://localhost:8000/health"
echo ""

python -m uvicorn src.main:app --reload --host 0.0.0.0 --port 8000

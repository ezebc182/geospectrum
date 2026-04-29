#!/bin/bash
# Script para iniciar el Dashboard de Seismic Monitor en puerto 3008

set -e

cd "$(dirname "$0")"

echo "🌐 Starting Seismic Monitor Dashboard"
echo ""
echo "📍 Dashboard will be available at: http://localhost:3008"
echo "🔌 Make sure the backend is running at: http://localhost:8000"
echo ""
echo "Press Ctrl+C to stop"
echo ""

# Instalar dependencias si node_modules no existe
if [ ! -d "node_modules" ]; then
    echo "📦 Installing dependencies..."
    npm install
    echo ""
fi

# Iniciar en puerto 3008
npm run dev

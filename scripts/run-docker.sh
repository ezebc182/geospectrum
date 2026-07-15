#!/bin/bash
# Script para ejecutar el servicio con Docker Compose

set -e

echo "🐳 Starting GeoSpectrum with Docker Compose"

cd "$(dirname "$0")/.."

# Build y start
docker-compose -f deploy/docker/docker-compose.yml build
docker-compose -f deploy/docker/docker-compose.yml up -d

echo ""
echo "✅ Services started:"
echo "   Main API:       http://localhost:8000"
echo "   API Docs:       http://localhost:8000/docs"
echo "   Health:         http://localhost:8000/health"
echo "   INPRES Adapter: http://localhost:8001"
echo ""
echo "Logs:"
echo "   docker-compose -f deploy/docker/docker-compose.yml logs -f"
echo ""
echo "Stop:"
echo "   docker-compose -f deploy/docker/docker-compose.yml down"

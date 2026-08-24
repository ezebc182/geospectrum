#!/bin/bash
# Supervisor del ingestor SeedLink para desarrollo local.
#
# POR QUÉ EXISTE: el 2026-08-21 04:31 UTC el ingestor local murió y nadie se
# enteró durante 66 horas. La app siguió mostrando espectrogramas de tres días
# atrás con la misma cara que datos en vivo. No fue un bug del ingestor —
# `run-local.sh` levanta SOLO el API y el ingestor se lanzaba a mano, así que
# al cerrar la terminal (o dormirse la Mac) se iba sin que nada lo repusiera.
#
# En producción esto no pasa: Railway corre el ingestor como servicio aparte
# (deploy/docker/Dockerfile.seedlink) y lo reinicia cuando el proceso sale con
# error. Este script es el equivalente local de ese supervisor.
#
# Uso:
#   ./scripts/run-ingestor.sh              # en primer plano (Ctrl+C corta)
#   ./scripts/run-ingestor.sh --background # suelto, log en logs/
#
# Requisitos: TimescaleDB en el 5433 y Redis en el 6379 (ver .env).

set -uo pipefail
cd "$(dirname "$0")/.."

LOG_DIR="logs"
LOG_FILE="$LOG_DIR/seedlink_ingestor.log"
PID_FILE="$LOG_DIR/seedlink_ingestor.pid"

# Un ingestor que muere y revive en bucle es tan silencioso como uno muerto:
# tras este límite el script se rinde y lo dice fuerte, en vez de disfrazar un
# problema de configuración (Redis caído, credenciales mal) de "ya reinicia".
MAX_RESTARTS=10

# Reinicios más rápidos que esto cuentan como fallo de arranque, no como caída
# tras haber trabajado bien: el contador solo se resetea si el proceso vivió al
# menos este tiempo.
HEALTHY_UPTIME_SECONDS=60

RESTART_DELAY_SECONDS=5

mkdir -p "$LOG_DIR"

# El ingestor bufferiza stdout cuando no escribe a una TTY —o sea, siempre que
# se redirige a un archivo— y los logs se pierden si muere antes de llenar el
# buffer. Mismo motivo que el ENV del Dockerfile.seedlink.
export PYTHONUNBUFFERED=1

if [ ! -x "venv/bin/python" ]; then
    echo "❌ No existe venv/bin/python — corré primero ./scripts/run-local.sh"
    exit 1
fi

# Un segundo ingestor duplicaría cada columna en la base y competiría por las
# mismas suscripciones SeedLink.
if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "❌ Ya hay un ingestor corriendo (PID $(cat "$PID_FILE"))"
    echo "   Para pararlo:  kill \$(cat $PID_FILE)"
    exit 1
fi

supervise() {
    local restarts=0

    while true; do
        local started_at
        started_at=$(date +%s)

        echo "▶️  $(date -u '+%Y-%m-%dT%H:%M:%SZ') arrancando el ingestor (reinicio #$restarts)"
        ./venv/bin/python -m src.services.seedlink_ingestor
        local exit_code=$?

        local uptime=$(( $(date +%s) - started_at ))

        if [ $exit_code -eq 0 ]; then
            # El ingestor NUNCA debería salir con 0: su __main__ termina con un
            # raise justamente para que una salida limpia sea imposible. Si pasa,
            # es una regresión de esa defensa y hay que verla, no reiniciarla.
            echo "⚠️  Salió con código 0 — eso no debería poder pasar."
            echo "   Revisá el raise final de src/services/seedlink_ingestor.py"
            return 0
        fi

        # Solo un proceso que trabajó de verdad merece perdonar sus reinicios;
        # si no, un fallo de arranque agotaría el presupuesto en un minuto.
        if [ $uptime -ge $HEALTHY_UPTIME_SECONDS ]; then
            restarts=0
        else
            restarts=$(( restarts + 1 ))
        fi

        if [ $restarts -ge $MAX_RESTARTS ]; then
            echo "❌ $MAX_RESTARTS arranques fallidos seguidos (código $exit_code)."
            echo "   Esto no se arregla reiniciando: revisá el log en $LOG_FILE"
            echo "   Sospechosos habituales: TimescaleDB (5433) o Redis (6379) caídos."
            return 1
        fi

        echo "🔁 Murió con código $exit_code tras ${uptime}s — reintento en ${RESTART_DELAY_SECONDS}s"
        sleep $RESTART_DELAY_SECONDS
    done
}

if [ "${1:-}" = "--background" ]; then
    supervise >> "$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
    echo "✅ Ingestor supervisado en background (PID $(cat "$PID_FILE"))"
    echo "   Log:      tail -f $LOG_FILE"
    echo "   Pararlo:  kill \$(cat $PID_FILE)"
    echo ""
    echo "   Verificá que ESCRIBE (un log lindo no alcanza):"
    echo "   curl -s localhost:8000/spectrograms/live-channels | head -c 200"
else
    supervise 2>&1 | tee -a "$LOG_FILE"
fi

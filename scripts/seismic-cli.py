#!/usr/bin/env python3
"""
CLI cliente para Seismic Monitor Service.

Uso:
    python scripts/seismic-cli.py report
    python scripts/seismic-cli.py events
    python scripts/seismic-cli.py alerts
    python scripts/seismic-cli.py watch --interval 60
"""
import httpx
import json
import sys
import time
import argparse
from typing import Optional
from datetime import datetime


class SeismicCLI:
    """Cliente CLI para interactuar con Seismic Monitor API."""

    def __init__(self, base_url: str = "http://localhost:8000"):
        self.base_url = base_url
        self.client = httpx.Client(timeout=10.0)

    def health(self) -> bool:
        """Check health del servicio."""
        try:
            response = self.client.get(f"{self.base_url}/health")
            return response.status_code == 200
        except Exception:
            return False

    def get_report(self) -> Optional[dict]:
        """Obtener reporte completo."""
        try:
            response = self.client.get(f"{self.base_url}/report")
            response.raise_for_status()
            return response.json()
        except Exception as e:
            print(f"❌ Error: {e}", file=sys.stderr)
            return None

    def get_events(self) -> Optional[list]:
        """Obtener solo eventos."""
        try:
            response = self.client.get(f"{self.base_url}/events")
            response.raise_for_status()
            return response.json()
        except Exception as e:
            print(f"❌ Error: {e}", file=sys.stderr)
            return None

    def get_alerts(self) -> Optional[list]:
        """Obtener solo alertas."""
        try:
            response = self.client.get(f"{self.base_url}/alerts")
            response.raise_for_status()
            return response.json()
        except Exception as e:
            print(f"❌ Error: {e}", file=sys.stderr)
            return None

    def print_report(self, report: dict) -> None:
        """Pretty-print reporte completo."""
        print("\n" + "=" * 80)
        print("🌍 SEISMIC MONITOR REPORT")
        print("=" * 80)

        print(f"\n⏰ Generated: {report['timestamp_utc_generacion']}")

        # Región
        region = report['region_monitorizada']
        print(f"\n📍 Region: [{region['minlat']}, {region['maxlat']}] x [{region['minlon']}, {region['maxlon']}]")

        # Errores de fuentes
        if report['data_source_errors']:
            print(f"\n⚠️  Data source errors: {', '.join(report['data_source_errors'])}")

        # KPIs
        kpis = report['kpis']
        print("\n" + "-" * 80)
        print("📊 KPIs")
        print("-" * 80)
        print(f"Total eventos:          {kpis['total_eventos']}")
        print(f"Tasa por hora:          {kpis['tasa_eventos_por_hora']:.2f}")
        print(f"Magnitud máxima:        {kpis['magnitud_max'] if kpis['magnitud_max'] is not None else 'N/A'}")

        mag_pond = kpis['magnitud_promedio_ponderada_por_energia']
        mag_pond_str = f"{mag_pond:.2f}" if mag_pond is not None else "N/A"
        print(f"Mag promedio ponderada: {mag_pond_str}")

        prof = kpis['profundidad_media_M_ge_4']
        prof_str = f"{prof:.1f} km" if prof is not None else "N/A"
        print(f"Prof media M≥4:         {prof_str}")

        print(f"Eventos sentidos:       {kpis['eventos_sentidos']} ({kpis['porcentaje_eventos_sentidos']*100:.1f}%)")

        min_m5 = kpis['minutos_desde_M_ge_5']
        min_m5_str = f"{min_m5:.0f} min" if min_m5 is not None else "N/A"
        print(f"Último M≥5 hace:        {min_m5_str}")

        # Alertas
        alertas = report['alertas']
        if alertas:
            print("\n" + "-" * 80)
            print("🚨 ALERTAS ACTIVAS")
            print("-" * 80)
            for alerta in alertas:
                print(f"\n[{alerta['tipo'].upper()}]")
                print(f"  {alerta['descripcion']}")
                print(f"  Eventos: {len(alerta['eventos_relacionados'])}")
        else:
            print("\n✅ No hay alertas activas")

        # Eventos
        eventos = report['eventos']
        if eventos:
            print("\n" + "-" * 80)
            print(f"📋 EVENTOS ({len(eventos)} total)")
            print("-" * 80)
            for ev in eventos[:10]:  # Mostrar solo primeros 10
                fuentes_str = "+".join(ev['fuentes'])
                sentido_str = "👥" if ev['sentido'] else ""
                revisado_str = "✓" if ev['revisado'] else "~"
                print(f"{revisado_str} M{ev['mag']:.1f} | {ev['hora_utc'][:19]} | {ev['lugar'][:50]} | [{fuentes_str}] {sentido_str}")

            if len(eventos) > 10:
                print(f"  ... y {len(eventos) - 10} más")

        print("\n" + "=" * 80 + "\n")

    def print_events_table(self, events: list) -> None:
        """Pretty-print tabla de eventos."""
        print("\n📋 EVENTOS SÍSMICOS")
        print("-" * 120)
        print(f"{'Time (UTC)':<20} {'Mag':<6} {'Depth':<8} {'Lat':<10} {'Lon':<10} {'Location':<40} {'Sources':<10}")
        print("-" * 120)

        for ev in events:
            time_str = ev['hora_utc'][:19]
            mag_str = f"{ev['mag']:.1f}"
            depth_str = f"{ev['prof_km']:.0f} km" if ev['prof_km'] else "N/A"
            lat_str = f"{ev['lat']:.3f}"
            lon_str = f"{ev['lon']:.3f}"
            loc_str = (ev['lugar'] or "Unknown")[:40]
            sources_str = "+".join(ev['fuentes'])

            print(f"{time_str:<20} {mag_str:<6} {depth_str:<8} {lat_str:<10} {lon_str:<10} {loc_str:<40} {sources_str:<10}")

        print("-" * 120)
        print(f"Total: {len(events)} eventos\n")

    def print_alerts_list(self, alerts: list) -> None:
        """Pretty-print lista de alertas."""
        if not alerts:
            print("\n✅ No hay alertas activas\n")
            return

        print("\n🚨 ALERTAS ACTIVAS")
        print("-" * 80)

        for alerta in alerts:
            print(f"\n[{alerta['tipo'].upper()}]")
            print(f"  {alerta['descripcion']}")
            print(f"  Eventos relacionados: {len(alerta['eventos_relacionados'])}")

        print("-" * 80 + "\n")

    def watch(self, interval: int = 60) -> None:
        """Modo watch: monitorear continuamente."""
        print(f"👀 Watching seismic activity (interval: {interval}s)")
        print("Press Ctrl+C to stop\n")

        try:
            while True:
                if not self.health():
                    print(f"[{datetime.now().isoformat()}] ⚠️  Service unavailable")
                    time.sleep(interval)
                    continue

                report = self.get_report()
                if report:
                    kpis = report['kpis']
                    alertas = report['alertas']

                    status = "🚨 ALERT" if alertas else "✅ OK"
                    print(f"[{datetime.now().isoformat()}] {status} | Events: {kpis['total_eventos']} | Max mag: {kpis['magnitud_max']} | Alerts: {len(alertas)}")

                    if alertas:
                        for alerta in alertas:
                            print(f"  └─ [{alerta['tipo']}] {alerta['descripcion']}")

                time.sleep(interval)

        except KeyboardInterrupt:
            print("\n\nStopped.")


def main():
    parser = argparse.ArgumentParser(
        description="Seismic Monitor CLI Client",
        formatter_class=argparse.RawDescriptionHelpFormatter
    )

    parser.add_argument(
        "--url",
        default="http://localhost:8000",
        help="Base URL del servicio (default: http://localhost:8000)"
    )

    subparsers = parser.add_subparsers(dest="command", help="Comando a ejecutar")

    # health
    subparsers.add_parser("health", help="Check health del servicio")

    # report
    subparsers.add_parser("report", help="Obtener reporte completo")

    # events
    subparsers.add_parser("events", help="Obtener solo eventos")

    # alerts
    subparsers.add_parser("alerts", help="Obtener solo alertas")

    # watch
    watch_parser = subparsers.add_parser("watch", help="Monitorear continuamente")
    watch_parser.add_argument(
        "--interval",
        type=int,
        default=60,
        help="Intervalo en segundos (default: 60)"
    )

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(1)

    cli = SeismicCLI(base_url=args.url)

    # Ejecutar comando
    if args.command == "health":
        if cli.health():
            print("✅ Service is healthy")
            sys.exit(0)
        else:
            print("❌ Service is down")
            sys.exit(1)

    elif args.command == "report":
        report = cli.get_report()
        if report:
            cli.print_report(report)
        else:
            sys.exit(1)

    elif args.command == "events":
        events = cli.get_events()
        if events:
            cli.print_events_table(events)
        else:
            sys.exit(1)

    elif args.command == "alerts":
        alerts = cli.get_alerts()
        if alerts is not None:
            cli.print_alerts_list(alerts)
        else:
            sys.exit(1)

    elif args.command == "watch":
        cli.watch(interval=args.interval)


if __name__ == "__main__":
    main()

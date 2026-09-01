# station_survey — relevamiento de estaciones SeedLink vivas

Herramienta interna para responder: **¿hay una estación con dato vivo en esta
zona geográfica, y en qué servidor está?**

Se usó para medir la cobertura real de las 76 zonas del cuaderno del mega wall
(2026-08-31). No corre en ningún Dockerfile ni forma parte del arranque de
ningún proceso: se ejecuta a mano cuando hace falta re-medir.

## Uso

```bash
cd scripts/station_survey
python3 dump.py     # baja INFO STREAMS crudo de ambos servidores (~8 MB)
                    # + bajar a mano los dos metadatas FDSN, ver abajo
python3 final.py    # evalúa las zonas definidas en la lista Z
```

Los dos metadatas geográficos hay que bajarlos aparte:

```bash
curl -s "https://service.earthscope.org/fdsnws/station/1/query?level=station&format=text" -o stations.txt
curl -s "https://geofon.gfz.de/fdsnws/station/1/query?level=station&format=text" -o geofon_sta.txt
```

**Hacen falta los DOS.** `WM.AVE` (Marruecos) no está en el de EarthScope, así
que usando solo ese, Marruecos da cero estando viva.

## Por qué buscar por bounding box y no por código de red

Buscar por red FDSN es lo que hizo fallar a Venezuela en el relevamiento
anterior: la red `VE` tiene 0 estaciones en ambos servidores, pero
`IU.SDV` (Santo Domingo, Venezuela) está viva — pertenece a la red global `IU`.
El país no se deduce del código de red.

Contrapartida: el bounding box trae vecinos. Guatemala devuelve estaciones de
El Salvador, Somalia devuelve Yibuti, Sumatra devuelve Singapur. Por eso
`final.py` acepta un filtro por país sobre el nombre del sitio — que a su vez
produce falsos NEGATIVOS, porque la red `MX` no dice "Mexico" en sus nombres.
**Los casos límite se revisan a mano; el filtro no sustituye el criterio.**

## Trampas del parseo (las cuatro producen falsos negativos silenciosos)

Las cuatro hacen lo mismo: una estación **viva** se reporta como inexistente.
Nunca al revés — por eso no se notan si no se contrasta contra un control.

1. **Formatos de fecha distintos por servidor.** GEOFON emite
   `end_time="2026/08/31 16:58:11"` (barras y espacio), rtserve emite ISO-8601
   `end_time="2026-08-31T16:58:15.444538Z"`. Un parser escrito contra uno
   devuelve "sin canal vertical" contra el otro, que se lee igual que "muerta".
2. **Paquetes `SLINFO` binarios inyectados en medio del XML.** Caen en
   cualquier punto y parten lo que sea:
   - la palabra `<station` al medio: `<st` + binario + `ation name="AVE"`
   - **entre los atributos `name=` y `network=`**: `name="UOSS"` + binario +
     `network="II"`

   Por eso `catalog.py` NO exige el tag `<station` intacto ni que `name=` y
   `network=` sean consecutivos: los busca con un lookahead negativo que
   tolera basura en el medio mientras no aparezca otro `name=`. Arreglar
   solo la primera variante y no la segunda recuperaba `WM.AVE` pero seguía
   perdiendo `II.UOSS`. La corrección completa recuperó **51 estaciones**.
3. **Una estación puede repetir el mismo canal** con dos `end_time` distintos.
   Quedarse con la primera coincidencia da un falso "desfasada": hay que tomar
   el máximo.
4. **Estar en el catálogo no es estar viva.** `WM.TIO` figura en el `INFO
   STREAMS` de GEOFON con 3,3 días de atraso. Siempre medir el `end_time`.

## Validación (no es opcional)

`catalog.py` se contrasta contra cinco estaciones verificadas a mano
(`II.UOSS`, `GE.KBU`, `WM.AVE`, `MN.TRI` vivas; `WM.TIO` muerta con 3,3 días).
Correr `python3 catalog.py` imprime ese sanity check.

Las dos primeras versiones del parser fallaron ahí: la primera daba `WM.AVE`
por inexistente, la segunda `II.UOSS`. **La segunda falla casi se publica como
"Emiratos se cayó del catálogo"** — una conclusión falsa, con dato aparente
que la respaldaba. Sin el control de cinco estaciones no había forma de
distinguirla de una caída real.

## El catálogo rota en minutos

Medido el 2026-08-31 con veinte minutos de diferencia (17:47 y 18:07 UTC):

- `II.BORG` (Islandia) e `IN.MNC` (India) **desaparecieron por completo** del
  catálogo — cero ocurrencias literales en el dump. Eran la única estación de
  su zona.
- `IU.MAJO`, `IU.GUMO` e `IU.SNZO` **volvieron** con 2 min de atraso. Son las
  tres que se cayeron en agosto y motivaron el fix de la cuarentena.
- La red `IN` cambió de miembros: antes `MNC`, después `PBA` y `SHL`.

Cualquier relevamiento es una foto con fecha de vencimiento. Volver a medir
antes de cargar un catálogo definitivo.

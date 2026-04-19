# Avvio locale container + simulatore

Questa configurazione permette di testare `backend` e `udp-sim` in locale (PC) senza cross-compilare per Raspberry.

## Prerequisiti

- Docker Desktop installato e avviato
- `docker compose` disponibile

## Avvio rapido

```powershell
docker compose -f compose.yaml -f compose.local.yaml up --build -d
```

## URL e porte

- UI: `http://localhost:8090/ui`
- Health: `http://localhost:8090/api/health`
- UDP RX backend: `localhost:14590/udp`
- UDP TX backend (verso simulatore): `localhost:14591/udp`

## Log utili

```powershell
docker compose -f compose.yaml -f compose.local.yaml logs -f backend
docker compose -f compose.yaml -f compose.local.yaml logs -f udp-sim
```

## Stop

```powershell
docker compose -f compose.yaml -f compose.local.yaml down
```

## Override opzionali

Puoi impostare variabili ambiente prima dell'avvio, ad esempio:

```powershell
$env:HOST_HTTP_PORT="8091"
$env:MAVLINK_ENABLED="1"
docker compose -f compose.yaml -f compose.local.yaml up --build -d
```

Variabili principali supportate:

- `HOST_HTTP_PORT` (default `8090`)
- `CALYPSO_UDP_TX_HOST` (default `udp-sim`)
- `CALYPSO_UDP_TX_SLAVE_HOST` (default vuoto in locale; default RPi `192.168.2.4`)
- `MAVLINK_ENABLED` (default `0` in locale)
- `CALYPSO_LOGS_PATH` (default `./data/logs`)

## Config Raspberry/BlueOS

Per una configurazione Raspberry separata (senza simulatore locale):

```powershell
docker compose -f compose.yaml -f compose.rpi.yaml up --build -d
```

# Lights Command Spec (FW fari)

## Scopo

Definisce il comando luci inoltrato dal backend/UI al bridge firmware e poi su bus RS485.
Questa e la specifica da usare per allineare il firmware fari.

## Versioning protocollo luci

- Versione protocollo luci corrente: `ProtoVer=1`
- `ProtoVer` versiona il payload luci (`Type=LGT`), non il trasporto NMEA.
- In caso di modifica incompatibile del payload, incrementare `ProtoVer`.
- Il trasporto resta su `VER=2` (campo header NMEA).

## Trasporto e frame

- Trasporto: UDP (lato SFC/Engine) + RS485 (lato bus luci).
- Destinazioni UDP runtime:
  - master: `CALYPSO_UDP_TX_HOST` + `CALYPSO_UDP_TX_PORT`
  - slave opzionale: `CALYPSO_UDP_TX_SLAVE_HOST` + `CALYPSO_UDP_TX_PORT`
  - override lista luci: `CALYPSO_LIGHTS_UDP_TX_HOSTS` con host separati da virgola.
  - default compose RPi: `192.168.2.3:14591` e `192.168.2.4:14591`.
- Formato frame (NMEA v2):
  - `$SRC,DST,MSG,2,SEQ,TS_MS,<key,value,...>*CRC\r\n`
- `CRC`: XOR a 8 bit di tutti i caratteri tra `$` e `*`, codificato hex uppercase a 2 cifre.

## Routing bridge (Engine)

Il bridge inoltra su RS485 la linea *invariata* se:

- `SRC=SFC`
- `DST=ALL` oppure `DST` che inizia con `LGT` (es. `LGT1`, `LGT_LEFT`)
- e uno dei seguenti:
  - `MSG=LGT`
  - `MSG=CMD` con `Type=LGT`

Nota: per i comandi luci inoltrati dal backend/UI, il path usato e `MSG=CMD` + `Type=LGT`.

## Comando canonico usato da UI/backend

### Forma wire

`$SFC,<DST>,CMD,2,<SEQ>,<TS_MS>,CmdId,<CMD_ID>,Type,LGT,ProtoVer,<PROTO_VER>,Ch,<CH>,Mode,<MODE>,Dim,<DIM>,LampIds,<LAMP_IDS>*CRC`

### Campi

- `SRC`: fisso `SFC`.
- `DST`: `ALL` oppure prefisso `LGT*`.
- `MSG`: `CMD`.
- `VER`: `2`.
- `SEQ`: intero `u32` (nel backend coincide con `CmdId`).
- `TS_MS`: timestamp `u32` (ultimo `state.last_update_ms`, default `0` se non disponibile).
- `CmdId`: `u32`, obbligatorio.
- `Type`: fisso `LGT`.
- `ProtoVer`: versione payload luci, intero `u16` (corrente `1`).
- `Ch`: canale logico, ammesso `1..4`.
- `Mode`: enum `ON | OFF | TEST`.
- `Dim`: `0..1000` (se fuori range lato API viene clampato).
- `LampIds`: lista ID lampade separati da `|`, es. `5|6|7`.
  - puo essere stringa vuota (`LampIds,`) se il canale non ha lampade associate.

## Vincoli lato API backend (sorgente comandi UI)

- Endpoint: `POST /api/cmd/lights_channel`
- Input:
  - `ch`: solo `1..4`
  - `mode`: solo `ON|OFF|TEST`
  - `dim`: clamp `0..1000`
  - `dst`: `ALL` o prefisso `LGT`
- Mapping canale -> lampade:
  - letto da `/api/config/lights`
  - `lamp_ids` normalizzati a interi positivi univoci e ordinati.

## ACK e semantica risposta

- Il bridge firmware **non genera ACK** per `Type=LGT`.
- Il bridge firmware **non genera ACK** per `Type=LGT_IDS`.
- La risposta API backend per luci e:
  - `{ok:true, cmd_id:<id>, lamp_ids:[...], await_ack:false}`
- Implicazione firmware fari:
  - non e richiesto inviare `ACK` perche UI/backend non lo attende nel flusso luci standard.

## Sincronizzazione ID fari per POD

Per permettere al firmware di sapere quali ID fari sono fisicamente collegati a ciascun POD, il backend invia un comando dedicato:

`$SFC,<POD>,CMD,2,<SEQ>,<TS_MS>,CmdId,<CMD_ID>,Type,LGT_IDS,Ids,<IDS>*CRC`

### Campi

- `POD`: `BAT1` oppure `BAT2`.
- `Type`: fisso `LGT_IDS`.
- `Ids`: lista ID fari separati da `;`, es. `1;2;3`.

### Mapping default

- `BAT1`: `1;2;3`
- `BAT2`: `4;5`

### Mapping canali UI -> POD

La UI/backend applica questa regola fissa:

- `CH1` e `CH2` appartengono a `BAT1`.
- `CH3` e `CH4` appartengono a `BAT2`.

La configurazione `/api/config/lights` espone il campo `channels.<CH>.pod` coerente con questa regola. Il campo e informativo e viene normalizzato dal backend.

Il mapping viene letto e salvato in `/api/config/lights` nella sezione `pods`.
La UI invia automaticamente `Type=LGT_IDS` quando viene salvata la configurazione luci, oppure manualmente dal pulsante `Sync pod IDs`.
E disponibile anche l'endpoint dedicato `POST /api/cmd/lights_ids`.

Le destinazioni UDP sono pod-specific:

- `BAT1` -> `CALYPSO_UDP_TX_HOST:CALYPSO_UDP_TX_PORT`
- `BAT2` -> `CALYPSO_UDP_TX_SLAVE_HOST:CALYPSO_UDP_TX_PORT`

## Stato fari pubblicato dai POD

Dopo aver ricevuto `Type=LGT_IDS`, i POD eseguono polling a 1 Hz sugli ID assegnati e pubblicano lo stato di ogni faro:

`$LGT<ID>,BUS,STATUS,2,<SEQ>,<LOCAL_MS>,CmdId,<CMD_ID>,Type,LGT,Op,STATUS,Id,<ID>,Mode,<MODE>,State,<STATE>,Dim,<DIM>,Out,<OUT>,Fault,<FAULT>,Uptime,<LOCAL_MS>*CRC`

### Campi principali

- `SRC`: `LGT<ID>`, es. `LGT1`.
- `DST`: `BUS`.
- `MSG`: `STATUS`.
- `Type`: fisso `LGT`.
- `Op`: fisso `STATUS`.
- `Id`: ID faro.
- `Mode`: modo corrente riportato dal firmware fari.
- `State`: stato operativo riportato dal firmware fari.
- `Dim`: dimmer richiesto o applicato.
- `Out`: uscita effettiva.
- `Fault`: `0` o valore equivalente a OK quando non ci sono fault; valori diversi da zero indicano fault.
- `Uptime`: uptime locale del nodo/faro in ms.

### Bitmask `Fault`

`Fault=0` indica nessun fault attivo. I bit possono essere combinati.

| Bit | Valore | Nome | Condizione firmware |
| --- | ---: | --- | --- |
| 0 | `0x00000001` | `OPENLED` | Fault pin `OPENLED` attivo |
| 1 | `0x00000002` | `OVERTEMP` | `temp_hw >= TEMP_HW_SHDN_C` oppure `temp_led >= TEMP_LED_SHDN_C` |
| 2 | `0x00000004` | `OVERCURR` | `ibus > CURRENT_TRIP_A` |
| 3 | `0x00000008` | `UNDERVOLT` | `vbus < VBAT_MIN_V` |
| 4 | `0x00000010` | `INA_ALERT` | Diagnostica INA238 in fault |

La UI aggrega questi stati per POD usando il mapping `pods.BAT1/BAT2`:

- verde se tutti gli ID configurati hanno uno status recente e `Fault=0`;
- giallo se mancano status o sono stale;
- rosso se almeno un ID configurato riporta fault.

Nella tabella allarmi diagnostici, la UI espone questi fault come righe ordinate:

- `LGT_OPENLED`
- `LGT_OVERTEMP`
- `LGT_OVERCURR`
- `LGT_UNDERVOLT`
- `LGT_INA_ALERT`

Ogni riga e rossa se almeno un faro ha il bit attivo, arancio se il bit si e attivato in passato ma ora e rientrato, verde se non e mai stato rilevato.

Timeout status fari configurabile con `CALYPSO_LIGHTS_STATUS_OFFLINE_MS`, default `3000`.

## Esempi validi

```text
$SFC,ALL,CMD,2,101,123456,CmdId,101,Type,LGT,ProtoVer,1,Ch,2,Mode,ON,Dim,600,LampIds,5|6|7*75
$SFC,LGT1,CMD,2,102,123460,CmdId,102,Type,LGT,ProtoVer,1,Ch,1,Mode,OFF,Dim,0,LampIds,1|3*5E
$SFC,BAT1,CMD,2,103,123470,CmdId,103,Type,LGT_IDS,Ids,1;2;3*08
$SFC,BAT2,CMD,2,103,123470,CmdId,103,Type,LGT_IDS,Ids,4;5*01
$LGT1,BUS,STATUS,2,104,123500,CmdId,103,Type,LGT,Op,STATUS,Id,1,Mode,ON,State,ON,Dim,600,Out,1,Fault,0,Uptime,123500*27
```

Esempio alternativo comunque inoltrato dal bridge:

```text
$SFC,LGT2,LGT,2,103,123470,Ch,3,Mode,TEST,Dim,1000,LampIds,8|9*34
```

## Requisiti consigliati per FW fari

- Accettare `DST=ALL` e `DST` dedicato (`LGT*`) per addressing broadcast/unicast di gruppo.
- Parsare i key/value in modo robusto (ordine variabile, chiavi sconosciute ignorate).
- Supportare `LampIds` vuoto come "nessuna lampada target esplicita".
- Applicare `Mode` e `Dim` con priorita:
  - `OFF` forza output a zero
  - `ON` usa `Dim`
  - `TEST` comportamento definito dal FW fari (diagnostica)
- Scartare frame con CRC errato o `VER!=2`.

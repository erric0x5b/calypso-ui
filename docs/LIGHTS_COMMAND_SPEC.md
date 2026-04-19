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
- La risposta API backend per luci e:
  - `{ok:true, cmd_id:<id>, lamp_ids:[...], await_ack:false}`
- Implicazione firmware fari:
  - non e richiesto inviare `ACK` perche UI/backend non lo attende nel flusso luci standard.

## Esempi validi

```text
$SFC,ALL,CMD,2,101,123456,CmdId,101,Type,LGT,ProtoVer,1,Ch,2,Mode,ON,Dim,600,LampIds,5|6|7*75
$SFC,LGT1,CMD,2,102,123460,CmdId,102,Type,LGT,ProtoVer,1,Ch,1,Mode,OFF,Dim,0,LampIds,1|3*5E
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

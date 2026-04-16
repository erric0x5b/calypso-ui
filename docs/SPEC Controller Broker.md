# SPEC Controller Broker v0.1

Sistema Input Broker per ROV DeepEx.

## 1. Obiettivo

Realizzare un sistema di acquisizione e distribuzione dei comandi pilota composto da:

- **controller custom** basato su **ESP32-S3**
- **broker software** eseguito sul PC di superficie
- **virtual joystick** esposto al sistema operativo per utilizzo da parte di **Cockpit Desktop**
- **stream UDP JSON** verso la **UI custom**
- **protocollo custom NMEA-like** tra ESP32 e broker, identico su:
  - **USB seriale**
  - **Bluetooth**

Il broker è l'unico punto di verità dello stato del controller.

---

## 2. Architettura logica

### 2.1 Blocchi

**Controller custom**

- joystick assi
- pulsanti
- switch
- eventuali encoder / potenziometri
- MCU ESP32-S3

**Link fisici controller -> PC**

- primaria: **USB seriale**
- secondaria: **Bluetooth custom**

**Broker PC**

- parser protocollo NMEA-like
- state machine sorgenti USB/BT
- mapping logico
- watchdog / failover
- virtual joystick output
- UDP JSON output verso UI
- logging diagnostico

**Consumer 1**

- **Cockpit Desktop**
- riceve input solo tramite **virtual joystick**

**Consumer 2**

- **UI custom**
- riceve input solo tramite **UDP JSON**

---

## 3. Requisiti funzionali

### 3.1 Requisiti generali

Il sistema deve:

1. acquisire gli input dal controller custom
2. supportare due trasporti:
   - USB seriale
   - Bluetooth
3. usare lo **stesso protocollo applicativo** su entrambi i trasporti
4. selezionare **una sola sorgente attiva alla volta**
5. dare priorità a **USB**
6. passare a **Bluetooth** in caso di perdita USB
7. generare uno **stato neutro sicuro** in caso di perdita totale del link
8. fornire alla UI uno stream stateless con stato completo aggiornato
9. generare un joystick virtuale per Cockpit
10. mantenere separati:
    - valori raw
    - valori filtrati
    - valori mappati per Cockpit
    - valori mappati per UI

---

## 4. Requisiti non funzionali

### 4.1 Prestazioni

- frequenza stato controller ESP32 -> broker: **50 Hz**
- frequenza heartbeat ESP32 -> broker: **1 Hz**
- frequenza broker -> UI: **20-30 Hz** minima, **50 Hz** consigliata in modalità live
- tempo massimo senza frame validi prima di considerare link stale: **150 ms**
- tempo di stabilità prima del ritorno automatico a USB: **1000 ms**

### 4.2 Robustezza

- checksum obbligatorio su tutti i frame NMEA-like
- sequence number monotono per ogni messaggio di stato
- timestamp monotono locale ESP32
- log degli eventi di cambio sorgente
- reset a neutro in caso di timeout del link attivo

---

## 5. Ruoli dei componenti

### 5.1 ESP32-S3

Responsabilità:

- acquisizione ingressi fisici
- normalizzazione ADC base
- debounce minimo dei pulsanti
- generazione pacchetti protocollo custom
- invio su USB seriale
- invio su Bluetooth
- heartbeat periodico
- identificazione board / firmware / stato link

Non deve gestire:

- mapping missione complesso
- logica di safety di alto livello
- assegnazione finale comandi Cockpit/UI

### 5.2 Broker PC

Responsabilità:

- ricezione pacchetti da USB e BT
- validazione checksum
- validazione sequence
- gestione state machine link
- scelta sorgente attiva
- deadband, scaling, inversioni, expo
- mapping logico
- generazione virtual joystick
- generazione UDP JSON
- logging e diagnostica
- watchdog e neutral failover

---

## 6. Politica di selezione sorgente

### 6.1 Priorità

Ordine di priorità:

1. **USB**
2. **Bluetooth**

### 6.2 Regole

- Se USB è valido, USB è la sorgente attiva.
- Se USB scade e BT è valido, il broker passa a BT.
- Se USB torna disponibile, il broker torna a USB solo dopo **1 s** di validità continua.
- Durante il cambio sorgente il broker può applicare una finestra di neutralizzazione di **1-2 cicli**.

### 6.3 Stati

Valori previsti:

- `NO_LINK`
- `USB_READY`
- `BT_READY`
- `USB_ACTIVE`
- `BT_ACTIVE`
- `DEGRADED`

---

## 7. Protocollo ESP32 -> Broker

### 7.1 Trasporto

Supportati:

- USB seriale
- Bluetooth byte-stream equivalente

Il framing applicativo è identico su entrambi.

### 7.2 Formato generale

Formato NMEA-like:

```text
$<TYPE>,<field1>,<value1>,<field2>,<value2>,...,*<CS>\r\n
```

Dove:

- `$` = start
- `*CS` = checksum XOR su tutto il payload tra `$` e `*`
- terminazione = `\r\n`

### 7.3 Charset

- ASCII 7-bit
- separatore campi: `,`
- numeri interi in base 10
- booleani: `0` / `1`

---

## 8. Tipi di messaggio

### 8.1 Messaggio Stato Controller: `JOY`

Messaggio periodico principale.

**Frequenza:** 50 Hz

**Esempio:**

```text
$JOY,SEQ,1250,TS,18345231,SRC,USB,MODE,0,LX,124,LY,-22,RX,0,RY,415,LT,0,RT,0,B1,0,B2,1,B3,0,B4,0,B5,0,B6,0,SW1,1,SW2,0,QL,100*5A
```

**Campi obbligatori:**

- `SEQ`: sequence number `uint32`
- `TS`: timestamp locale ms `uint32`
- `SRC`: `USB` oppure `BT`
- `MODE`: selettore modalità fisico/logico
- `LX`, `LY`, `RX`, `RY`: assi principali signed int
- `LT`, `RT`: trigger o assi addizionali signed int
- `B1..Bn`: pulsanti digitali
- `SW1..Sn`: switch digitali o multi-posizione codificati
- `QL`: qualità link `0..100`

**Range consigliato assi raw:**

- signed int da `-1000` a `+1000`
- centro = `0`

### 8.2 Messaggio Heartbeat/Status: `JHB`

Messaggio diagnostico lento.

**Frequenza:** 1 Hz

**Esempio:**

```text
$JHB,SEQ,210,TS,18345231,FW,1.0.3,BOARD,CTRL01,USB,1,BT,1,ACTIVE,USB,VIN,4980,TEMP,34*41
```

**Campi obbligatori:**

- `SEQ`
- `TS`
- `FW`
- `BOARD`
- `USB`: disponibilità link USB `0/1`
- `BT`: disponibilità link BT `0/1`
- `ACTIVE`: sorgente attiva lato ESP32
- `VIN`: tensione locale mV

**Campi opzionali:**

- `TEMP`
- `ERR`
- `UPTIME`

### 8.3 Messaggio Evento: `JEV`

Messaggio asincrono.

**Esempi:**

```text
$JEV,SEQ,44,TS,18345231,TYPE,LINK_SWITCH,FROM,USB,TO,BT*3C
$JEV,SEQ,45,TS,18345290,TYPE,ADC_FAULT,CH,LX*6E
```

**Tipi iniziali previsti:**

- `LINK_SWITCH`
- `ADC_FAULT`
- `BUTTON_STUCK`
- `CONFIG_CHANGED`
- `BOOT`
- `WARN`

---

## 9. Regole di validazione lato broker

Un frame ricevuto è valido solo se:

- sintassi corretta
- checksum corretto
- campi obbligatori presenti
- `SEQ` non duplicato rispetto all'ultimo frame della stessa sorgente
- `TS` coerente e non regressivo oltre soglia configurabile

In caso di frame invalido:

- scartare il frame
- incrementare contatore errori sorgente
- non aggiornare lo stato attivo

---

## 10. Modellazione interna broker

Il broker deve mantenere almeno questi layer.

### 10.1 Stato Raw

Copia diretta del frame:

```text
raw.axes
raw.buttons
raw.switches
raw.seq
raw.ts_ms
raw.src
```

### 10.2 Stato Filtrato

Output dopo:

- deadband
- clamp
- smoothing leggero opzionale
- inversioni
- calibrazione centro/fondo scala

### 10.3 Stato Logico

Naming indipendente dall'hardware:

```text
pilot.surge
pilot.sway
pilot.heave
pilot.yaw
pilot.roll
ui.lights_up
ui.lights_down
ui.camera_rec
ui.payload_1
ui.payload_2
system.mode_select
```

### 10.4 Stato Output

Separato per consumer:

```text
output.cockpit.*
output.ui.*
```

---

## 11. Mapping

### 11.1 Principio

Il mapping viene fatto nel broker, non nell'ESP32.

### 11.2 Struttura di configurazione

File JSON o YAML con:

- nome profilo
- definizione assi
- deadband
- expo
- inversione
- assegnazione pulsanti
- eventi short/long press
- assegnazione per Cockpit
- assegnazione per UI

**Esempio concettuale:**

```yaml
profile: pilot_default
axes:
  LX:
    logical: pilot.yaw
    scale: 1.0
    deadband: 0.05
    invert: false
  LY:
    logical: pilot.surge
    scale: 1.0
    deadband: 0.05
    invert: true
  RX:
    logical: pilot.sway
    scale: 1.0
    deadband: 0.05
    invert: false
  RY:
    logical: pilot.heave
    scale: 1.0
    deadband: 0.05
    invert: true

buttons:
  B1:
    logical: ui.lights_up
    type: momentary
  B2:
    logical: ui.lights_down
    type: momentary
  B3:
    logical: ui.camera_rec
    type: short_press_toggle
  B4:
    logical: system.mode_cycle
    type: short_press
```

---

## 12. Sicurezze

### 12.1 Timeout Link

Se non arriva un frame `JOY` valido dal link attivo entro **150 ms**:

- assi pilotaggio a zero
- pulsanti momentanei rilasciati
- flag `link_stale = true`
- log evento fault

### 12.2 Failover

Se il link attivo cade:

- se l'altro link è valido, commutare
- opzionale: neutralizzazione per **1-2 cicli**
- loggare `LINK_SWITCH`

### 12.3 Ritorno a USB

Se USB torna disponibile:

- attenderne stabilità per **1000 ms**
- poi promuoverlo a sorgente attiva

### 12.4 Service Mode

Modalità test:

- il broker riceve e valida il controller
- invia UDP alla UI
- non aggiorna il virtual joystick

### 12.5 Safe Startup

All'avvio:

- output joystick virtuale inizialmente neutro
- nessun comando emesso finché non si ricevono almeno **3 frame JOY validi consecutivi** dalla sorgente attiva

---

## 13. Output Broker -> UI

### 13.1 Trasporto

- UDP unicast su porta configurabile
- payload JSON UTF-8
- messaggio completo stateless

### 13.2 Frequenza

- default: **25 Hz**
- configurabile fino a **50 Hz**

### 13.3 Schema JSON

**Esempio:**

```json
{
  "seq": 1250,
  "ts_ms": 18345231,
  "controller_online": true,
  "active_link": "usb",
  "usb_available": true,
  "bt_available": true,
  "source_quality": 100,
  "profile": "pilot_default",
  "mode": "pilot",
  "raw": {
    "lx": 124,
    "ly": -22,
    "rx": 0,
    "ry": 415,
    "lt": 0,
    "rt": 0
  },
  "buttons": {
    "b1": false,
    "b2": true,
    "b3": false,
    "b4": false,
    "b5": false,
    "b6": false
  },
  "switches": {
    "sw1": 1,
    "sw2": 0
  },
  "mapped": {
    "surge": 0.12,
    "sway": -0.03,
    "heave": 0.41,
    "yaw": 0.0,
    "lights_up": false,
    "lights_down": true,
    "camera_rec": false
  },
  "events": [
    {
      "type": "button_down",
      "id": "b2"
    }
  ],
  "health": {
    "link_stale": false,
    "vjoy_ok": true,
    "safe_output": false
  }
}
```

### 13.4 Campi minimi obbligatori

- `seq`
- `ts_ms`
- `controller_online`
- `active_link`
- `raw`
- `mapped`
- `health`

---

## 14. Output Broker -> Cockpit

### 14.1 Modalità

Il broker deve esporre un virtual joystick standard al sistema operativo, così che Cockpit possa usarlo come normale joystick configurabile.

### 14.2 Canali minimi verso Cockpit

Consigliati:

- asse 1: `surge`
- asse 2: `yaw`
- asse 3: `heave`
- asse 4: `sway`

Pulsanti solo se realmente necessari a Cockpit:

- arm/disarm se previsto nel workflow
- mode change se già consolidato
- eventuali azioni standard

Tutte le funzioni payload/UI custom restano fuori dal virtual joystick, salvo necessità specifiche.

---

## 15. Logging

Il broker deve registrare:

### 15.1 Log eventi

- boot
- link up/down
- switch USB/BT
- timeout
- checksum error
- frame malformed
- service mode on/off
- profile change

### 15.2 Log stato opzionale

Snapshot periodici ridotti dello stato:

- `seq`
- `active_link`
- key axes
- stale flags

---

## 16. Configurabilità

Parametri configurabili:

- porta seriale USB
- identificatore BT
- UDP host/port UI
- frequenza output UI
- timeout stale
- hysteresis ritorno USB
- profilo attivo
- deadband
- smoothing
- mapping assi/pulsanti
- modalità service

---

## 17. Convenzioni di naming

### 17.1 Assi Raw

- `LX`
- `LY`
- `RX`
- `RY`
- `LT`
- `RT`

### 17.2 Pulsanti Raw

- `B1...B16`

### 17.3 Switch Raw

- `SW1...SW8`

### 17.4 Logical Controls

Prefissi:

- `pilot.*`
- `ui.*`
- `system.*`

---

## 18. Versioning Protocollo

Ogni firmware/controller deve esporre:

- `PROTO_VER`
- `FW`
- `BOARD`

Consigliato aggiungere a `JHB`:

```text
PROTO,1
```

**Esempio:**

```text
$JHB,SEQ,210,TS,18345231,PROTO,1,FW,1.0.3,BOARD,CTRL01,USB,1,BT,1,ACTIVE,USB,VIN,4980*12
```

---

## 19. Test di accettazione minimi

### 19.1 Test Link USB

- collegamento USB
- ricezione corretta `JOY`
- output virtual joystick aggiornato
- JSON UDP coerente

### 19.2 Test Link BT

- assenza USB
- collegamento BT
- ricezione corretta `JOY`
- passaggio a `BT_ACTIVE`

### 19.3 Test Failover USB -> BT

- USB attivo
- rimozione USB
- passaggio a BT entro timeout
- output neutro durante transizione
- ripresa comandi

### 19.4 Test Ritorno BT -> USB

- BT attivo
- ritorno USB
- attesa **1 s**
- promozione USB
- log evento

### 19.5 Test Stale

- interruzione totale frame
- output joystick neutro
- flag `link_stale = true`

### 19.6 Test Checksum

- invio frame corrotto
- frame scartato
- nessun aggiornamento stato
- incremento contatore errori

---

## 20. Roadmap v0.2 suggerita

Per la versione successiva:

- ack/config channel broker -> ESP32
- calibrazione remota
- profili multipli salvati
- crittografia/autenticazione link BT
- compressione o frame binario opzionale
- feedback LED/haptic verso controller
- telemetria di latenza end-to-end

---

## 21. Decisioni aperte da congelare prima dello sviluppo

Da fissare prima di dare tutto a Codex:

- numero esatto di assi
- numero esatto di pulsanti
- numero di switch multi-posizione
- range raw definitivo assi:
  - `-1000..1000`
  - oppure `-32767..32767`
- tipo di Bluetooth:
  - stream seriale-like
  - BLE custom
- piattaforma target del broker:
  - Windows
  - Linux
  - entrambe
- tecnologia virtual joystick:
  - specifica per OS target

---

## 22. Note implementative consigliate per Codex

### 22.1 Struttura moduli broker

Moduli suggeriti:

- `transport_usb`
- `transport_bt`
- `protocol_parser`
- `source_manager`
- `input_filters`
- `mapping_engine`
- `virtual_joystick`
- `udp_publisher`
- `health_monitor`
- `logger`

### 22.2 Struttura dati interna suggerita

Oggetti principali:

- `RawInputState`
- `FilteredInputState`
- `LogicalInputState`
- `OutputState`
- `SourceStatus`
- `BrokerHealth`

### 22.3 Loop principale broker

Ordine suggerito:

1. ricezione frame
2. validazione frame
3. aggiornamento stato sorgente
4. scelta sorgente attiva
5. applicazione filtri
6. mapping logico
7. verifica safety / timeout
8. aggiornamento virtual joystick
9. pubblicazione UDP JSON
10. logging diagnostico

### 22.4 Principio di progettazione

- nessuna logica flight-critical nel browser
- una sola ownership del controller nel broker
- output verso Cockpit e UI sempre derivati dallo stesso stato logico

---

## 23. Esempio di configurazione runtime broker

```yaml
broker:
  ui_udp_host: 127.0.0.1
  ui_udp_port: 5010
  ui_rate_hz: 25
  stale_timeout_ms: 150
  usb_return_hysteresis_ms: 1000
  safe_start_frames: 3
  neutral_cycles_on_failover: 2
  service_mode: false

transport:
  usb:
    enabled: true
    device: auto
    baudrate: 115200
  bt:
    enabled: true
    device_name: DeepEx_Controller

profile:
  active: pilot_default
```

---

## 24. Esempio di log eventi broker

```text
[INFO] broker_start version=0.1.0
[INFO] source_detected source=USB
[INFO] source_active source=USB
[WARN] usb_timeout timeout_ms=162
[INFO] link_switch from=USB to=BT
[INFO] usb_restored stable_ms=1000
[INFO] link_switch from=BT to=USB
[WARN] input_stale source=USB
[INFO] service_mode enabled=false
```

---

## 25. Criterio di completamento v0.1

La versione v0.1 si considera completata quando:

- il controller ESP32 invia frame `JOY` e `JHB` validi su USB
- il broker riceve e valida i frame
- il broker gestisce USB come sorgente primaria
- il broker gestisce BT come fallback
- il broker espone un virtual joystick utilizzabile da Cockpit
- il broker pubblica JSON UDP coerente verso la UI
- il broker porta gli output a neutro in caso di timeout
- i test di accettazione minimi del capitolo 19 risultano superati

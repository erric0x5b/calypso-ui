# Specifica tecnica – Estensione BlueOS (DeepX ROV)

Documento guida sviluppo e integrazione – **v0.4**

## 1. Obiettivo

Realizzare una **BlueOS Extension** (container Docker) che fornisca una **Web UI** dedicata ai controlli/telemetria custom del ROV, includendo:

- Telemetria e comandi verso scheda custom (UDP NMEA-like)
- **Bridge MAVLink opzionale** (pubblicazione subset dati verso ecosistema BlueOS/Cockpit)
- Gestione **allarmi** (realtime + storico) e **logging** esportabile
- Selezione/visualizzazione **video** (camere) e **sonar** (Ping/Bing 360 tramite API/estensione)
- **Eventing missione** opzionale (marker con commento) e log dedicato

---

## 2. Architettura di alto livello

- **BlueOS**: installazione come Extension (Docker) con backend + frontend.
- **Backend**:
  - UDP RX/TX (parse/encode protocollo)
  - State manager (stato batterie/luci/ESC/allarmi/video)
  - Alarm manager (gravità, persistenza, storico, notifiche)
  - Logger (telemetria + allarmi + eventi) ed export
  - MAVLink bridge (opzionale, subset dati)
  - Input layer joystick (mapping azioni)
- **Frontend (Web UI)**:
  - Touchscreen friendly
  - Controllabile anche da joystick
  - Aggiornamenti realtime (WebSocket consigliato)

**Uso a doppio monitor**:

- Monitor 1: Cockpit/BlueOS
- Monitor 2: Web UI Extension

---

## 3. Comunicazione con scheda custom – UDP NMEA-like (v2)

### 3.1 Frame format (standardizzato)

Stringhe CSV in stile NMEA con checksum e CRLF.

**Formato base:** `$<SRC>,<DST>,<MSG>,<VER>,<SEQ>,<TS_MS>,<PAYLOAD...>*<CKS>\r\n`

- `SRC`: sorgente (es. `SFC`, `BAT1`, `BAT2`, `BUS`, `ESC1..6`)
- `DST`: destinazione (`SFC`, `BATx`, `ALL`, ecc.)
- `MSG`: tipo messaggio (es. `ENV`, `PWR`, `LGT`, `ESC`, `ALM`, `CMD`, `ACK`, `HB`, `CAPS`)
- `VER`: versione protocollo (es. `2`)
- `SEQ`: **uint32** incrementale (per stream: consigliato per `SRC+MSG`)
- `TS_MS`: **uint32** millisecondi da boot (generato dalla sorgente che invia)
- `PAYLOAD`: campi dati
- `CKS`: checksum stile NMEA (XOR tra i char dopo `$` e prima di `*`), output HEX **2 cifre**

### 3.2 Payload – formato consigliato (scalabile)

Payload come coppie **key,value** ripetute: `key1,val1,key2,val2,...`

Vantaggi:

- aggiunta campi senza rompere parser
- più leggibile/debug

### 3.3 Robustezza

- Verifica checksum obbligatoria; scarto frame invalidi
- Timeouts link: se telemetria assente oltre soglia → stato `DEGRADED/OFFLINE`
- ACK con correlazione via `CmdId` per comandi (vedi §3.4)
- Modello operativo **ibrido**:
  - **Telemetria**: streaming ROV→SFC (push) a rate definiti
  - **Comandi**: SFC→ROV (master) con ACK per azioni discrete

### 3.4 Catalogo messaggi minimi (bozza v2)

> Nota: tutti i valori sono preferibilmente **int scalati** (mV, mA, dC, ecc.) per evitare float.

- `HB` (ROV nodes → SFC) – **1 Hz**
  - Scopo: presenza nodo e contatori diagnostica
  - Keys tipiche: `Up` (0/1), `NodeState` (u8), `RxErr` (u32), `TxErr` (u32)

- `ENV` (BATx → SFC) – **10 Hz**
  - Scopo: misure elettriche/ambientali pod
  - Keys minime: `Vbatt_mv`, `Ibatt_ma`, `Temp_dC`, `LeakIn` (0/1)
  - Keys utili: `Vmot_mv`, `V48_mv`, `VbusOn` (0/1), `BusConn` (0/1)

- `PWR` (BATx → SFC) – **5 Hz** (configurabile)
  - Scopo: stato logica sicurezza/parallelo + enable rail
  - Keys bozza:
    - `BusConn` (0/1) *(MOSFET Power_Switch verso bus)*
    - `SwVbusCmd` (0/1) *(comando logico richiesto dal micro)*
    - `VbusOn` (0/1)
    - `Vbus_mv` (mV) *(se misurabile)*
    - `VcpuOn` (0/1) *(opzionale)*
    - `VeletOn` (0/1) *(opzionale)*
    - `ParState` (u8 enum)
    - `dV_thr_mv` (mV)
    - `dV_mv` (mV)
    - `Reason` (u16/u32) *(codice motivo blocco)*
    - **VMOT enable (solo SCADA):**
      - BAT1: `Vmot1On`, `Vmot2On`, `Vmot3On` (0/1)
      - BAT2: `Vmot4On`, `Vmot5On`, `Vmot6On` (0/1)

- `ESC` (BATx → SFC) – **10 Hz** (o 50 Hz se serve controllo fine)
  - Scopo: telemetria 6 ESC
  - Keys minime: `VescId` (1..6), `RPM`, `InVoltage_mv`, `AvgInCur_ma`, `Wh_x10`

- `ALM` (Any → SFC) – event-driven + repeat (rate ridotto)
  - Keys minime: `Id`, `Sev` (0..3), `Active` (0/1), `Latched` (0/1), `Text` (string) / `TextB64`

- `CMD` (SFC → ROV) – event-driven
  - Include: `CmdId` (u32), `Type` (string), payload K/V
  - Comando sicurezza VMOT (SCADA):
    - `Type=VMOT_MASTER`
    - payload: `Enable` (0/1)
    - Regola UI: enable con hold 3 secondi, disable immediato

- `ACK` (ROV → SFC) – response a `CMD`
  - Include: `CmdId` (u32), `Ok` (0/1), (opz.) `Err` (u16/u32), `Text`

---

## 4. Web UI – sezioni e requisiti

### 4.1 Requisiti generali UI

- UI responsive, leggibile a distanza
- Aggiornamento realtime (WebSocket)
- Controlli duplicati: **touchscreen + joystick**

### 4.2 Sezione Batterie / Alimentazione

ROV con **due pod**: `Pod 1 (BAT1)` e `Pod 2 (BAT2)`.

Per ciascun pod:

- `Vbatt` (V)
- `SOC` (%)
- `Ibatt` (A) in tempo reale
- Stato **parallelo** (0/1)
- Stato **connessione al bus comune** (`BusConn`: **ON/OFF** – indica i MOSFET/Power_Switch attivi)
- (opzionale) Stato **bus alimentato** (`VbusOn`: 0/1)

### 4.3 Sezione Luci

Controlli:

- Slider intensità (dimmer): `0 = OFF`, `>0 = ON`
- Selettore modalità (preset)
- Nota allineamento UI (2026-03-02): controllo ON/OFF dedicato rimosso, comportamento implicito via slider

Requisito: pieno controllo via **touch** e via **joystick** (mapping assi/pulsanti).

### 4.4 Sezione Motori / ESC (6)

Per ciascuno dei 6 ESC:

- RPM
- Comando in ingresso (setpoint)
- Potenza
- Tensione
- Corrente
- Allarmi/fault

### 4.5 Sezione Allarmi

Requisiti:

- Vista **realtime** (pop-up o area dedicata) per nuovi allarmi
- Vista **dettaglio** consultabile con:
  - storico con timestamp
  - gravità con codice colore
  - persistenza (latched / transient)
- Export log allarmi a fine missione

Gravità proposta:

- INFO, WARNING, ERROR, CRITICAL

### 4.6 Sezione Video e Sonar

- Selezione sorgente (camere e sonar) via touch e joystick
- Visualizzazione selezionabile; supporto a doppio stream se pipeline disponibile
- Integrazione sonar tramite API e/o estensione BlueOS esistente

### 4.7 Sezione Eventi missione (opzionale)

- Pulsante/shortcut joystick per inserire un **marker evento**
- Commento inseribile da tastiera
- Evento salvato con contesto (vedi §5.3)

---

## 5. Logging ed esportazione

### 5.1 Strategia log (3 file)

Per sessione/missione creare tre file separati:

1. **Telemetry log** (time-series ad alto rate)
2. **Alarms log** (allarmi con stato e timestamp)
3. **Events log** (marker/commenti operatore)

Path di default su BlueOS:

- `/data/deepex_logs/`

### 5.2 Formati consigliati

- Telemetry: **CSV** (facile analisi in Excel)
- Alarms: CSV o JSONL
- Events: **JSONL** (una riga JSON per evento)

Naming suggerito:

- `telemetry_<session>.csv`
- `alarms_<session>.csv` (o `.jsonl`)
- `events_<session>.jsonl`

### 5.3 Contenuto Events – best practice (arricchito)

Ogni riga evento include:

- `ts_ms` (uint32, da boot)
- `mission_time` (da MAVLink, se disponibile)
- `depth` (da MAVLink)
- `heading` (da MAVLink)
- `src` (es. `SFC`)
- `type` (NOTE / MARK / ALARM / ecc.)
- `text` (commento)

Esempio JSONL:

```json
{"ts_ms":553140,"mission_time":812.4,"depth":23.7,"heading":184.2,"type":"MARK","src":"SFC","text":"Ritrovamento target"}
```

### 5.4 Export

- Export a fine missione da UI (download)
- Opzione Start/Stop logging
- **Auto-start di sicurezza** (se l’operatore dimentica): avvio logging quando `depth < 0.5 m` (configurabile)
- Rotazione log (se missioni molto lunghe)

---

## 6. Open points da chiudere

- [TODO-INPUT-UDP-SCHEMA] Tabella completa messaggi UDP (keys, unità, scaling, rate) da integrare dal file v1 definitivo.
- [TODO-INPUT-NET] Porte UDP definitive e topologia rete da congelare.
- [TODO-INPUT-AV-ENDPOINTS] Lista sorgenti video/sonar + endpoint (WebRTC/RTSP/HLS).
- [TODO-INPUT-MAVLINK-BRIDGE-DATASET] Set dati da pubblicare nel MAVLink bridge.
- [TODO-INPUT-CMD-VMOT-TYPE] Confermare naming definitivo firmware per comando VMOT master (`Type=VMOT_MASTER`, `Enable=0/1` usato in UI attuale).

### 6.1 TODO implementativi (tracciamento rapido)

- [TODO-IMPL-MAVLINK-BRIDGE] Implementare pubblicazione subset dati verso ecosistema BlueOS/Cockpit una volta definito dataset.
- [TODO-IMPL-VIDEO-SOURCES] Collegare selettore video/sonar a sorgenti reali da configurazione centralizzata.
- [TODO-IMPL-VIDEO-DUAL] Valutare e implementare doppio stream video se pipeline disponibile.
- [TODO-IMPL-LOG-ROTATION] Implementare rotazione log per missioni molto lunghe.
- [TODO-IMPL-TEST-PLAN] Formalizzare piano test del §7 in checklist eseguibile.

---

## 7. Piano test (minimo)

- Parser checksum + gestione frame corrotti
- End-to-end comandi luci con ACK
- Carico: 50 Hz + 6 ESC + logging
- Switch video/sonar e riconnessione
- Joystick: mapping e coerenza con UI touch

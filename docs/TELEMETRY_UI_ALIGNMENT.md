# Telemetry v2 - UI Alignment Reference

This document summarizes telemetry currently emitted by firmware (`Engine`) for UI alignment.

## Scope

- Transport/frame: NMEA v2 over UDP.
- Primary destination for UI: `DST=SFC`.
- Sources: `SRC=BAT1` (master pod) or `SRC=BAT2` (slave pod).
- Frame format:
  - `$SRC,DST,MSG,2,SEQ,TS_MS,<key,value,...>*CRC\r\n`
- `SEQ` is independent per message family (`HB`, `ENV`, `PWR`, `ALM`, `ESC`, `CAPS`, `ACK`).

## Scheduler and nominal rates

- `HB`: 1 Hz (`Task1s`).
- `ENV`: 10 Hz (`Task100ms`).
- `PWR`: 5 Hz (`Task100ms`, every other cycle).
- `ESC`: up to 10 Hz per local VESC id (3 ids per pod).
- `ALM`: event-driven, plus repeats every `ALM_REPEAT_MS` (default 5000 ms), min global gap `ALM_MIN_GAP_MS` (default 100 ms).
- `CAPS`: one-shot at startup.
- `ACK`: on command reception (`CMD`).
- Light status poll: 1 Hz on each pod RS485 bus when no recent SFC light command is being bridged and connected light IDs have been configured.

Peer-to-peer traffic is intentionally reduced compared with SFC telemetry:

- `ENV` peer copy: 2 Hz (`PEER_ENV_PERIOD_MS=500 ms`).
- `PWR` peer copy: 5 Hz (`PEER_PWR_PERIOD_MS=200 ms`, reduced payload with `BusConn` only).
- `HB` is sent to SFC only; peer liveness is maintained by valid peer `ENV`/`PWR` and any other valid peer frame.

## Node liveness and offline rule

Use one liveness rule for `BAT1` and `BAT2`:

- Any valid NMEA v2 UDP frame from a node (`SRC=BAT1` or `SRC=BAT2`, valid CRC, `ver=2`) refreshes that node liveness timestamp.
- `HB` is the nominal heartbeat at 1 Hz, but it is not the only liveness source. `ENV`, `PWR`, `ESC`, `ALM`, `CAPS`, and `ACK` also prove that the node is online when received as valid frames.
- A node is offline when no valid frame from that node has been received for `3000 ms`.
- Do not mark a node offline because of a single missed `HB` while other valid frames from the same `SRC` are still arriving.
- Firmware uses the same `3000 ms` peer-liveness threshold for `PeerLost`; `PeerLost` is raised when the opposite pod has not produced any valid peer frame within that window.

## Messages to SFC

## `HB` (heartbeat)

Payload keys:

| Key | Type | Unit | Notes |
|---|---|---|---|
| `Up` | u8 | - | Always `1` in current implementation. |
| `NodeState` | u8 | enum | 1=`NODE_OK`, 2=`NODE_DEGRADED`, 3=`NODE_FAULT`. |
| `RxErr` | u32 | count | v2 parse/checksum errors observed by node. |
| `TxErr` | u32 | count | TX error counter. |

## `CAPS` (capabilities)

Payload keys:

| Key | Type | Unit | Notes |
|---|---|---|---|
| `Fw` | string | - | Firmware version (`FW_VER`). |
| `Hw` | string | - | Hardware label (`HW_VER`). |
| `Role` | string | enum | `MASTER` or `SLAVE`. |
| `Pod` | string | enum | `BAT1` or `BAT2`. |
| `EscRange` | string | enum | `1-3` for BAT1, `4-6` for BAT2. |
| `Feat_PWR_SM` | u8 | bool | Currently `1`. |
| `Feat_ALM` | u8 | bool | Currently `1`. |
| `Feat_LGT_BRIDGE` | u8 | bool | Currently `1`. |
| `Feat_LGT_STATUS_POLL` | u8 | bool | Currently `1`; firmware can poll configured light IDs autonomously when the SFC is idle. |
| `Feat_ESC_CAN` | u8 | bool | Currently `1`. |
| `Feat_INA_FAULT` | u8 | bool | Currently `1`; firmware reports summarized INA238 Power Switch fault status. |

## `ENV` (environment)

Payload keys:

| Key | Type | Unit | Notes |
|---|---|---|---|
| `Vbatt_mv` | i32 | mV | Battery voltage from INA238 battery node. |
| `Ibatt_ma` | i32 | mA | Battery current from INA238 battery node. |
| `Temp_dC` | i32 | deci-degC | `25.3 C` -> `253`. |
| `LeakIn` | u8 | bool | Leakage input status (1/0). |
| `V48_mv` | i32 | mV | Common rail (`v_bus`) from INA238 bus node. |
| `VbusOn` | u8 | bool | Local VBUS switch status (1/0). |
| `BusConn` | u8 | bool | Currently mirrored from `VbusOn` in `ENV`. |

## `PWR` (power state + VMOT)

Payload keys:

| Key | Type | Unit | Notes |
|---|---|---|---|
| `BusConn` | u8 | bool | PowerSM logical bus connection. |
| `SwVbusCmd` | u8 | bool | Command applied to local VBUS switch. |
| `VbusOn` | u8 | bool | Derived from `Vbus_mv > 2000`. |
| `Vbus_mv` | i32 | mV | Measured bus voltage. |
| `ParState` | u8 | enum | See `ParState` map below. |
| `dV_thr_mv` | i32 | mV | Telemetry threshold field currently based on compile-time hysteresis constant. |
| `dV_mv` | i32 | mV | `BAT1 - BAT2` battery delta. |
| `Reason` | u32 | enum | PowerSM reason code (state decision). |
| `VmotReason` | u32 | enum | VMOT sequence/fault reason code. |
| `InaFault` | u8 | bool | Summary fault flag from the Power Switch INA238 diagnostic register. |
| `VmotSwitchShort` | u8 | bool | A VMOT RDY input is active while the corresponding INP command is OFF. |
| `Vmot1On..Vmot3On` | u8 | bool | Present when `SRC=BAT1`. |
| `Vmot4On..Vmot6On` | u8 | bool | Present when `SRC=BAT2`. |

### `ParState` map

| Value | Name |
|---|---|
| 0 | `OFF` |
| 1 | `BOOT` |
| 2 | `WAIT_PEER` |
| 3 | `ISOLATED_SELF` |
| 4 | `ISOLATED_PEER` |
| 5 | `PARALLEL_ON` |
| 6 | `FAULT` |
| 7 | `HANDOFF` |

### `Reason` map (currently emitted)

| Value | Meaning |
|---|---|
| 0 | Normal / parallel allowed |
| 5 | Manual override |
| 10 | Bootstrap wait peer |
| 20 | BAT1 self primary, dV high |
| 21 | BAT2 self primary, dV high |
| 22 | CPU1 primary, CPU2 isolated |
| 30 | Handoff wait peer bus |
| 31 | Peer primary active |
| 40 | VBUS low fallback |
| 50 | Hold minimum ON dwell |
| 51 | Hold minimum OFF dwell |
| 900 | Fault active (PowerSM forced OFF) |

### `VmotReason` map

| Value | Meaning |
|---|---|
| 0 | `VMOT_REASON_OK` |
| 1 | `VMOT_REASON_IO_NOT_READY` |
| 2 | `VMOT_REASON_DRIVER_FAULT_PRECHECK` |
| 101 | `VMOT_REASON_CH1_RDY_FAIL` |
| 102 | `VMOT_REASON_CH2_RDY_FAIL` |
| 103 | `VMOT_REASON_CH3_RDY_FAIL` |
| 201 | `VMOT_REASON_CH1_RDY_UNCOMMANDED` |
| 202 | `VMOT_REASON_CH2_RDY_UNCOMMANDED` |
| 203 | `VMOT_REASON_CH3_RDY_UNCOMMANDED` |

### `InaFault` details

`PWR.InaFault` is the only INA238 Power Switch diagnostic field sent to SFC telemetry. The detailed code is intentionally kept local to the web/debug UI:

| Debug key | Type | Notes |
|---|---|---|
| `diagnostics.ina_fault` | bool | Same logical state as `PWR.InaFault`. |
| `diagnostics.ina_diag_raw` | u16 | Raw `DIAG_ALRT` register (`0x0B`) read from the Power Switch INA238 at `0x40`. |
| `diagnostics.ina_diag_raw_hex` | string | Same value formatted as hex for the web UI. |
| `diagnostics.ina_fault_code` | u16 | Fault-only code derived from `DIAG_ALRT`: bits `9,7,6,5,4,3,2` are copied, and bit `0` is set when `MEMSTAT=0`. `CNVRF` and alert configuration bits are ignored. |
| `diagnostics.ina_fault_code_hex` | string | Same value formatted as hex for the web UI. |

`ina_fault_code` bit map:

| Bit | Name | Meaning |
|---:|---|---|
| 9 | `MATHOF` | Arithmetic overflow; current/power data may be invalid. |
| 7 | `TMPOL` | Temperature over-limit. |
| 6 | `SHNTOL` | Shunt over-limit. |
| 5 | `SHNTUL` | Shunt under-limit. |
| 4 | `BUSOL` | Bus over-limit. |
| 3 | `BUSUL` | Bus under-limit. |
| 2 | `POL` | Power over-limit. |
| 0 | `MEMSTAT_ERR` | Device trim memory checksum error (`DIAG_ALRT.MEMSTAT=0`). |

## `ESC` (VESC telemetry)

One frame per local VESC id when fresh data is available.

Payload keys:

| Key | Type | Unit | Notes |
|---|---|---|---|
| `VescId` | u8 | id | BAT1 publishes ids 1..3, BAT2 publishes ids 4..6. |
| `RPM` | i32 | rpm | Motor electrical RPM from VESC status. |
| `InVoltage_mv` | i32 | mV | Input voltage. |
| `AvgInCur_ma` | i32 | mA | Averaged input current. |
| `Wh_x10` | i32 | 0.1 Wh | Energy in tenth Wh units. |

## `ALM` (alarm event stream)

Payload keys:

| Key | Type | Unit | Notes |
|---|---|---|---|
| `Id` | u16 | enum | Stable alarm ID for UI mapping. |
| `Sev` | u8 | enum | 1=`INFO`, 2=`WARN`, 3=`ERROR`, 4=`CRIT`. |
| `Active` | u8 | bool | Current condition active (1/0). |
| `Latched` | u8 | bool | Sticky latch status (1/0). |
| `Text` | string | - | Short source text (CSV-safe sanitized). |

For `ALM_PEER_LOST` (`Id=110`), `Active=0,Latched=0` means `PeerLost` has cleared. The UI must treat repeated clear frames as the same returned condition, not as a new active warning.

Stable alarm IDs:

| Id | Name |
|---|---|
| 100 | `ALM_I2C_ERROR` |
| 110 | `ALM_PEER_LOST` |
| 120 | `ALM_CAN_BUS` |
| 200 | `ALM_LEAK` |
| 210 | `ALM_OVERTEMP` |
| 300 | `ALM_VBUS_LOW` |
| 310 | `ALM_DV_HIGH` |
| 320 | `ALM_PWR_FAULT` |
| 330 | `ALM_VMOT_SWITCH_SHORT` |
| 400 + `vesc_id` | `ALM_VESC_LOST_BASE + vesc_id` |

## `ACK` (command response, useful for UI command workflows)

Generated in response to `CMD`.

Success payload:

- `CmdId,<id>,Ok,1`

Error payload:

- `CmdId,<id>,Ok,0,Err,<code>,Text,<msg>`

Current command error codes:

| Code | Name |
|---|---|
| 1 | `CMD_ERR_MISSING_KEY` |
| 2 | `CMD_ERR_BAD_VALUE` |
| 3 | `CMD_ERR_UNSUPPORTED` |
| 4 | `CMD_ERR_INTERLOCK` |

## Messages received by firmware (RX)

This section describes frames accepted by firmware on UDP/RS485.

## Common RX validation

- Only NMEA v2 is accepted (`ver=2`).
- CRC must be valid.
- Invalid frames are dropped and counted in `HB.RxErr`.

## UDP RX (`Engine::ProcessLine`)

### Peer telemetry intake (BAT1/BAT2 -> local pod)

Accepted for peer-state update:

| `MSG` | Required key(s) | Effect |
|---|---|---|
| `ENV` | `Vbatt_mv` | Updates peer battery voltage cache (`peer_vbatt_mv`). |
| `PWR` | `BusConn` | Updates peer bus connection cache (`peer_bus_conn`). |

These frames are consumed internally (no ACK).

### Light bridge passthrough (controller UI -> RS485)

Forwarded transparently to RS485 (no ACK generated):

| Condition | Behavior |
|---|---|
| `DST=LGT*` or `DST=BUS` | Forward line unchanged to RS485 bus. |
| `DST=ALL` and `MSG=LGT` | Forward line unchanged to RS485 bus. |
| `DST=ALL` and `MSG=CMD` with `Type=LGT` | Forward line unchanged to RS485 bus. |

When the bridged frame source is `SFC`, firmware records it as recent light-bus activity and suppresses the autonomous light status poll for `LGT_STATUS_CMD_IDLE_MS` (default 1000 ms).

### Light ID configuration (SFC -> firmware)

The SFC must tell each pod which light IDs are physically connected to that pod's RS485 bus. Send a local `CMD` to `BAT1`, `BAT2`, or `ALL`.

Supported payloads:

| Payload | Behavior |
|---|---|
| `CmdId,<id>,Type,LGT_IDS,Ids,1;2;3` | Sets the polling list to light IDs 1, 2 and 3. Separators accepted in `Ids`: `;`, `|`, `:`. `LGT1;LGT2` is also accepted. |
| `CmdId,<id>,Type,LGT_IDS,Mask,0x00000007` | Sets IDs from bitmask; bit 0 means `LGT1`, bit 1 means `LGT2`, up to `LGT32`. |
| `CmdId,<id>,Type,LGT_IDS,Clear,1` | Clears the polling list. |
| `CmdId,<id>,Type,LGT_CFG,...` | Alias for `LGT_IDS`. |

The firmware returns the standard `ACK`. If no IDs are configured, no autonomous status request is generated on that pod.

### Autonomous light status poll (firmware -> RS485)

If enabled and configured, each pod sends one request per second on its own RS485 bus while the SFC is not sending light commands. IDs are polled round-robin:

`$BUS,LGT<id>,CMD,2,<seq>,<ts_ms>,CmdId,<seq>,Type,LGT,Op,STATUS,Id,<id>*CRC`

Default guards:

| Setting | Default | Behavior |
|---|---:|---|
| `LGT_STATUS_POLL_PERIOD_MS` | 1000 ms | Minimum period between generated requests. |
| `LGT_STATUS_CMD_IDLE_MS` | 1000 ms | Minimum idle time after an SFC light command before polling resumes. |
| `LGT_STATUS_BUS_IDLE_MS` | 50 ms | Minimum idle time after an RS485 RX line before polling. |
| `LGT_STATUS_POLL_MASTER_ONLY` | 0 | Both `BAT1` and `BAT2` generate polls on their separate RS485 buses. |
| `LGT_MAX_POLL_IDS` | 16 | Maximum configured light IDs per pod. |

### Local command handling (`MSG=CMD`)

A `CMD` is handled only if:

- `DST` is this node header (`BAT1` or `BAT2`) or `ALL`
- `SRC` is `SFC` or peer header (`BAT1`/`BAT2` opposite node)

On handling, firmware emits `ACK` to `SRC`.

Supported `CMD Type` values:

### `Type=VBUS`

Required keys:

- `CmdId`
- `On` (or alias `Val`) with boolean semantics (`0/1`)

Optional:

- `Hold_ms` (default `CMD_VBUS_HOLD_MS_DEFAULT=5000`)

Behavior:

- Does not switch hardware directly.
- Sets manual override for PowerSM (`manual_vbus_cmd`) until `now + Hold_ms`.
- If `On=1`, interlocks are checked first; on fail returns `CMD_ERR_INTERLOCK`.

### `Type=VMOT`

Required keys:

- `CmdId`
- `On` (or alias `Val`) with boolean semantics (`0/1`)

Behavior:

- `On=1`: starts sequential VMOT enable logic.
- `On=0`: clears VMOT command and turns VMOT channels off.
- If `On=1`, interlocks are checked first; on fail returns `CMD_ERR_INTERLOCK`.

### `Type=DVTHR`

Required keys:

- `CmdId`
- `mv` (or alias `dV_thr_mv`)

Validation:

- allowed range: `50..5000` mV

Behavior:

- updates runtime delta threshold config (`_dv_thr_mv_cfg`).

### `Type=LGT_IDS` / `Type=LGT_CFG`

Required keys:

- `CmdId`
- one of `Ids`, `Mask`, or `Clear`

Behavior:

- Configures which light IDs the receiving pod polls on its local RS485 bus.
- `Ids` accepts semicolon/pipe/colon separated numeric IDs, with optional `LGT` prefix.
- `Mask` maps bit 0 to `LGT1`, bit 1 to `LGT2`, up to `LGT32`.
- `Clear=1`, `Ids,0`, `Ids,none`, `Ids,clear`, or `Mask,0` disables automatic polling.
- Invalid IDs or more than `LGT_MAX_POLL_IDS` return `CMD_ERR_BAD_VALUE`.

### `Type=ALM_CLR`

Required keys:

- `CmdId`
- either `All=1` or `Id=<u16>`

Behavior:

- `All=1`: clears all managed alarms (including local VESC range).
- `Id`: clears one alarm id.

### `Type=OVR_CLR`

Required keys:

- `CmdId`

Behavior:

- clears VBUS manual override (`manual_override=0`, `manual_vbus_cmd=0`).

### Command error responses

| Condition | `ACK.Err` | `ACK.Text` (example) |
|---|---|---|
| Missing mandatory key | `1` (`CMD_ERR_MISSING_KEY`) | `MissingCmdId`, `MissingType`, `MissingOn`, ... |
| Bad value/range | `2` (`CMD_ERR_BAD_VALUE`) | `mvRange` |
| Unsupported `Type` | `3` (`CMD_ERR_UNSUPPORTED`) | `UnknownType` |
| Interlock blocked | `4` (`CMD_ERR_INTERLOCK`) | `Leak`, `OverTemp`, `BattInvert`, `OverCurrent`, `I2CError` |

## RS485 RX (light bus -> SFC)

- Lines from RS485 are parsed as NMEA v2.
- If valid (`CRC + ver=2`), they are forwarded to SFC.
- Invalid lines are dropped and counted in `HB.RxErr`.
- Responses to the autonomous light status poll use the same path; firmware forwards valid light frames unchanged to the SFC.

## Notes for UI implementation

- Parse payload as CSV key/value pairs; order is stable in current firmware but key-based parsing is recommended.
- Role-dependent VMOT keys:
  - BAT1: `Vmot1On`,`Vmot2On`,`Vmot3On`
  - BAT2: `Vmot4On`,`Vmot5On`,`Vmot6On`
- `ALM` should be handled as event stream (edge + periodic repeats), not as full-state snapshot.
- For online state badges, `HB.NodeState` is the synthesized node health indicator. Offline state is derived from the node liveness rule above.

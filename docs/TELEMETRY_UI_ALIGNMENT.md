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
| `Feat_ESC_CAN` | u8 | bool | Currently `1`. |

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
| 101 | `VMOT_REASON_CH1_RDY_FAIL` |
| 102 | `VMOT_REASON_CH2_RDY_FAIL` |
| 103 | `VMOT_REASON_CH3_RDY_FAIL` |
| 201 | `VMOT_REASON_CH1_FAULT` |
| 202 | `VMOT_REASON_CH2_FAULT` |
| 203 | `VMOT_REASON_CH3_FAULT` |

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

### Light bridge passthrough (SFC -> RS485)

Forwarded transparently to RS485 (no ACK generated):

| Condition | Behavior |
|---|---|
| `SRC=SFC` and (`DST=LGT*` or `DST=ALL`) and `MSG=LGT` | Forward line unchanged to RS485 bus. |
| `SRC=SFC` and (`DST=LGT*` or `DST=ALL`) and `MSG=CMD` with `Type=LGT` | Forward line unchanged to RS485 bus. |

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

## Notes for UI implementation

- Parse payload as CSV key/value pairs; order is stable in current firmware but key-based parsing is recommended.
- Role-dependent VMOT keys:
  - BAT1: `Vmot1On`,`Vmot2On`,`Vmot3On`
  - BAT2: `Vmot4On`,`Vmot5On`,`Vmot6On`
- `ALM` should be handled as event stream (edge + periodic repeats), not as full-state snapshot.
- For state badges, `HB.NodeState` is the synthesized node health indicator.

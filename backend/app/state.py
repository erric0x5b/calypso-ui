import os
import json
import csv
import time
from datetime import datetime
from typing import Tuple, Dict, Any

# Minimal state container extracted from main.py
latest: Dict[str, Any] = {"last_line": None}

state: Dict[str, Any] = {
    "proto": {"ver": 2},
    "nodes": {},
    "pods": {"BAT1": {}, "BAT2": {}},
    "esc": {},
    "lights": {"ids": {}},
    "alarms_active": [],
    "alarms_history": [],
    "counters": {
        "udp_rx": 0,
        "parse_ok": 0,
        "parse_err": 0,
        "cksum_err": 0,
    },
    "last_update_ms": None,
}

# logging paths / metadata (populated by init_state or set_session_paths)
telemetry_path: str | None = None
alarms_path: str | None = None
events_path: str | None = None

TELEMETRY_HEADER = ["ts_ms", "src", "msg", "raw", "heading", "depth", "pitch", "roll"]


def _default_logging(ctx_sid: str = None):
    sid = ctx_sid or datetime.now().strftime("%Y%m%d_%H%M%S")
    return {"enabled": True, "sid": sid, "telemetry_path": telemetry_path, "alarms_path": alarms_path, "events_path": events_path}


state.setdefault("logging", {"enabled": False, "sid": None})
state.setdefault("system", {
    "shutdown": {
        "in_progress": False,
        "requested_ts_ms": 0,
        "requested_by": None,
        "cmd_id": None,
        "dst": "BAT1",
        "host": None,
        "last_error": None,
    }
})
state.setdefault("att", {"roll_deg": None, "pitch_deg": None, "yaw_deg": None})
state.setdefault("nav", {
    "depth_m": None,
    "heading_deg": None,
    "alt_m": None,
    "lat_deg": None,
    "lon_deg": None,
    "mission_time_s": None,
})
state.setdefault("mav", {
    "last_ms": 0,
    "msgs": 0,
    "drops": 0,
    "safety_armed": None,
    "base_mode": None,
    "last_heartbeat_ms": 0,
})
state.setdefault("cmd", {"pending": {}, "history": [], "last_ack": None})
state.setdefault("strobo", {
    "on": None,
    "dst": "BAT1",
    "pending": False,
    "desired_on": None,
    "last_cmd_id": None,
    "last_ts_ms": 0,
    "last_ack": None,
    "last_error": None,
})
state.setdefault("controller", {
    "online": False,
    "last_update_ms": 0,
    "last_seen_monotonic_ms": 0,
    "seq": None,
    "ts_ms": None,
    "controller_online": False,
    "active_link": "no_link",
    "usb_available": False,
    "bt_available": False,
    "source_quality": None,
    "profile": None,
    "mode": None,
    "raw": {},
    "buttons": {},
    "switches": {},
    "mapped": {},
    "events": [],
    "health": {
        "link_stale": True,
        "vjoy_ok": False,
        "safe_output": True,
    },
})

# LiFePO4 OCV->SOC approximation table (single cell, at-rest).
# NOTE: under load and temperature variations this estimate can drift significantly.
LFP_OCV_SOC_POINTS = [
    (2.80, 0.0),
    (3.00, 5.0),
    (3.10, 10.0),
    (3.20, 20.0),
    (3.24, 30.0),
    (3.26, 40.0),
    (3.28, 50.0),
    (3.30, 60.0),
    (3.31, 68.0),
    (3.32, 76.0),
    (3.33, 84.0),
    (3.34, 90.0),
    (3.35, 94.0),
    (3.38, 97.0),
    (3.42, 99.0),
    (3.55, 100.0),
]
LFP_SERIES_CELLS = 14
LIGHT_FAULT_BITS = [
    {"bit": 0, "value": 0x00000001, "name": "OPENLED", "description": "Fault pin OPENLED attivo"},
    {"bit": 1, "value": 0x00000002, "name": "OVERTEMP", "description": "Temperatura hardware o LED oltre soglia"},
    {"bit": 2, "value": 0x00000004, "name": "OVERCURR", "description": "Corrente bus oltre soglia"},
    {"bit": 3, "value": 0x00000008, "name": "UNDERVOLT", "description": "Tensione bus sotto soglia"},
    {"bit": 4, "value": 0x00000010, "name": "INA_ALERT", "description": "Diagnostica INA238 in fault"},
]


def _interp_soc(points: list[tuple[float, float]], x: float) -> float:
    if x <= points[0][0]:
        return float(points[0][1])
    if x >= points[-1][0]:
        return float(points[-1][1])
    for i in range(1, len(points)):
        x1, y1 = points[i - 1]
        x2, y2 = points[i]
        if x <= x2:
            if x2 <= x1:
                return float(y2)
            t = (x - x1) / (x2 - x1)
            return float(y1 + t * (y2 - y1))
    return float(points[-1][1])


def estimate_soc_lifepo4_14s(vbatt_mv: Any) -> float | None:
    try:
        mv = float(vbatt_mv)
    except Exception:
        return None
    if mv <= 0:
        return None
    v_cell = (mv / 1000.0) / float(LFP_SERIES_CELLS)
    if v_cell < 2.0 or v_cell > 4.5:
        return None
    soc = _interp_soc(LFP_OCV_SOC_POINTS, v_cell)
    return max(0.0, min(100.0, soc))


def apply_soc_estimation(pod: dict, kv: dict) -> None:
    real_soc = None
    for key in ("SOC", "Soc", "SOC_pct", "Soc_pct"):
        if key in kv:
            try:
                real_soc = float(kv.get(key))
            except Exception:
                real_soc = None
            break

    if real_soc is not None:
        pod["SOC"] = max(0.0, min(100.0, real_soc))
        pod["SOC_source"] = "BMS"
        pod["SOC_estimated"] = 0
        return

    vbatt_mv = kv.get("Vbatt_mv", pod.get("Vbatt_mv"))
    est = estimate_soc_lifepo4_14s(vbatt_mv)
    if est is None:
        return

    pod["SOC"] = round(est, 1)
    pod["SOC_source"] = "EST_VOLT_14S_LFP"
    pod["SOC_estimated"] = 1


def parse_int_mask(value) -> int:
    if value is None:
        return 0
    try:
        if isinstance(value, str):
            return int(value.strip(), 0)
        return int(value)
    except Exception:
        return 0


def update_light_faults(ts_ms, src: str, light_id: int, fault_mask: int) -> None:
    lights = state.setdefault("lights", {})
    active = lights.setdefault("faults_active", {})
    history = lights.setdefault("faults_history", [])
    for fault in LIGHT_FAULT_BITS:
        value = int(fault["value"])
        key = f"{light_id}:{fault['name']}"
        is_active = (fault_mask & value) != 0
        if is_active and key not in active:
            event = {
                "ts_ms": ts_ms,
                "src": src,
                "light_id": light_id,
                "bit": fault["bit"],
                "value": value,
                "name": fault["name"],
                "active": 1,
                "text": f"LGT{light_id}:{fault['name']}",
            }
            active[key] = event
            history.append(event)
        elif not is_active and key in active:
            event = {
                "ts_ms": ts_ms,
                "src": src,
                "light_id": light_id,
                "bit": fault["bit"],
                "value": value,
                "name": fault["name"],
                "active": 0,
                "text": f"LGT{light_id}:{fault['name']}:CLEARED",
            }
            history.append(event)
            active.pop(key, None)

    if len(history) > 200:
        del history[:-200]

# simple command id generator
_cmd_id = 0


def next_cmd_id() -> int:
    global _cmd_id
    _cmd_id = (_cmd_id + 1) & 0xFFFFFFFF
    return _cmd_id


def session_id_utc() -> str:
    return datetime.utcnow().strftime("%Y%m%d_%H%M%S")


def init_state(log_dir: str):
    """Prepare initial logging files and populate state.logging."""
    global telemetry_path, alarms_path, events_path
    os.makedirs(log_dir, exist_ok=True)
    sid = datetime.now().strftime("%Y%m%d_%H%M%S")
    telemetry_path = os.path.join(log_dir, f"telemetry_{sid}.csv")
    alarms_path = os.path.join(log_dir, f"alarms_{sid}.csv")
    events_path = os.path.join(log_dir, f"events_{sid}.jsonl")
    for pth in (telemetry_path, alarms_path, events_path):
        os.makedirs(os.path.dirname(pth), exist_ok=True)
        open(pth, "a", encoding="utf-8").close()
    state["logging"] = {
        "enabled": False,
        "sid": None,
        "telemetry_path": telemetry_path,
        "alarms_path": alarms_path,
        "events_path": events_path,
    }


def set_session_paths(sid: str) -> None:
    """Set logging file paths for a given session id and ensure files exist."""
    global telemetry_path, alarms_path, events_path
    telemetry_path = os.path.join(os.path.dirname(telemetry_path) if telemetry_path else os.getcwd(), f"telemetry_{sid}.csv")
    alarms_path = os.path.join(os.path.dirname(alarms_path) if alarms_path else os.getcwd(), f"alarms_{sid}.csv")
    events_path = os.path.join(os.path.dirname(events_path) if events_path else os.getcwd(), f"events_{sid}.jsonl")
    for pth in (telemetry_path, alarms_path, events_path):
        os.makedirs(os.path.dirname(pth), exist_ok=True)
        open(pth, "a", encoding="utf-8").close()
    state["logging"] = {"enabled": True, "sid": sid, "telemetry_path": telemetry_path, "alarms_path": alarms_path, "events_path": events_path}


def new_session_paths(sid: str) -> Tuple[str, str, str]:
    t = os.path.join(os.path.dirname(telemetry_path) if telemetry_path else os.getcwd(), f"telemetry_{sid}.csv")
    a = os.path.join(os.path.dirname(alarms_path) if alarms_path else os.getcwd(), f"alarms_{sid}.csv")
    e = os.path.join(os.path.dirname(events_path) if events_path else os.getcwd(), f"events_{sid}.jsonl")
    for pth in (t, a, e):
        os.makedirs(os.path.dirname(pth), exist_ok=True)
        open(pth, "a", encoding="utf-8").close()
    return t, a, e


def make_sid() -> str:
    return datetime.now().strftime("%Y%m%d_%H%M%S")


def _cmd_state() -> dict:
    return state.setdefault("cmd", {"pending": {}, "history": [], "last_ack": None})


def expire_pending_cmds(timeout_ms: int = 5000, now_monotonic_ms: int | None = None) -> None:
    cmd = _cmd_state()
    pending = cmd.setdefault("pending", {})
    now_ms = int(now_monotonic_ms if now_monotonic_ms is not None else time.monotonic() * 1000)
    expired: list[tuple[str, dict]] = []
    for sid, sent in list(pending.items()):
        ts = int(sent.get("sent_monotonic_ms") or 0)
        if ts <= 0:
            continue
        if now_ms - ts < int(timeout_ms):
            continue
        expired.append((sid, sent))

    for sid, sent in expired:
        sent["status"] = "timeout"
        cmd["last_cmd_result"] = sent
        if str(sent.get("type") or "").upper() == "STROBO":
            strobo = state.setdefault("strobo", {})
            strobo["pending"] = False
            strobo["last_error"] = "ack timeout"
        pending.pop(sid, None)


def register_cmd(cmd_id: int, cmd_type: str, dst: str, ts_ms: int | None, payload: dict | None = None) -> None:
    cmd = _cmd_state()
    pending = cmd.setdefault("pending", {})
    cmd_type_norm = str(cmd_type or "").upper()
    sid = str(int(cmd_id) & 0xFFFFFFFF)
    pending[sid] = {
        "cmd_id": int(cmd_id) & 0xFFFFFFFF,
        "type": cmd_type_norm,
        "dst": str(dst or ""),
        "ts_ms": int(ts_ms or 0),
        "sent_monotonic_ms": int(time.monotonic() * 1000),
        "payload": payload or {},
        "status": "sent",
    }
    if cmd_type_norm == "STROBO":
        strobo = state.setdefault("strobo", {})
        desired_on = payload.get("on") if isinstance(payload, dict) else None
        try:
            desired_on = int(desired_on)
        except Exception:
            desired_on = None
        strobo["dst"] = str(dst or "BAT1")
        strobo["pending"] = True
        strobo["desired_on"] = desired_on
        strobo["last_cmd_id"] = int(cmd_id) & 0xFFFFFFFF
        strobo["last_ts_ms"] = int(ts_ms or 0)
        strobo["last_error"] = None
    while len(pending) > 128:
        pending.pop(next(iter(pending)))


def record_ack(ts_ms: int, src: str, cmd_id: int, ok: int, err: int | None = None, text: str | None = None) -> dict:
    cmd = _cmd_state()
    pending = cmd.setdefault("pending", {})
    history = cmd.setdefault("history", [])

    ack = {
        "ts_ms": int(ts_ms or 0),
        "src": str(src or ""),
        "cmd_id": int(cmd_id) & 0xFFFFFFFF,
        "ok": 1 if int(ok or 0) != 0 else 0,
        "err": None if err is None else int(err),
        "text": None if text is None else str(text),
    }

    cmd["last_ack"] = ack
    history.append(ack)
    if len(history) > 200:
        del history[:-200]

    sid = str(ack["cmd_id"])
    sent = pending.get(sid)
    if sent is not None:
        sent["status"] = "ack"
        sent["ack"] = ack
        cmd["last_cmd_result"] = sent
        if str(sent.get("type") or "").upper() == "STROBO":
            strobo = state.setdefault("strobo", {})
            strobo["pending"] = False
            strobo["last_ack"] = ack
            strobo["last_cmd_id"] = ack["cmd_id"]
            strobo["last_ts_ms"] = ack["ts_ms"]
            if ack["ok"] == 1:
                desired_on = sent.get("payload", {}).get("on")
                try:
                    strobo["on"] = int(desired_on)
                except Exception:
                    pass
                strobo["desired_on"] = strobo.get("on")
                strobo["last_error"] = None
            else:
                strobo["last_error"] = ack.get("text") or ack.get("err")
        pending.pop(sid, None)
    return ack


def get_cmd_ack_status(cmd_id: int) -> dict:
    expire_pending_cmds()
    cmd = _cmd_state()
    sid = str(int(cmd_id) & 0xFFFFFFFF)
    pending = cmd.get("pending", {})
    if sid in pending:
        return {"status": "pending", "cmd": pending[sid]}

    hist = cmd.get("history", [])
    target = int(cmd_id) & 0xFFFFFFFF
    for ack in reversed(hist):
        if int(ack.get("cmd_id", -1)) == target:
            return {"status": "ack", "ack": ack}

    return {"status": "unknown"}


def append_telemetry_csv(p: dict):
    """Append a telemetry line to telemetry_path if logging enabled."""
    if not state.get("logging", {}).get("enabled"):
        return
    if not telemetry_path:
        return
    nav = state.get("nav") or {}
    att = state.get("att") or {}
    try:
        write_header = (not os.path.isfile(telemetry_path)) or (os.path.getsize(telemetry_path) == 0)
        with open(telemetry_path, "a", encoding="utf-8", newline="") as f:
            w = csv.writer(f)
            if write_header:
                w.writerow(TELEMETRY_HEADER)
            w.writerow([
                p.get("ts_ms"),
                p.get("src"),
                p.get("msg"),
                p.get("raw"),
                nav.get("heading_deg"),
                nav.get("depth_m"),
                att.get("pitch_deg"),
                att.get("roll_deg"),
            ])
    except Exception:
        pass


def append_event_jsonl(evt: dict) -> bool:
    """Append one mission event (JSONL) to events_path when logging is enabled."""
    if not state.get("logging", {}).get("enabled"):
        return False
    if not events_path:
        return False
    try:
        with open(events_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(evt, ensure_ascii=False) + "\n")
        return True
    except Exception:
        return False


def append_alarm_csv(alarm: dict) -> bool:
    """Append one alarm row to alarms_path when logging is enabled."""
    if not state.get("logging", {}).get("enabled"):
        return False
    if not alarms_path:
        return False
    try:
        with open(alarms_path, "a", encoding="utf-8", newline="") as f:
            w = csv.writer(f)
            w.writerow([
                alarm.get("ts_ms"),
                alarm.get("src"),
                alarm.get("id"),
                alarm.get("sev"),
                alarm.get("active"),
                alarm.get("latched"),
                alarm.get("text"),
            ])
        return True
    except Exception:
        return False


def update_state(parsed: dict):
    """Update `state` from a parsed NMEA-like message (parsed from parser.parse_nmea_line).
    This implements the same logic previously embedded in `main.py`.
    """
    import backend.app.parser as parser_mod

    ts = parsed.get("ts_ms")
    src = parsed.get("src")
    msg = parsed.get("msg")
    rest = parsed.get("rest", [])
    kv = parser_mod.kv_payload_to_dict(rest)
    state["last_update_ms"] = ts

    # ensure node present
    if src not in state["nodes"]:
        state["nodes"][src] = {}
    state["nodes"][src]["last_rx_ms"] = ts

    # optional: save kv as hb
    state["nodes"][src].update({"hb": kv})

    if msg == "HB":
        up_raw = kv.get("Up", 1)
        try:
            up = int(up_raw) != 0
        except Exception:
            up = str(up_raw).strip().lower() not in ("0", "false", "off", "no")
        state["nodes"][src]["online"] = up
        state["nodes"][src]["last_hb_ms"] = ts
        state["nodes"][src]["last_seen_monotonic_ms"] = int(time.monotonic() * 1000)
        if src in state["pods"]:
            state["pods"][src]["online"] = up

    # Keep convenient per-pod connectivity flags in sync for UI.
    if src in state["pods"]:
        if "BusConn" in kv:
            try:
                state["pods"][src]["bus_conn"] = int(kv["BusConn"])
            except Exception:
                pass

    if msg == "ENV" and src in state["pods"]:
        state["pods"][src].update(kv)
        apply_soc_estimation(state["pods"][src], kv)
        return

    if msg == "PWR" and src in state["pods"]:
        state["pods"][src].update(kv)
        apply_soc_estimation(state["pods"][src], kv)
        return

    if msg == "DIG" and src in state["pods"]:
        state["pods"][src].update(kv)
        return

    if msg == "ACK":
        try:
            cmd_id = int(kv.get("CmdId"))
        except Exception:
            return

        ok = kv.get("Ok", 0)
        err = kv.get("Err")
        text = kv.get("Text")
        record_ack(ts_ms=ts, src=src, cmd_id=cmd_id, ok=ok, err=err, text=text)
        return

    if msg == "STATUS" and str(kv.get("Type", "")).upper() == "LGT" and str(kv.get("Op", "")).upper() == "STATUS":
        light_id = kv.get("Id")
        if light_id is None and isinstance(src, str) and src.upper().startswith("LGT"):
            raw_id = src[3:]
            if raw_id.isdigit():
                light_id = int(raw_id)
        try:
            light_id = int(light_id)
        except Exception:
            return
        if light_id < 1:
            return

        fault_mask = parse_int_mask(kv.get("Fault"))
        lights = state.setdefault("lights", {}).setdefault("ids", {})
        entry = dict(kv)
        entry.update({
            "lamp_id": light_id,
            "fault_mask": fault_mask,
            "src": src,
            "dst": parsed.get("dst"),
            "seq": parsed.get("seq"),
            "ts_ms": ts,
            "last_rx_ms": ts,
            "last_seen_monotonic_ms": int(time.monotonic() * 1000),
        })
        lights[str(light_id)] = entry
        state.setdefault("lights", {})["last_update_ms"] = ts
        update_light_faults(ts, src, light_id, fault_mask)
        return

    if msg == "ESC":
        esc_id = kv.get("VescId")
        if esc_id is None:
            return
        try:
            esc_id = int(esc_id)
        except Exception:
            return
        if esc_id not in state["esc"]:
            state["esc"][esc_id] = {}
        state["esc"][esc_id].update(kv)
        state["esc"][esc_id]["src"] = src
        state["esc"][esc_id]["ts_ms"] = ts
        return

    if msg == "ALM":
        alarm = {
            "ts_ms": ts,
            "src": src,
            "id": kv.get("Id"),
            "sev": kv.get("Sev"),
            "active": kv.get("Active", 1),
            "latched": kv.get("Latched", 0),
            "text": kv.get("Text") or kv.get("TextB64"),
        }
        state["alarms_history"].append(alarm)
        append_alarm_csv(alarm)
        if alarm["active"]:
            state["alarms_active"] = [a for a in state["alarms_active"] if not (a.get("id") == alarm["id"] and a.get("src") == src)]
            state["alarms_active"].append(alarm)
        else:
            state["alarms_active"] = [a for a in state["alarms_active"] if not (a.get("id") == alarm["id"] and a.get("src") == src)]
        return

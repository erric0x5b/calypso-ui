import os
from datetime import datetime
from typing import Tuple, Dict, Any

# Minimal state container extracted from main.py
latest: Dict[str, Any] = {"last_line": None}

state: Dict[str, Any] = {
    "proto": {"ver": 2},
    "nodes": {},
    "pods": {"BAT1": {}, "BAT2": {}},
    "esc": {},
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


def _default_logging(ctx_sid: str = None):
    sid = ctx_sid or datetime.now().strftime("%Y%m%d_%H%M%S")
    return {"enabled": True, "sid": sid, "telemetry_path": telemetry_path, "alarms_path": alarms_path, "events_path": events_path}


state.setdefault("logging", {"enabled": False, "sid": None})
state.setdefault("att", {"roll_deg": None, "pitch_deg": None, "yaw_deg": None})
state.setdefault("nav", {"depth_m": None, "heading_deg": None, "alt_m": None})
state.setdefault("mav", {"last_ms": 0, "msgs": 0, "drops": 0})

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


def append_telemetry_csv(p: dict):
    """Append a telemetry line to telemetry_path if logging enabled."""
    if not state.get("logging", {}).get("enabled"):
        return
    raw_escaped = p["raw"].replace('"', '""')
    try:
        with open(telemetry_path, "a", encoding="utf-8") as f:
            f.write(f'{p["ts_ms"]},{p["src"]},{p["msg"]},"{raw_escaped}"\n')
    except Exception:
        pass


def update_state(parsed: dict):
    """Update `state` from a parsed NMEA-like message (parsed from parser.parse_nmea_line).
    This implements the same logic previously embedded in `main.py`.
    """
    import backend.app.parser as parser_mod

    ts = parsed.get("ts_ms")
    src = parsed.get("src")
    msg = parsed.get("msg")
    rest = parsed.get("rest", [])

    state["last_update_ms"] = ts

    # ensure node present
    if src not in state["nodes"]:
        state["nodes"][src] = {}
    state["nodes"][src]["online"] = True
    state["nodes"][src]["last_hb_ms"] = ts

    kv = parser_mod.kv_payload_to_dict(rest)

    # optional: save kv as hb
    state["nodes"][src].update({"hb": kv})

    # Keep convenient per-pod connectivity flags in sync for UI.
    if src in state["pods"]:
        state["pods"][src]["online"] = True
        if "BusConn" in kv:
            try:
                state["pods"][src]["bus_conn"] = int(kv["BusConn"])
            except Exception:
                pass

    if msg == "ENV" and src in state["pods"]:
        state["pods"][src].update(kv)
        return

    if msg == "PWR" and src in state["pods"]:
        state["pods"][src].update(kv)
        return

    if msg == "DIG" and src in state["pods"]:
        state["pods"][src].update(kv)
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
        if alarm["active"]:
            state["alarms_active"] = [a for a in state["alarms_active"] if not (a.get("id") == alarm["id"] and a.get("src") == src)]
            state["alarms_active"].append(alarm)
        else:
            state["alarms_active"] = [a for a in state["alarms_active"] if not (a.get("id") == alarm["id"] and a.get("src") == src)]
        return

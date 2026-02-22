import threading
import os
import csv
import json
from datetime import datetime

LOG_LOCK = threading.Lock()

# context populated when logging starts
log_ctx = {
    "enabled": False,
    "sid": None,
    "telemetry_path": None,
    "alarms_path": None,
    "events_path": None,
    "telemetry_f": None,
    "alarms_f": None,
    "events_f": None,
    "telemetry_csv": None,
    "alarms_csv": None,
}

_LOG_DIR = None
_STATE = None

def init_logging(log_dir: str, state_ref: dict):
    global _LOG_DIR, _STATE
    _LOG_DIR = log_dir
    _STATE = state_ref

def session_id_utc() -> str:
    return datetime.utcnow().strftime("%Y%m%d_%H%M%S")

def _ensure_log_dir():
    os.makedirs(_LOG_DIR, exist_ok=True)

def log_is_on() -> bool:
    return bool(_STATE.get("logging", {}).get("enabled"))

def log_status_dict():
    lg = _STATE.get("logging") or {"enabled": False, "sid": None}
    return {
        "enabled": bool(lg.get("enabled")),
        "sid": lg.get("sid"),
        "telemetry": lg.get("telemetry"),
        "alarms": lg.get("alarms"),
        "events": lg.get("events"),
    }

def log_start_new_session():
    with LOG_LOCK:
        if log_ctx["enabled"]:
            return log_ctx["sid"]

        _ensure_log_dir()
        sid = session_id_utc()

        telemetry_path = os.path.join(_LOG_DIR, f"telemetry_{sid}.csv")
        alarms_path    = os.path.join(_LOG_DIR, f"alarms_{sid}.csv")
        events_path    = os.path.join(_LOG_DIR, f"events_{sid}.jsonl")

        tf = open(telemetry_path, "w", newline="", encoding="utf-8")
        af = open(alarms_path, "w", newline="", encoding="utf-8")
        ef = open(events_path, "a", encoding="utf-8")

        tcsv = csv.writer(tf)
        acsv = csv.writer(af)

        tcsv.writerow(["ts_ms", "src", "dst", "msg", "ver", "seq", "raw"])
        tf.flush()

        acsv.writerow(["ts_ms", "src", "id", "sev", "active", "latched", "text"])
        af.flush()

        log_ctx.update({
            "enabled": True,
            "sid": sid,
            "telemetry_path": telemetry_path,
            "alarms_path": alarms_path,
            "events_path": events_path,
            "telemetry_f": tf,
            "alarms_f": af,
            "events_f": ef,
            "telemetry_csv": tcsv,
            "alarms_csv": acsv,
        })

        _STATE["logging"] = {
            "enabled": True,
            "sid": sid,
            "telemetry": os.path.basename(telemetry_path),
            "alarms": os.path.basename(alarms_path),
            "events": os.path.basename(events_path),
        }
        return sid

def log_stop_session():
    with LOG_LOCK:
        if not log_ctx["enabled"]:
            return None

        for k in ("telemetry_f", "alarms_f", "events_f"):
            f = log_ctx.get(k)
            try:
                if f:
                    f.flush()
                    f.close()
            except Exception:
                pass

        sid = log_ctx["sid"]
        log_ctx.update({
            "enabled": False,
            "sid": None,
            "telemetry_path": None,
            "alarms_path": None,
            "events_path": None,
            "telemetry_f": None,
            "alarms_f": None,
            "events_f": None,
            "telemetry_csv": None,
            "alarms_csv": None,
        })

        _STATE["logging"] = {"enabled": False, "sid": None}
        return sid

def log_write_telemetry_row(ts_ms: int, parsed: dict, raw_line: str):
    with LOG_LOCK:
        if not log_ctx["enabled"] or not log_ctx.get("telemetry_csv"):
            return
        log_ctx["telemetry_csv"].writerow([
            ts_ms,
            parsed.get("src"),
            parsed.get("dst"),
            parsed.get("msg"),
            parsed.get("ver"),
            parsed.get("seq"),
            raw_line.strip()
        ])
        log_ctx["telemetry_f"].flush()

def log_write_alarm(alarm: dict):
    with LOG_LOCK:
        if not log_ctx["enabled"] or not log_ctx.get("alarms_csv"):
            return
        log_ctx["alarms_csv"].writerow([
            alarm.get("ts_ms"),
            alarm.get("src"),
            alarm.get("id"),
            alarm.get("sev"),
            alarm.get("active"),
            alarm.get("latched"),
            alarm.get("text"),
        ])
        log_ctx["alarms_f"].flush()

def log_write_event(evt: dict):
    with LOG_LOCK:
        if not log_ctx["enabled"] or not log_ctx.get("events_f"):
            return
        log_ctx["events_f"].write(json.dumps(evt, ensure_ascii=False) + "\n")
        log_ctx["events_f"].flush()

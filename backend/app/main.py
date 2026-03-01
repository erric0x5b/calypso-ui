import asyncio
import csv
from curses.ascii import alt
import io
import logging as py_logging
import json
import os
import re
import socket
import threading
import zipfile
from collections import deque
from datetime import datetime
from typing import Optional, Set

from fastapi import Body, FastAPI, HTTPException, WebSocket
from fastapi.responses import JSONResponse, RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

try:
    from pymavlink import mavutil
except ModuleNotFoundError:
    mavutil = None

from backend.app import lights_cfg, logging as app_logging, parser
from backend.app.sonar_ping360 import (
    load_cfg as ping360_load_cfg,
    save_cfg as ping360_save_cfg,
    ping360_task,
)
from backend.app.udp_rx import UdpRxStats, start_udp_listener

# state moved to backend.app.state
from backend.app.state import (
    state,
    latest,
    init_state,
    update_state,
    next_cmd_id,
    set_session_paths,
    make_sid,
    append_telemetry_csv,
    append_event_jsonl,
)

# ----------------------------
# Config (env)
# ----------------------------
HTTP_PORT = int(os.getenv("CALYPSO_HTTP_PORT", "8080"))  # (non usato da uvicorn in container)
UDP_RX_PORT = int(os.getenv("CALYPSO_UDP_RX_PORT", "14590"))
UDP_TX_PORT = int(os.getenv("CALYPSO_UDP_TX_PORT", "14591"))
UDP_TX_HOST = os.getenv("CALYPSO_UDP_TX_HOST", "192.168.2.10")

LOG_DIR = os.getenv("CALYPSO_LOG_DIR", "/data/deepex_logs")
OFFLINE_MS = int(os.getenv("CALYPSO_OFFLINE_MS", "5000"))

MAVLINK_HOST = os.getenv("MAVLINK_HOST", "127.0.0.1")
MAVLINK_PORT = int(os.getenv("MAVLINK_PORT", "8080"))
MAVLINK_CONN = f"udp:0.0.0.0:{MAVLINK_PORT}"

MAVLINK_WS_URL = os.getenv("MAVLINK_WS_URL", "ws://192.168.2.2:6040/v1/ws/mavlink")  # <-- non hardcoded
MAVLINK_ENABLED = os.getenv("MAVLINK_ENABLED", "1").strip().lower() in ("1", "true", "yes", "on")

MAVLINK_PYMAVLINK_AVAILABLE = (mavutil is not None)
MAVLINK_WS_ENABLED = MAVLINK_ENABLED and bool(MAVLINK_WS_URL)
MAVLINK_UDP_ENABLED = MAVLINK_ENABLED and (not MAVLINK_WS_ENABLED) and MAVLINK_PYMAVLINK_AVAILABLE

# Ensure log dir exists early
os.makedirs(LOG_DIR, exist_ok=True)

# ----------------------------
# Paths UI
# ----------------------------
BASE_DIR = os.path.dirname(__file__)          # /app/backend/app
UI_DIR = os.path.join(BASE_DIR, "static")     # /app/backend/app/static (contains index.html, app.css, js/...)

# ----------------------------
# App
# ----------------------------
py_logging.basicConfig(level=py_logging.INFO)

app = FastAPI(title="calypso-ui backend")
udp_stats = UdpRxStats()

# Serve UI under /ui (safe with /api routes)
app.mount("/ui", StaticFiles(directory=UI_DIR, html=True), name="ui")

# Root redirect (BlueOS opens "webpage": "/ui")
@app.get("/", include_in_schema=False)
def root():
    return RedirectResponse(url="/ui")

# ----------------------------
# BlueOS service registration
# ----------------------------
@app.get("/register_service", include_in_schema=False)
def register_service():
    return {
        "name": "Calypso UI",
        "description": "DeepEx ROV UI",
        "icon": "mdi-submarine",
        "company": "DeepEx",
        "version": "0.4.6",
        "new_page": True,
        "avoid_iframes": True,
        "works_in_relative_paths": True,
        "webpage": "/ui",
        "api": "/docs",
    }

@app.get("/docs.json", include_in_schema=False)
def docs_json():
    return JSONResponse(app.openapi())

# ----------------------------
# State init + logging
# ----------------------------
init_state(LOG_DIR)
app_logging.init_logging(LOG_DIR, state)

# ----------------------------
# WebSocket clients
# ----------------------------
ws_clients: Set[WebSocket] = set()

async def ws_broadcast(obj: dict):
    dead = []
    for ws in list(ws_clients):
        try:
            await ws.send_json(obj)
        except Exception:
            dead.append(ws)
    for ws in dead:
        ws_clients.discard(ws)

@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    ws_clients.add(ws)
    try:
        if latest.get("last_line"):
            await ws.send_json({"type": "last", "raw": latest["last_line"]})
        while True:
            # Keep connection alive; consume client messages if any
            try:
                await ws.receive_text()
            except Exception:
                await asyncio.sleep(30)
    finally:
        ws_clients.discard(ws)

# ----------------------------
# Utils
# ----------------------------
def now_ms() -> int:
    return int(asyncio.get_running_loop().time() * 1000) & 0xFFFFFFFF

def build_nmea_line(fields: list[str]) -> str:
    return parser.build_nmea_line(fields)

def parse_nmea_line(line: str):
    return parser.parse_nmea_line(line)

# Lights config delegation
load_lights_cfg = lights_cfg.load_lights_cfg
save_lights_cfg = lights_cfg.save_lights_cfg

# Ping360 stop flag
ping360_stop = asyncio.Event()

# UDP TX socket (created at import time is fine)
udp_tx_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

# ----------------------------
# UDP RX Server
# ----------------------------
def handle_udp_datagram(data: bytes, addr):
    try:
        state["counters"]["udp_rx"] += 1
        line = data.decode("ascii", errors="ignore")
    except Exception:
        return

    parsed, err = parse_nmea_line(line)
    if err:
        state["counters"]["parse_err"] += 1
        if err == "checksum":
            state["counters"]["cksum_err"] += 1
        return

    latest["last_line"] = parsed["raw"]
    append_telemetry_csv(parsed)
    update_state(parsed)

    asyncio.create_task(ws_broadcast({
        "type": "udp",
        "src": parsed["src"],
        "msg": parsed["msg"],
        "ts_ms": parsed["ts_ms"],
        "raw": parsed["raw"],
    }))


async def offline_watchdog():
    while True:
        await asyncio.sleep(1.0)
        for node, info in state["nodes"].items():
            last_hb = info.get("last_hb_ms")
            if last_hb is None:
                continue
            dt = (state["last_update_ms"] - last_hb) & 0xFFFFFFFF if state["last_update_ms"] is not None else 0
            if dt > OFFLINE_MS and info.get("online"):
                info["online"] = False
                if node in state.get("pods", {}):
                    state["pods"][node]["online"] = False
                alarm = {
                    "ts_ms": state["last_update_ms"],
                    "src": "SFC",
                    "id": 9001,
                    "sev": 3,
                    "active": 1,
                    "latched": 0,
                    "text": f"NODE_OFFLINE:{node}",
                }
                state["alarms_history"].append(alarm)
                state["alarms_active"].append(alarm)
                await ws_broadcast({"type": "alarm", "alarm": alarm})

# ----------------------------
# Startup (single)
# ----------------------------
@app.on_event("startup")
async def startup():
    loop = asyncio.get_running_loop()

    # UDP listener
    await start_udp_listener(udp_stats, on_datagram=handle_udp_datagram)

    # background tasks
    asyncio.create_task(offline_watchdog())

    # Ping360 task
    asyncio.create_task(ping360_task(state, ws_broadcast, ping360_stop))
    
    MAVLINK_UDP_ENABLED = False

    print("[mavlink] ENABLED:", MAVLINK_ENABLED,
      "WS_URL:", MAVLINK_WS_URL,
      "WS_ENABLED:", MAVLINK_WS_ENABLED,
      "UDP_ENABLED:", MAVLINK_UDP_ENABLED,
      "CONN:", MAVLINK_CONN)
    
    # MAVLink optional
    if MAVLINK_WS_ENABLED:
        asyncio.create_task(mavlink_ws_loop())
    elif MAVLINK_UDP_ENABLED:
        asyncio.create_task(mavlink_reader())
    else:
        print("[mavlink] disabled or no available transport")

# ----------------------------
# API
# ----------------------------
@app.get("/api/state")
def api_state():
    return {
        **state,
        "udp": {
            "listener_ok": udp_stats.listener_ok,
            "bind": udp_stats.listener_bind,
            "port": udp_stats.listener_port,
            "error": udp_stats.listener_error,
            "rx_total": udp_stats.rx_total,
            "last_ts_ms": udp_stats.rx_last_ts_ms,
            "last_from": udp_stats.rx_last_from,
            "last_len": udp_stats.rx_last_len,
            "last_msg": udp_stats.rx_last_msg,
            "last_src": udp_stats.rx_last_src,
            "last_dst": udp_stats.rx_last_dst,
            "last_ck_ok": udp_stats.rx_last_ck_ok,
            "last_prefix": udp_stats.rx_last_prefix,
        },
    }

@app.get("/api/health")
def api_health():
    return {
        "ok": True,
        "udp_rx_port": UDP_RX_PORT,
        "offline_ms": OFFLINE_MS,
        "counters": state["counters"],
        "last_update_ms": state["last_update_ms"],
        "nodes": {k: {"online": v.get("online"), "last_hb_ms": v.get("last_hb_ms")} for k, v in state["nodes"].items()},
    }

@app.post("/api/cmd/lights_channel")
async def cmd_lights_channel(body: dict = Body(...)):
    ch = int(body.get("ch", 1))
    mode = str(body.get("mode", "ON")).upper()
    dim = int(body.get("dim", 0))

    if ch not in (1, 2, 3, 4):
        return {"ok": False, "err": "bad ch"}
    if mode not in ("ON", "OFF", "TEST"):
        return {"ok": False, "err": "bad mode"}
    dim = max(0, min(1000, dim))

    cfg = load_lights_cfg()
    lamp_ids = cfg["channels"][str(ch)].get("lamp_ids", [])
    lamp_ids_str = "|".join(str(x) for x in lamp_ids)

    cmd_id = next_cmd_id()
    ts = int(state["last_update_ms"] or 0)

    fields = [
        "SFC", "ROV", "CMD", "2",
        str(cmd_id), str(ts),
        "CmdId", str(cmd_id),
        "Type", "LIGHTS_CH",
        "Ch", str(ch),
        "Mode", mode,
        "Dim", str(dim),
        "LampIds", lamp_ids_str,
    ]
    line = build_nmea_line(fields)
    udp_tx_sock.sendto(line.encode("ascii"), (UDP_TX_HOST, UDP_TX_PORT))

    return {"ok": True, "cmd_id": cmd_id, "lamp_ids": lamp_ids}

@app.get("/api/config/lights")
def api_get_lights_cfg():
    return load_lights_cfg()

@app.post("/api/config/lights")
def api_set_lights_cfg(cfg: dict = Body(...)):
    if "channels" not in cfg or not isinstance(cfg["channels"], dict):
        return JSONResponse({"ok": False, "err": "channels missing"}, status_code=400)

    out = {"version": int(cfg.get("version", 1)), "channels": {}}
    for k in ("1", "2", "3", "4"):
        ch = cfg["channels"].get(k, {})
        if not isinstance(ch, dict):
            return JSONResponse({"ok": False, "err": f"channels.{k} invalid"}, status_code=400)

        name = str(ch.get("name", f"CH{k}"))
        lamp_ids = ch.get("lamp_ids", [])
        if not isinstance(lamp_ids, list):
            return JSONResponse({"ok": False, "err": f"channels.{k}.lamp_ids invalid"}, status_code=400)

        cleaned = [x for x in lamp_ids if isinstance(x, int) and x >= 1]
        out["channels"][k] = {"name": name, "lamp_ids": sorted(set(cleaned))}

    save_lights_cfg(out)
    return {"ok": True}

SID_RE = re.compile(r"^\d{8}_\d{6}$")
SESSION_RE = re.compile(r"^(telemetry|alarms|events)_(\d{8}_\d{6})\.(csv|jsonl)$")

def list_sessions(log_dir: str):
    sessions = {}
    try:
        for name in os.listdir(log_dir):
            m = SESSION_RE.match(name)
            if not m:
                continue
            kind, sid, _ext = m.group(1), m.group(2), m.group(3)
            sessions.setdefault(sid, {})
            sessions[sid][kind] = os.path.join(log_dir, name)
    except FileNotFoundError:
        return {}
    return dict(sorted(sessions.items(), key=lambda kv: kv[0], reverse=True))

def parse_sid_list(payload: dict):
    raw = payload.get("sids")
    if not isinstance(raw, list):
        return None, "sids must be an array"

    out = []
    seen = set()
    for it in raw:
        sid = str(it or "").strip()
        if not SID_RE.fullmatch(sid):
            return None, "bad sid"
        if sid not in seen:
            seen.add(sid)
            out.append(sid)

    if not out:
        return None, "empty sids"
    return out, None

def sid_to_dt(sid: str) -> Optional[datetime]:
    try:
        return datetime.strptime(sid, "%Y%m%d_%H%M%S")
    except Exception:
        return None

def resolve_sid(requested_sid: str | None, sessions: dict, cur_sid: str | None) -> str | None:
    sid = (requested_sid or "").strip()
    if sid:
        if not SID_RE.fullmatch(sid):
            return None
        return sid
    if cur_sid and SID_RE.fullmatch(str(cur_sid)):
        return str(cur_sid)
    if sessions:
        return next(iter(sessions.keys()))
    return None

def mission_meta_path(sid: str) -> str:
    return os.path.join(LOG_DIR, f"manifest_{sid}.json")

def sanitize_mission_meta(raw: dict, sid: str) -> dict:
    raw = raw if isinstance(raw, dict) else {}

    def clean(key: str, max_len: int) -> str:
        return str(raw.get(key, "")).strip()[:max_len]

    out = {
        "title": clean("title", 120),
        "place": clean("place", 120),
        "objective": clean("objective", 240),
        "operator": clean("operator", 120),
        "date": clean("date", 16),
    }

    if out["date"] and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", out["date"]):
        out["date"] = ""

    if not out["date"]:
        dt = sid_to_dt(sid)
        if dt:
            out["date"] = dt.strftime("%Y-%m-%d")
    return out

def load_mission_meta(sid: str) -> dict:
    p = mission_meta_path(sid)
    if not os.path.isfile(p):
        return sanitize_mission_meta({}, sid)
    try:
        with open(p, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict) and isinstance(data.get("mission"), dict):
            data = data["mission"]
        return sanitize_mission_meta(data, sid)
    except Exception:
        return sanitize_mission_meta({}, sid)

def save_mission_meta(sid: str, mission: dict) -> dict:
    safe = sanitize_mission_meta(mission, sid)
    p = mission_meta_path(sid)
    tmp = p + ".tmp"
    payload = {"sid": sid, "mission": safe}
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)
    os.replace(tmp, p)
    return safe

def build_session_zip(buf: io.BytesIO, sessions: dict, sids: list[str], multi: bool):
    created_utc = datetime.utcnow().isoformat() + "Z"
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as z:
        if multi:
            manifest = {"created_utc": created_utc, "sessions": []}
            for sid in sids:
                files = sessions[sid]
                files_manifest = {}
                for kind in ("telemetry", "alarms", "events"):
                    p = files.get(kind)
                    if p and os.path.isfile(p):
                        name = os.path.basename(p)
                        z.write(p, arcname=f"{sid}/{name}")
                        files_manifest[kind] = name
                one_manifest = {
                    "sid": sid,
                    "created_utc": created_utc,
                    "files": files_manifest,
                    "mission": load_mission_meta(sid),
                }
                z.writestr(f"{sid}/manifest_{sid}.json", json.dumps(one_manifest, indent=2))
                manifest["sessions"].append(one_manifest)
            z.writestr("manifest_multi.json", json.dumps(manifest, indent=2))
        else:
            sid = sids[0]
            files = sessions[sid]
            files_manifest = {}
            for kind in ("telemetry", "alarms", "events"):
                p = files.get(kind)
                if p and os.path.isfile(p):
                    name = os.path.basename(p)
                    z.write(p, arcname=name)
                    files_manifest[kind] = name
            manifest = {
                "sid": sid,
                "created_utc": created_utc,
                "files": files_manifest,
                "mission": load_mission_meta(sid),
            }
            z.writestr(f"manifest_{sid}.json", json.dumps(manifest, indent=2))

@app.get("/api/log/sessions")
def api_log_sessions():
    sessions = list_sessions(LOG_DIR)
    out = []
    for sid, files in sessions.items():
        out.append({
            "sid": sid,
            "telemetry": os.path.basename(files.get("telemetry", "")) if "telemetry" in files else None,
            "alarms": os.path.basename(files.get("alarms", "")) if "alarms" in files else None,
            "events": os.path.basename(files.get("events", "")) if "events" in files else None,
        })
    return {"sessions": out}

@app.get("/api/log/zip")
def api_log_zip(sid: str):
    if not SID_RE.fullmatch(sid):
        raise HTTPException(status_code=400, detail="bad sid")

    sessions = list_sessions(LOG_DIR)
    if sid not in sessions:
        raise HTTPException(status_code=404, detail="session not found")

    buf = io.BytesIO()
    build_session_zip(buf, sessions, [sid], multi=False)

    buf.seek(0)
    filename = f"deepex_logs_{sid}.zip"
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )

@app.post("/api/log/zip_many")
def api_log_zip_many(payload: dict = Body(...)):
    sids, err = parse_sid_list(payload)
    if err:
        return JSONResponse({"ok": False, "err": err}, status_code=400)

    sessions = list_sessions(LOG_DIR)
    missing = [sid for sid in sids if sid not in sessions]
    if missing:
        return JSONResponse({"ok": False, "err": "session not found", "missing": missing}, status_code=404)

    buf = io.BytesIO()
    build_session_zip(buf, sessions, sids, multi=True)
    buf.seek(0)

    now_tag = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
    filename = f"deepex_logs_multi_{now_tag}.zip"
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )

@app.post("/api/log/delete")
def api_log_delete(payload: dict = Body(...)):
    sid = str(payload.get("sid", "")).strip()
    if not SID_RE.fullmatch(sid):
        return JSONResponse({"ok": False, "err": "bad sid"}, status_code=400)

    sessions = list_sessions(LOG_DIR)
    if sid not in sessions:
        return JSONResponse({"ok": False, "err": "session not found"}, status_code=404)

    cur = state.get("logging", {"enabled": False, "sid": None})
    if cur.get("enabled") and cur.get("sid") == sid:
        return JSONResponse({"ok": False, "err": "stop logging before deleting current session"}, status_code=409)

    removed = []
    files = sessions[sid]
    for kind in ("telemetry", "alarms", "events"):
        p = files.get(kind)
        if p and os.path.isfile(p):
            try:
                os.remove(p)
                removed.append(os.path.basename(p))
            except Exception:
                pass

    if (not cur.get("enabled")) and cur.get("sid") == sid:
        state["logging"] = {"enabled": False, "sid": None}

    return {"ok": True, "sid": sid, "removed": removed}

@app.post("/api/log/delete_many")
def api_log_delete_many(payload: dict = Body(...)):
    sids, err = parse_sid_list(payload)
    if err:
        return JSONResponse({"ok": False, "err": err}, status_code=400)

    cur = state.get("logging", {"enabled": False, "sid": None})
    if cur.get("enabled") and cur.get("sid") in sids:
        return JSONResponse({"ok": False, "err": "stop logging before deleting current session"}, status_code=409)

    sessions = list_sessions(LOG_DIR)
    missing = [sid for sid in sids if sid not in sessions]

    deleted = []
    removed_by_sid = {}
    for sid in sids:
        files = sessions.get(sid)
        if not files:
            continue

        removed = []
        for kind in ("telemetry", "alarms", "events"):
            p = files.get(kind)
            if p and os.path.isfile(p):
                try:
                    os.remove(p)
                    removed.append(os.path.basename(p))
                except Exception:
                    pass
        deleted.append(sid)
        removed_by_sid[sid] = removed

        if (not cur.get("enabled")) and cur.get("sid") == sid:
            state["logging"] = {"enabled": False, "sid": None}

    return {"ok": True, "deleted": deleted, "missing": missing, "removed": removed_by_sid}

@app.get("/api/log/manifest")
def api_log_manifest(sid: str | None = None):
    sessions = list_sessions(LOG_DIR)
    cur = state.get("logging", {"enabled": False, "sid": None})
    chosen_sid = resolve_sid(sid, sessions, cur.get("sid"))
    if not chosen_sid:
        return JSONResponse({"ok": False, "err": "sid not available"}, status_code=404)
    if chosen_sid not in sessions:
        return JSONResponse({"ok": False, "err": "session not found"}, status_code=404)

    files = sessions[chosen_sid]
    sid_dt = sid_to_dt(chosen_sid)
    manifest = {
        "sid": chosen_sid,
        "created_utc": (sid_dt.isoformat() + "Z") if sid_dt else None,
        "files": {},
        "mission": load_mission_meta(chosen_sid),
    }
    sizes = {}
    for kind in ("telemetry", "alarms", "events"):
        p = files.get(kind)
        if p and os.path.isfile(p):
            name = os.path.basename(p)
            manifest["files"][kind] = name
            try:
                sizes[kind] = os.path.getsize(p)
            except Exception:
                sizes[kind] = None

    now = datetime.now()
    elapsed_sec = None
    if sid_dt:
        elapsed_sec = max(0, int((now - sid_dt).total_seconds()))

    return {
        "ok": True,
        "manifest": manifest,
        "sizes": sizes,
        "logging_enabled": bool(cur.get("enabled")),
        "current_sid": cur.get("sid"),
        "is_current": str(cur.get("sid") or "") == chosen_sid,
        "elapsed_sec": elapsed_sec,
    }

@app.post("/api/log/manifest_meta")
def api_log_manifest_meta(payload: dict = Body(...)):
    sessions = list_sessions(LOG_DIR)
    cur = state.get("logging", {"enabled": False, "sid": None})
    req_sid = str(payload.get("sid", "")).strip() or None
    chosen_sid = resolve_sid(req_sid, sessions, cur.get("sid"))
    if not chosen_sid:
        return JSONResponse({"ok": False, "err": "sid not available"}, status_code=404)
    if chosen_sid not in sessions:
        return JSONResponse({"ok": False, "err": "session not found"}, status_code=404)

    mission = payload.get("mission")
    if mission is None:
        # fallback: support flat payload keys
        mission = {k: payload.get(k) for k in ("title", "place", "objective", "operator", "date")}

    try:
        saved = save_mission_meta(chosen_sid, mission)
    except Exception:
        return JSONResponse({"ok": False, "err": "failed to save mission metadata"}, status_code=500)

    return {"ok": True, "sid": chosen_sid, "mission": saved}

@app.get("/api/log/events_tail")
def api_log_events_tail(sid: str | None = None, limit: int = 20):
    limit = max(1, min(int(limit or 20), 200))
    sessions = list_sessions(LOG_DIR)
    cur = state.get("logging", {"enabled": False, "sid": None})
    chosen_sid = resolve_sid(sid, sessions, cur.get("sid"))
    if not chosen_sid:
        return {"ok": True, "sid": None, "events": []}
    if chosen_sid not in sessions:
        return JSONResponse({"ok": False, "err": "session not found"}, status_code=404)

    events_file = sessions[chosen_sid].get("events")
    if not events_file or not os.path.isfile(events_file):
        return {"ok": True, "sid": chosen_sid, "events": []}

    tail = deque(maxlen=limit)
    with open(events_file, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                tail.append(line)

    out = []
    for line in reversed(tail):
        try:
            out.append(json.loads(line))
        except Exception:
            out.append({"raw": line})

    return {"ok": True, "sid": chosen_sid, "events": out}

@app.get("/api/log/status")
def api_log_status():
    return state.get("logging", {"enabled": False, "sid": None})

@app.post("/api/log/start")
def api_log_start():
    sid = make_sid()
    set_session_paths(sid)
    state["logging"] = {"enabled": True, "sid": sid}
    return {"ok": True, "sid": sid}

@app.post("/api/log/stop")
def api_log_stop():
    cur = state.get("logging", {"enabled": False, "sid": None})
    state["logging"] = {"enabled": False, "sid": cur.get("sid")}
    return {"ok": True, "sid": state["logging"]["sid"]}

@app.post("/api/log/event")
def api_log_event(payload: dict = Body(...)):
    if not state.get("logging", {}).get("enabled"):
        return JSONResponse({"ok": False, "err": "logging disabled"}, status_code=400)

    typ = str(payload.get("type", "NOTE")).upper()
    text = str(payload.get("text", "")).strip()
    if not text:
        return JSONResponse({"ok": False, "err": "text empty"}, status_code=400)

    nav = state.get("nav") or {}
    evt = {
        "ts_ms": int(state.get("last_update_ms") or 0),
        "mission_time": nav.get("mission_time_s"),
        "depth": nav.get("depth_m"),
        "heading": nav.get("heading_deg"),
        "lat": nav.get("lat_deg"),
        "lon": nav.get("lon_deg"),
        "alt_m": nav.get("alt_m"),
        "src": "SFC",
        "type": typ,
        "text": text,
    }
    ok = append_event_jsonl(evt)
    if not ok:
        return JSONResponse({"ok": False, "err": "failed to write event log"}, status_code=500)
    return {"ok": True}

@app.get("/api/sonar/ping360/config")
def get_ping360_cfg():
    return ping360_load_cfg()

@app.post("/api/sonar/ping360/config")
def set_ping360_cfg(cfg: dict = Body(...)):
    ping360_save_cfg(cfg)
    return {"ok": True}

# ----------------------------
# MAVLink readers (unchanged)
# ----------------------------
async def mavlink_reader():
    def _run():
        m = mavutil.mavlink_connection(MAVLINK_CONN, autoreconnect=True, source_system=255)
        while True:
            msg = m.recv_match(blocking=True, timeout=1)
            if msg is None:
                continue

            t = now_ms()
            state["mav"]["last_ms"] = t
            state["mav"]["msgs"] += 1

            mt = msg.get_type()
            t_boot = getattr(msg, "time_boot_ms", None)
            if t_boot is not None:
                state["nav"]["mission_time_s"] = float(t_boot) / 1000.0

            if mt == "ATTITUDE":
                state["att"]["roll_deg"]  = msg.roll  * 57.295779513
                state["att"]["pitch_deg"] = msg.pitch * 57.295779513
                state["att"]["yaw_deg"]   = msg.yaw   * 57.295779513
            elif mt == "VFR_HUD":
                state["nav"]["heading_deg"] = getattr(msg, "heading", None)
                state["nav"]["alt_m"] = getattr(msg, "alt", None)
            elif mt == "GLOBAL_POSITION_INT":
                lat = getattr(msg, "lat", None)
                lon = getattr(msg, "lon", None)
                hdg = getattr(msg, "hdg", None)
                rel_alt = getattr(msg, "relative_alt", None)

                if lat is not None:
                    state["nav"]["lat_deg"] = float(lat) / 1e7
                if lon is not None:
                    state["nav"]["lon_deg"] = float(lon) / 1e7
                if hdg is not None and int(hdg) != 65535:
                    state["nav"]["heading_deg"] = float(hdg) / 100.0
                if rel_alt is not None:
                    state["nav"]["alt_m"] = float(rel_alt) / 1000.0

    await asyncio.to_thread(_run)

async def mavlink_ws_loop():
    import json, asyncio, websockets

    INV = {1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1}  # metti -1 dove serve

    PWM_MIN = 1100
    PWM_TRIM = 1500
    PWM_MAX = 1900

    def pwm_to_pct(pwm: int) -> float:
        if pwm < PWM_MIN:
            pwm = PWM_MIN
        if pwm > PWM_MAX:
            pwm = PWM_MAX
        if pwm >= PWM_TRIM:
            return (pwm - PWM_TRIM) / (PWM_MAX - PWM_TRIM) * 100.0
        return - (PWM_TRIM - pwm) / (PWM_TRIM - PWM_MIN) * 100.0

    RAD2DEG = 57.295779513

    # throttle broadcast thr per non spammare la UI
    last_thr_push = 0.0
    THR_PUSH_MIN_DT = 0.05  # 50ms => max 20Hz

    while True:
        try:
            print(f"[mavlink] connecting to {MAVLINK_WS_URL}")
            async with websockets.connect(MAVLINK_WS_URL, ping_interval=20, ping_timeout=20) as ws:
                print("[mavlink] connected")

                async for raw in ws:
                    try:
                        obj = json.loads(raw)
                    except Exception:
                        continue

                    msg = obj.get("message") or obj.get("mavlink") or obj
                    mtype = msg.get("type") or msg.get("msg") or msg.get("name")
                    if not mtype:
                        continue

                    t_boot = msg.get("time_boot_ms")
                    if t_boot is not None:
                        state.setdefault("nav", {})
                        state["nav"]["mission_time_s"] = float(t_boot) / 1000.0

                    if mtype == "ATTITUDE":
                        # ATTITUDE e in radianti
                        roll = msg.get("roll")
                        pitch = msg.get("pitch")
                        yaw = msg.get("yaw")
                        state["att"] = {
                            "roll_deg": float(roll) * RAD2DEG if roll is not None else None,
                            "pitch_deg": float(pitch) * RAD2DEG if pitch is not None else None,
                            "yaw_deg": float(yaw) * RAD2DEG if yaw is not None else None,
                        }
                    elif mtype == "VFR_HUD":
                        hdg = msg.get("heading")
                        alt = msg.get("alt")
                        state.setdefault("nav", {})
                        if hdg is not None:
                            state["nav"]["heading_deg"] = float(hdg)
                        if alt is not None:
                            state["nav"]["alt_m"] = float(alt)
                    elif mtype == "GLOBAL_POSITION_INT":
                        # hdg in centi-deg (0..35999)
                        hdg = msg.get("hdg")
                        lat = msg.get("lat")
                        lon = msg.get("lon")
                        rel_alt = msg.get("relative_alt")
                        if hdg is not None:
                            state.setdefault("nav", {})
                            state["nav"]["heading_deg"] = float(hdg) / 100.0
                        if lat is not None:
                            state.setdefault("nav", {})
                            state["nav"]["lat_deg"] = float(lat) / 1e7
                        if lon is not None:
                            state.setdefault("nav", {})
                            state["nav"]["lon_deg"] = float(lon) / 1e7
                        if rel_alt is not None:
                            state.setdefault("nav", {})
                            state["nav"]["alt_m"] = float(rel_alt) / 1000.0
                    elif mtype == "GPS_RAW_INT":
                        lat = msg.get("lat")
                        lon = msg.get("lon")
                        alt = msg.get("alt")
                        if lat is not None:
                            state.setdefault("nav", {})
                            state["nav"]["lat_deg"] = float(lat) / 1e7
                        if lon is not None:
                            state.setdefault("nav", {})
                            state["nav"]["lon_deg"] = float(lon) / 1e7
                        if alt is not None:
                            state.setdefault("nav", {})
                            state["nav"]["alt_m"] = float(alt) / 1000.0
                    elif mtype == "SERVO_OUTPUT_RAW":
                        outs = [
                            msg.get("servo1_raw"),
                            msg.get("servo2_raw"),
                            msg.get("servo3_raw"),
                            msg.get("servo4_raw"),
                            msg.get("servo5_raw"),
                            msg.get("servo6_raw"),
                        ]

                        state.setdefault("thr", {})
                        for i, pwm in enumerate(outs, start=1):
                            th_key = f"TH{i}"
                            state["thr"].setdefault(th_key, {})

                            if pwm is None:
                                state["thr"][th_key]["PWM"] = None
                                state["thr"][th_key]["CmdPct"] = None
                                continue

                            pwm_i = int(pwm)
                            pct = pwm_to_pct(pwm_i) * INV[i]
                            state["thr"][th_key]["PWM"] = pwm_i
                            state["thr"][th_key]["CmdPct"] = round(pct, 1)

                        now = asyncio.get_running_loop().time()
                        if (now - last_thr_push) >= THR_PUSH_MIN_DT:
                            last_thr_push = now
                            await ws_broadcast({
                                "type": "thr",
                                "thr": {k: state["thr"].get(k, {}) for k in ("TH1", "TH2", "TH3", "TH4", "TH5", "TH6")},
                            })
        except Exception as e:
            print(f"[mavlink] error: {e}")
            await asyncio.sleep(2.0)

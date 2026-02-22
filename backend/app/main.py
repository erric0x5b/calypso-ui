import asyncio
import os
import socket
import json
import re
import io
import zipfile
from datetime import datetime
import csv
import threading

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from fastapi import WebSocket
from fastapi import Body
from fastapi.responses import JSONResponse
from fastapi import HTTPException
from fastapi.responses import StreamingResponse
from fastapi.responses import HTMLResponse
try:
    from pymavlink import mavutil
except ModuleNotFoundError:
    mavutil = None

from backend.app.sonar_ping360 import load_cfg as ping360_load_cfg, save_cfg as ping360_save_cfg, ping360_task
from backend.app import parser
from backend.app import lights_cfg
from backend.app import logging as app_logging

app = FastAPI(title="calypso-ui backend")

BASE_DIR = os.path.dirname(__file__)          # /app/backend/app
STATIC_DIR = os.path.join(BASE_DIR, "static") # /app/backend/app/static

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/ui")
def ui():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))

def now_ms() -> int:
    return int(asyncio.get_running_loop().time() * 1000) & 0xFFFFFFFF

# -------- Sonar Ping360 --------
ping360_stop = asyncio.Event()

@app.on_event("startup")
async def startup():
    # ... tuo UDP server ecc.
    asyncio.create_task(offline_watchdog())
    if MAVLINK_PYMAVLINK_ENABLED:
        asyncio.create_task(mavlink_reader())
    elif MAVLINK_ENABLED:
        print("[mavlink] pymavlink non disponibile: reader disabilitato")

    async def ws_broadcast(payload: dict):
        dead = []
        for c in list(ws_clients):
            try:
                await c.send_json(payload)
            except Exception:
                dead.append(c)
        for c in dead:
            ws_clients.discard(c)
    
    if MAVLINK_WS_ENABLED:
        asyncio.create_task(mavlink_ws_loop())

    asyncio.create_task(ping360_task(state, ws_broadcast, ping360_stop))

# -------- Lights Config --------
LIGHTS_CFG_PATH = lights_cfg.LIGHTS_CFG_PATH
DEFAULT_LIGHTS_CFG = lights_cfg.DEFAULT_LIGHTS_CFG

# -------- Config --------
HTTP_PORT = int(os.getenv("CALYPSO_HTTP_PORT", "8080"))
UDP_RX_PORT = int(os.getenv("CALYPSO_UDP_RX_PORT", "14590"))
LOG_DIR = os.getenv("CALYPSO_LOG_DIR", "/data/deepex_logs")
OFFLINE_MS = int(os.getenv("CALYPSO_OFFLINE_MS", "5000"))
UDP_TX_PORT = int(os.getenv("CALYPSO_UDP_TX_PORT", "14591"))
UDP_TX_HOST = os.getenv("CALYPSO_UDP_TX_HOST", "udp-sim")
MAVLINK_HOST = os.getenv("MAVLINK_HOST", "127.0.0.1")
MAVLINK_PORT = int(os.getenv("MAVLINK_PORT", "14550"))
MAVLINK_CONN = f"udp:{MAVLINK_HOST}:{MAVLINK_PORT}"
MAVLINK_WS_URL = os.getenv("MAVLINK_WS_URL", "")
MAVLINK_ENABLED = os.getenv("MAVLINK_ENABLED", "1").strip().lower() in ("1", "true", "yes", "on")
MAVLINK_PYMAVLINK_ENABLED = MAVLINK_ENABLED and (mavutil is not None)
MAVLINK_WS_ENABLED = MAVLINK_ENABLED and bool(MAVLINK_WS_URL)

PROTO_VER = "2"
os.makedirs(LOG_DIR, exist_ok=True)


# state moved to backend.app.state
from backend.app.state import state, latest, init_state, update_state, next_cmd_id, set_session_paths, new_session_paths, make_sid, append_telemetry_csv

# initialize state (creates initial logging files and metadata)
init_state(LOG_DIR)

ws_clients: set[WebSocket] = set()

def new_session_paths(sid: str):
    t = os.path.join(LOG_DIR, f"telemetry_{sid}.csv")
    a = os.path.join(LOG_DIR, f"alarms_{sid}.csv")
    e = os.path.join(LOG_DIR, f"events_{sid}.jsonl")
    for pth in (t, a, e):
        open(pth, "a", encoding="utf-8").close()
    return t, a, e

# delegate lights config to module
load_lights_cfg = lights_cfg.load_lights_cfg
save_lights_cfg = lights_cfg.save_lights_cfg

def build_nmea_line(fields: list[str]) -> str:
    return parser.build_nmea_line(fields)

def parse_nmea_line(line: str):
    return parser.parse_nmea_line(line)

_cmd_id = 0
# delegate lights config to module
load_lights_cfg = lights_cfg.load_lights_cfg
save_lights_cfg = lights_cfg.save_lights_cfg

# initialize logging module with references
app_logging.init_logging(LOG_DIR, state)
# expose logging functions locally for compatibility
log_start_new_session = app_logging.log_start_new_session
log_stop_session = app_logging.log_stop_session
log_write_telemetry_row = app_logging.log_write_telemetry_row
log_write_alarm = app_logging.log_write_alarm
log_write_event = app_logging.log_write_event
log_is_on = app_logging.log_is_on
log_status_dict = app_logging.log_status_dict
# logging status accessor (delegated to backend.app.logging)
log_status_dict = app_logging.log_status_dict


async def ws_broadcast(obj: dict):
    dead = []
    for ws in ws_clients:
        try:
            await ws.send_json(obj)
        except Exception:
            dead.append(ws)
    for ws in dead:
        ws_clients.discard(ws)

@app.get("/")
def root():
    return HTMLResponse("""
    <h3>calypso-ui backend OK</h3>
    <ul>
      <li><a href="/ui">UI</a></li>
      <li><a href="/api/health">API health</a></li>
      <li><a href="/api/state">API state</a></li>
      <li>WebSocket: <code>/ws</code></li>
    </ul>
    """)

@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    ws_clients.add(ws)
    try:
        if latest.get("last_line"):
            await ws.send_json({"type": "last", "raw": latest["last_line"]})

        while True:
            # non bloccare: se il client manda qualcosa lo consumiamo
            try:
                await ws.receive_text()
            except Exception:
                # molti client non inviano nulla: teniamo vivo con sleep
                await asyncio.sleep(30)

    finally:
        ws_clients.discard(ws)
        
class UDPServerProtocol(asyncio.DatagramProtocol):
    def __init__(self):
        self.transport = None

    def connection_made(self, transport):
        self.transport = transport
        sock = transport.get_extra_info("socket")
        if sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 1_048_576)

    def datagram_received(self, data, addr):
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

        # Broadcast WS in background (non bloccare il thread protocol)
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
        # usa now_ms() come riferimento se ts_ms non arriva
        # ma qui ragioniamo su ts_ms (ms da boot) dei nodi:
        for node, info in state["nodes"].items():
            last_hb = info.get("last_hb_ms")
            if last_hb is None:
                continue
            # confronto modulo uint32: ok finché missioni << 49 giorni
            dt = (state["last_update_ms"] - last_hb) & 0xFFFFFFFF if state["last_update_ms"] is not None else 0
            if dt > OFFLINE_MS and info.get("online"):
                info["online"] = False
                # genera allarme interno
                alarm = {"ts_ms": state["last_update_ms"], "src": "SFC", "id": 9001, "sev": 3, "active": 1, "latched": 0, "text": f"NODE_OFFLINE:{node}"}
                state["alarms_history"].append(alarm)
                state["alarms_active"].append(alarm)
                await ws_broadcast({"type": "alarm", "alarm": alarm})

@app.on_event("startup")
async def startup():
    loop = asyncio.get_running_loop()
    transport, protocol = await loop.create_datagram_endpoint(
        lambda: UDPServerProtocol(),
        local_addr=("0.0.0.0", UDP_RX_PORT),
    )
    asyncio.create_task(offline_watchdog())
    
@app.get("/api/state")
def api_state():
    return state

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
async def cmd_lights_channel(body: dict):
    ch = int(body.get("ch", 1))
    mode = str(body.get("mode", "ON")).upper()
    dim = int(body.get("dim", 0))

    if ch not in (1, 2, 3, 4):
        return {"ok": False, "err": "bad ch"}
    if mode not in ("ON", "OFF", "TEST"):
        return {"ok": False, "err": "bad mode"}
    dim = max(0, min(1000, dim))

    cfg = load_lights_cfg()  # funzione che ti ho dato prima
    lamp_ids = cfg["channels"][str(ch)].get("lamp_ids", [])
    lamp_ids_str = "|".join(str(x) for x in lamp_ids)

    cmd_id = next_cmd_id()
    ts = int(state["last_update_ms"] or 0)

    fields = [
        "SFC", "ROV", "CMD", "2",             # dst “logico” (puoi tenerlo "ROV" fisso)
        str(cmd_id), str(ts),
        "CmdId", str(cmd_id),
        "Type", "LIGHTS_CH",
        "Ch", str(ch),
        "Mode", mode,
        "Dim", str(dim),
        "LampIds", lamp_ids_str
    ]
    line = build_nmea_line(fields)
    udp_tx_sock.sendto(line.encode("ascii"), (UDP_TX_HOST, UDP_TX_PORT))

    return {"ok": True, "cmd_id": cmd_id, "lamp_ids": lamp_ids}


@app.post("/api/config/lights")
def api_set_lights_cfg(cfg: dict = Body(...)):
    if "channels" not in cfg or not isinstance(cfg["channels"], dict):
        return JSONResponse({"ok": False, "err": "channels missing"}, status_code=400)

    out = {"version": int(cfg.get("version", 1)), "channels": {}}
    for k in ("1","2","3","4"):
        ch = cfg["channels"].get(k, {})
        if not isinstance(ch, dict):
            return JSONResponse({"ok": False, "err": f"channels.{k} invalid"}, status_code=400)

        name = str(ch.get("name", f"CH{k}"))
        lamp_ids = ch.get("lamp_ids", [])
        if not isinstance(lamp_ids, list):
            return JSONResponse({"ok": False, "err": f"channels.{k}.lamp_ids invalid"}, status_code=400)

        # ints only, >=1, unique
        cleaned = []
        for x in lamp_ids:
            if isinstance(x, int) and x >= 1:
                cleaned.append(x)
        out["channels"][k] = {"name": name, "lamp_ids": sorted(set(cleaned))}

    save_lights_cfg(out)
    return {"ok": True}

SESSION_RE = re.compile(r"^(telemetry|alarms|events)_(\d{8}_\d{6})\.(csv|jsonl)$")

def list_sessions(log_dir: str):
    sessions = {}  # sid -> {"telemetry":..., "alarms":..., "events":...}
    try:
        for name in os.listdir(log_dir):
            m = SESSION_RE.match(name)
            if not m:
                continue
            kind, sid, ext = m.group(1), m.group(2), m.group(3)
            sessions.setdefault(sid, {})
            sessions[sid][kind] = os.path.join(log_dir, name)
    except FileNotFoundError:
        return {}

    # ordina per sid desc (timestamp)
    return dict(sorted(sessions.items(), key=lambda kv: kv[0], reverse=True))

@app.get("/api/log/sessions")
def api_log_sessions():
    sessions = list_sessions(LOG_DIR)
    # ritorna solo nomi file (non path)
    out = []
    for sid, files in sessions.items():
        out.append({
            "sid": sid,
            "telemetry": os.path.basename(files.get("telemetry","")) if "telemetry" in files else None,
            "alarms": os.path.basename(files.get("alarms","")) if "alarms" in files else None,
            "events": os.path.basename(files.get("events","")) if "events" in files else None,
        })
    return {"sessions": out}

@app.get("/api/log/zip")
def api_log_zip(sid: str):
    # sanitize sid: solo YYYYMMDD_HHMMSS
    if not re.fullmatch(r"\d{8}_\d{6}", sid):
        raise HTTPException(status_code=400, detail="bad sid")

    sessions = list_sessions(LOG_DIR)
    if sid not in sessions:
        raise HTTPException(status_code=404, detail="session not found")

    files = sessions[sid]
    # crea zip in memoria (ok per demo). Se i file diventano grossi, lo streamiamo su temp file.
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as z:
        for kind in ("telemetry", "alarms", "events"):
            p = files.get(kind)
            if p and os.path.isfile(p):
                z.write(p, arcname=os.path.basename(p))
        # opzionale: metti anche un manifest.json
        manifest = {
            "sid": sid,
            "created_utc": datetime.utcnow().isoformat() + "Z",
            "files": {k: os.path.basename(v) for k, v in files.items()}
        }
        z.writestr(f"manifest_{sid}.json", json.dumps(manifest, indent=2))

    buf.seek(0)
    filename = f"deepex_logs_{sid}.zip"
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'}
    )

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
    if not log_is_on():
        return JSONResponse({"ok": False, "err": "logging disabled"}, status_code=400)

    typ = str(payload.get("type", "NOTE")).upper()
    text = str(payload.get("text", "")).strip()
    if not text:
        return JSONResponse({"ok": False, "err": "text empty"}, status_code=400)

    # arricchimento best-effort (se in futuro metti state.att con heading/depth ecc)
    att = state.get("att") or {}
    evt = {
        "ts_ms": int(state.get("last_update_ms") or 0),
        "mission_time": att.get("mission_time"),
        "depth": att.get("depth_m"),
        "heading": att.get("heading_deg"),
        "src": "SFC",
        "type": typ,
        "text": text,
    }
    log_write_event(evt)
    return {"ok": True}

@app.get("/api/config/lights")
def api_get_lights_cfg():
    return load_lights_cfg()

@app.get("/api/sonar/ping360/config")
def get_ping360_cfg():
    return ping360_load_cfg()

@app.post("/api/sonar/ping360/config")
def set_ping360_cfg(cfg: dict = Body(...)):
    ping360_save_cfg(cfg)
    return {"ok": True}

def session_id_utc() -> str:
    # YYYYMMDD_HHMMSS
    return datetime.utcnow().strftime("%Y%m%d_%H%M%S")
# logging functions are provided by backend.app.logging (app_logging)
        
async def mavlink_reader():
    # pymavlink è blocking: lo mettiamo in thread
    def _run():
        m = mavutil.mavlink_connection(MAVLINK_CONN, autoreconnect=True, source_system=255)
        # opzionale: aspetta heartbeat per sysid/compid
        # m.wait_heartbeat(timeout=10)

        while True:
            msg = m.recv_match(blocking=True, timeout=1)
            if msg is None:
                continue

            t = now_ms()
            state["mav"]["last_ms"] = t
            state["mav"]["msgs"] += 1

            mt = msg.get_type()

            # ATTITUDE: roll/pitch/yaw in radianti
            if mt == "ATTITUDE":
                state["att"]["roll_deg"]  = msg.roll  * 57.295779513
                state["att"]["pitch_deg"] = msg.pitch * 57.295779513
                state["att"]["yaw_deg"]   = msg.yaw   * 57.295779513

            # VFR_HUD: heading in gradi, alt in m
            elif mt == "VFR_HUD":
                state["nav"]["heading_deg"] = getattr(msg, "heading", None)
                state["nav"]["alt_m"] = getattr(msg, "alt", None)

            # SCALED_PRESSURE2 / NAMED_VALUE_FLOAT / AHRS2 ecc: depth dipende da setup
            # Per BlueROV spesso la profondità arriva su VFR_HUD.alt o su messaggi custom.
            # Per ora lasciamo slot generico:
            elif mt == "GLOBAL_POSITION_INT":
                # msg.relative_alt è in mm, non depth. utile per altitudine relativa.
                pass

    await asyncio.to_thread(_run)
    
async def mavlink_ws_loop():
    # pip install websockets
    import json
    import asyncio
    import websockets

    while True:
        try:
            print(f"[mavlink] connecting to {MAVLINK_WS_URL}")
            async with websockets.connect(
                MAVLINK_WS_URL,
                ping_interval=20,
                ping_timeout=20,
                close_timeout=5,
                max_size=2_000_000,
            ) as ws:
                print("[mavlink] connected")

                async for raw in ws:
                    try:
                        obj = json.loads(raw)
                    except Exception:
                        continue

                    msg = (obj.get("message") or {})
                    mtype = msg.get("type")

                    # ---- AHRS2: roll/pitch/yaw + altitude (depth) ----
                    if mtype == "AHRS2":
                        # in mavlink2rest spesso sono già in gradi (come nel tuo screenshot: 0.0)
                        roll = msg.get("roll")
                        pitch = msg.get("pitch")
                        yaw = msg.get("yaw")
                        alt = msg.get("altitude")  # nel tuo caso: negativo = profondità

                        # state.att per UI 3D
                        state["att"] = {
                            "roll_deg": float(roll) if roll is not None else None,
                            "pitch_deg": float(pitch) if pitch is not None else None,
                            "yaw_deg": float(yaw) if yaw is not None else None,
                        }

                        # depth: se altitude è negativa, depth = -altitude (m)
                        if alt is not None:
                            altf = float(alt)
                            depth_m = (-altf) if altf < 0 else altf
                            state["nav"] = state.get("nav", {})
                            state["nav"]["depth_m"] = depth_m

                        # opzionale: notifica UI senza fare fetch /api/state (se già usi "update")
                        asyncio.create_task(ws_broadcast({"type": "update", "src": "MAV", "msg": mtype}))

                    # ---- opzionale: altri tipi (ATTITUDE, VFR_HUD, etc) ----
                    # elif mtype == "ATTITUDE":
                    #     ...
        except Exception as e:
            print(f"[mavlink] error: {e}")
            await asyncio.sleep(2.0)

@app.get("/register_service")
def register_service():
    return {
        "name": "Calypso UI",
        "description": "DeepEx ROV UI",
        "icon": "mdi-submarine",
        "company": "DeepEx",
        "version": "0.4.0",

        # BlueOS UI behavior
        "new_page": False,
        "avoid_iframes": False,            # metti True se la tua UI blocca iframe / ha CSP rigide
        "works_in_relative_paths": True,   # consigliato con proxy / accesso remoto

        # IMPORTANT: questi devono essere path locali del servizio
        "webpage": "/ui",                    # oppure "/ui" se hai un mount dedicato
        "api": "/docs"                     # FastAPI swagger
    }
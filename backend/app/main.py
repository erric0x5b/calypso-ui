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
from pymavlink import mavutil

from backend.app.sonar_ping360 import load_cfg as ping360_load_cfg, save_cfg as ping360_save_cfg, ping360_task

app = FastAPI(title="calypso-ui backend")

BASE_DIR = os.path.dirname(__file__)          # /app/backend/app
STATIC_DIR = os.path.join(BASE_DIR, "static") # /app/backend/app/static

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

LOG_LOCK = threading.Lock()

# stato logging runtime
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
    asyncio.create_task(mavlink_reader())

    async def ws_broadcast(payload: dict):
        dead = []
        for c in list(ws_clients):
            try:
                await c.send_json(payload)
            except Exception:
                dead.append(c)
        for c in dead:
            ws_clients.discard(c)
    
    if MAVLINK_ENABLED:
        asyncio.create_task(mavlink_ws_loop())

    asyncio.create_task(ping360_task(state, ws_broadcast, ping360_stop))

# -------- Lights Config --------
LIGHTS_CFG_PATH = os.getenv("CALYPSO_LIGHTS_CFG", "/data/deepex_logs/lights_config.json")
DEFAULT_LIGHTS_CFG = {
    "version": 1,
    "channels": {
        "1": {"name": "CH1", "lamp_ids": []},
        "2": {"name": "CH2", "lamp_ids": []},
        "3": {"name": "CH3", "lamp_ids": []},
        "4": {"name": "CH4", "lamp_ids": []},
    }
}

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

PROTO_VER = "2"
os.makedirs(LOG_DIR, exist_ok=True)

telemetry_path = os.path.join(LOG_DIR, f"telemetry_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv")
alarms_path = os.path.join(LOG_DIR, f"alarms_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv")
events_path = os.path.join(LOG_DIR, f"events_{datetime.now().strftime('%Y%m%d_%H%M%S')}.jsonl")

for pth in (telemetry_path, alarms_path, events_path):
    open(pth, "a", encoding="utf-8").close()
    
def make_sid() -> str:
    return datetime.now().strftime("%Y%m%d_%H%M%S")

def set_session_paths(sid: str):
    global telemetry_path, alarms_path, events_path
    telemetry_path = os.path.join(LOG_DIR, f"telemetry_{sid}.csv")
    alarms_path    = os.path.join(LOG_DIR, f"alarms_{sid}.csv")
    events_path    = os.path.join(LOG_DIR, f"events_{sid}.jsonl")
    for pth in (telemetry_path, alarms_path, events_path):
        os.makedirs(os.path.dirname(pth), exist_ok=True)
        open(pth, "a", encoding="utf-8").close()

    
udp_tx_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

# -------- State (very simple for now) --------
latest = {"last_line": None}

state = {
    "proto": {"ver": 2},
    "nodes": {},   # per node online/offline + last_hb
    "pods": {"BAT1": {}, "BAT2": {}},
    "esc": {},     # esc_id -> data
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

state["logging"] = {
    "enabled": True,                 # di default ON (come ora)
    "sid": datetime.now().strftime("%Y%m%d_%H%M%S"),
    "telemetry_path": telemetry_path,
    "alarms_path": alarms_path,
    "events_path": events_path,
}

state.setdefault("logging", {"enabled": False, "sid": None})

state.setdefault("att", {"roll_deg": None, "pitch_deg": None, "yaw_deg": None})
state.setdefault("nav", {"depth_m": None, "heading_deg": None, "alt_m": None})
state.setdefault("mav", {"last_ms": 0, "msgs": 0, "drops": 0})

ws_clients: set[WebSocket] = set()

def new_session_paths(sid: str):
    t = os.path.join(LOG_DIR, f"telemetry_{sid}.csv")
    a = os.path.join(LOG_DIR, f"alarms_{sid}.csv")
    e = os.path.join(LOG_DIR, f"events_{sid}.jsonl")
    for pth in (t, a, e):
        open(pth, "a", encoding="utf-8").close()
    return t, a, e

def save_lights_cfg(cfg: dict):
    os.makedirs(os.path.dirname(LIGHTS_CFG_PATH), exist_ok=True)
    with open(LIGHTS_CFG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)

def load_lights_cfg() -> dict:
    try:
        with open(LIGHTS_CFG_PATH, "r", encoding="utf-8") as f:
            cfg = json.load(f)
    except Exception:
        save_lights_cfg(DEFAULT_LIGHTS_CFG)
        return DEFAULT_LIGHTS_CFG

    # normalize/merge
    if "channels" not in cfg or not isinstance(cfg["channels"], dict):
        cfg["channels"] = {}

    for k in ("1","2","3","4"):
        ch = cfg["channels"].get(k)
        if not isinstance(ch, dict):
            ch = {"name": f"CH{k}", "lamp_ids": []}
            cfg["channels"][k] = ch
        ch.setdefault("name", f"CH{k}")
        ch.setdefault("lamp_ids", [])
        # sanitize lamp_ids
        lamp_ids = ch.get("lamp_ids", [])
        if not isinstance(lamp_ids, list):
            lamp_ids = []
        lamp_ids = [int(x) for x in lamp_ids if isinstance(x, int) or (isinstance(x, str) and x.isdigit())]
        lamp_ids = sorted(set([x for x in lamp_ids if x >= 1]))
        ch["lamp_ids"] = lamp_ids

    cfg["version"] = int(cfg.get("version", 1))
    return cfg

def build_nmea_line(fields: list[str]) -> str:
    payload = ",".join(fields)
    cs = nmea_xor_checksum(payload)
    return f"${payload}*{cs}\r\n"

_cmd_id = 0
def next_cmd_id() -> int:
    global _cmd_id
    _cmd_id = (_cmd_id + 1) & 0xFFFFFFFF
    return _cmd_id

def nmea_xor_checksum(payload: str) -> str:
    # XOR of all chars in payload (already excludes '$' and '*')
    c = 0
    for ch in payload:
        c ^= ord(ch)
    return f"{c:02X}"
    
def kv_payload_to_dict(rest: list[str]) -> dict:
    # rest = [k1,v1,k2,v2,...]
    out = {}
    n = len(rest)
    for i in range(0, n - 1, 2):
        k = rest[i].strip()
        v = rest[i + 1].strip()
        if not k:
            continue
        # prova cast int, altrimenti lascia stringa
        try:
            if v.lower().startswith("0x"):
                out[k] = int(v, 16)
            else:
                out[k] = int(v)
        except Exception:
            out[k] = v
    return out
    
def ensure_node(node: str):
    if node not in state["nodes"]:
        state["nodes"][node] = {
            "online": False,
            "last_hb_ms": None,
            "last_seen_ms": None,
        }

def update_state(parsed: dict):
    msg = parsed["msg"]
    src = parsed["src"]
    ts = parsed["ts_ms"]
    kv = kv_payload_to_dict(parsed["rest"])

    state["counters"]["parse_ok"] += 1
    state["last_update_ms"] = ts

    # Qualsiasi pacchetto ricevuto: last_seen
    ensure_node(src)
    state["nodes"][src]["last_seen_ms"] = ts

    if msg == "HB":
        state["nodes"][src]["online"] = True
        state["nodes"][src]["last_hb_ms"] = ts
        # opzionale: salva anche kv HB
        state["nodes"][src].update({"hb": kv})
        return

    if msg == "ENV" and src in state["pods"]:
        state["pods"][src].update(kv)
        return

    if msg == "PWR" and src in state["pods"]:
        state["pods"][src].update(kv)
        return

    if msg == "DIG" and src in state["pods"]:
        # fault info
        state["pods"][src].update(kv)
        return

    if msg == "ESC":
        # deve avere VescId
        esc_id = kv.get("VescId")
        if esc_id is None:
            return
        esc_id = int(esc_id)
        if esc_id not in state["esc"]:
            state["esc"][esc_id] = {}
        # oltre ai kv, mettiamo anche source e timestamp
        state["esc"][esc_id].update(kv)
        state["esc"][esc_id]["src"] = src
        state["esc"][esc_id]["ts_ms"] = ts
        return

    if msg == "ALM":
        # formato minimo: Id, Sev, Active, Latched, Text/TextB64
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
        # aggiorna active list
        if alarm["active"]:
            state["alarms_active"] = [a for a in state["alarms_active"] if not (a.get("id") == alarm["id"] and a.get("src") == src)]
            state["alarms_active"].append(alarm)
        else:
            state["alarms_active"] = [a for a in state["alarms_active"] if not (a.get("id") == alarm["id"] and a.get("src") == src)]
        return

def parse_nmea_line(line: str):
    # Expected: $...*CS\r\n
    line = line.strip()
    if not line.startswith("$") or "*" not in line:
        return None, "format"
    payload, cs = line[1:].split("*", 1)
    cs = cs[:2].upper()
    exp = nmea_xor_checksum(payload)
    if cs != exp:
        return None, "checksum"
    parts = payload.split(",")
    if len(parts) < 6:
        return None, "fields"
    src, dst, msg, ver, seq, ts_ms, *rest = parts
    return {
        "src": src,
        "dst": dst,
        "msg": msg,
        "ver": ver,
        "seq": int(seq),
        "ts_ms": int(ts_ms),
        "raw": line,
        "rest": rest,
    }, None

def append_telemetry_csv(p):
    if not state.get("logging", {}).get("enabled"):
        return
    raw_escaped = p["raw"].replace('"', '""')
    with open(telemetry_path, "a", encoding="utf-8") as f:
        f.write(f'{p["ts_ms"]},{p["src"]},{p["msg"]},"{raw_escaped}"\n')


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

def _ensure_log_dir():
    os.makedirs(LOG_DIR, exist_ok=True)

def log_is_on() -> bool:
    return bool(state.get("logging", {}).get("enabled"))

def log_status_dict():
    lg = state.get("logging") or {"enabled": False, "sid": None}
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

        telemetry_path = os.path.join(LOG_DIR, f"telemetry_{sid}.csv")
        alarms_path    = os.path.join(LOG_DIR, f"alarms_{sid}.csv")
        events_path    = os.path.join(LOG_DIR, f"events_{sid}.jsonl")

        tf = open(telemetry_path, "w", newline="", encoding="utf-8")
        af = open(alarms_path, "w", newline="", encoding="utf-8")
        ef = open(events_path, "a", encoding="utf-8")

        tcsv = csv.writer(tf)
        acsv = csv.writer(af)

        # header telemetria (minimo, poi estendiamo)
        tcsv.writerow(["ts_ms", "src", "dst", "msg", "ver", "seq", "raw"])
        tf.flush()

        # header allarmi
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

        state["logging"] = {
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

        state["logging"] = {"enabled": False, "sid": None}
        return sid

def log_write_telemetry_row(ts_ms: int, parsed: dict, raw_line: str):
    with LOG_LOCK:
        if not log_ctx["enabled"] or not log_ctx["telemetry_csv"]:
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
        if not log_ctx["enabled"] or not log_ctx["alarms_csv"]:
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
        if not log_ctx["enabled"] or not log_ctx["events_f"]:
            return
        log_ctx["events_f"].write(json.dumps(evt, ensure_ascii=False) + "\n")
        log_ctx["events_f"].flush()
        
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
import asyncio
import os
import socket
from datetime import datetime

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from fastapi import FastAPI, WebSocket
from fastapi.responses import HTMLResponse

import json
from fastapi import Body
from fastapi.responses import JSONResponse

import re
import io
import zipfile
from fastapi import HTTPException
from fastapi.responses import StreamingResponse


app = FastAPI(title="calypso-ui backend")

BASE_DIR = os.path.dirname(__file__)          # /app/backend/app
STATIC_DIR = os.path.join(BASE_DIR, "static") # /app/backend/app/static

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

@app.get("/ui")
def ui():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))

def now_ms() -> int:
    return int(asyncio.get_running_loop().time() * 1000) & 0xFFFFFFFF

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

PROTO_VER = "2"
os.makedirs(LOG_DIR, exist_ok=True)

telemetry_path = os.path.join(LOG_DIR, f"telemetry_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv")
alarms_path = os.path.join(LOG_DIR, f"alarms_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv")
events_path = os.path.join(LOG_DIR, f"events_{datetime.now().strftime('%Y%m%d_%H%M%S')}.jsonl")

for pth in (telemetry_path, alarms_path, events_path):
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
    log = state.get("logging", {})
    if not log.get("enabled", True):
        return
    path = log.get("telemetry_path", telemetry_path)
    raw_escaped = p["raw"].replace('"', '""')
    with open(path, "a", encoding="utf-8") as f:
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
        # Send last known line on connect
        if latest["last_line"]:
            await ws.send_json({"type": "last", "raw": latest["last_line"]})
        while True:
            await asyncio.sleep(30)

    except Exception:
        pass
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


@app.get("/api/config/lights")
def api_get_lights_cfg():
    return load_lights_cfg()

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

@app.post("/api/cmd/lights_channel")
def api_cmd_lights_channel(payload: dict = Body(...)):
    # payload: {ch:1..4, mode:"ON"/"OFF"/"TEST", dim:int}
    ch = int(payload.get("ch", 0))
    mode = str(payload.get("mode", "ON")).upper()
    dim = int(payload.get("dim", 0))

    if ch not in (1,2,3,4):
        return JSONResponse({"ok": False, "err": "bad ch"}, status_code=400)
    if mode not in ("ON","OFF","TEST"):
        return JSONResponse({"ok": False, "err": "bad mode"}, status_code=400)
    if dim < 0 or dim > 1000:
        return JSONResponse({"ok": False, "err": "bad dim"}, status_code=400)

    cfg = load_lights_cfg()
    lamp_ids = cfg["channels"][str(ch)].get("lamp_ids", [])
    # lista ids codificata semplice: "1|2|5"
    lamp_ids_str = "|".join(str(x) for x in lamp_ids)

    # TODO: qui chiami la tua funzione send_cmd_udp(...) che già usi per CMD/ACK
    # Esempio payload K/V:
    # Type,LIGHTS,Ch,1,Mode,ON,Dim,700,LampIds,1|2|5
    cmd_kv = {
        "Type": "LIGHTS",
        "Ch": ch,
        "Mode": mode,
        "Dim": dim,
        "LampIds": lamp_ids_str
    }

    # placeholder: genera cmd_id come già fai altrove
    cmd_id = int(datetime.now().timestamp() * 1000) & 0xFFFFFFFF

    # send_cmd_udp(dst="ROV"/"SFC"?): dipende dal tuo schema; qui metto placeholder
    # send_cmd_udp(cmd_id=cmd_id, kv=cmd_kv)

    return {"ok": True, "cmd_id": cmd_id, "lamp_ids": lamp_ids}

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
        z.writestr(f"manifest_{sid}.json", str(manifest).replace("'", '"'))

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

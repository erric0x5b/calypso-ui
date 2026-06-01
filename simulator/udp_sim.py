import os
import socket
import time
import threading
import json
import math

CMD_LISTEN_PORT = int(os.getenv("SIM_CMD_LISTEN_PORT", "14591"))
SIM_TARGET_HOST = (os.getenv("SIM_TARGET_HOST", "calypso-ui-backend") or "calypso-ui-backend").strip()
SIM_TARGET_PORT = int(os.getenv("SIM_TARGET_PORT", "14590"))
SIM_CONTROLLER_TARGET_PORT = int(os.getenv("SIM_CONTROLLER_TARGET_PORT", "5010"))
ENV_HZ = float(os.getenv("SIM_RATE_ENV_HZ", "10"))
ESC_HZ = float(os.getenv("SIM_RATE_ESC_HZ", "10"))
HB_HZ  = float(os.getenv("SIM_RATE_HB_HZ", "1"))
ALM_HZ = float(os.getenv("SIM_RATE_ALM_HZ", "2"))
CONTROLLER_HZ = float(os.getenv("SIM_RATE_CONTROLLER_HZ", "25"))

sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

def send_json(obj: dict, port: int):
    data = json.dumps(obj, separators=(",", ":")).encode("utf-8")
    while True:
        try:
            sock.sendto(data, (SIM_TARGET_HOST, port))
            return
        except socket.gaierror:
            time.sleep(0.2)
        except Exception:
            time.sleep(0.2)

def send_line(payload: str):
    line = f"${payload}*{cks(payload)}\r\n"
    while True:
        try:
            sock.sendto(line.encode("ascii"), (SIM_TARGET_HOST, SIM_TARGET_PORT))
            return
        except socket.gaierror:
            # DNS non pronto: aspetta e riprova senza far crashare il container
            time.sleep(0.2)
        except Exception:
            # qualsiasi altro errore: non killare il sim
            time.sleep(0.2)

    #raise RuntimeError(f"Cannot resolve/send to SIM_TARGET_HOST={SIM_TARGET_HOST!r}:{SIM_TARGET_PORT} err={last_err}")

def cks(payload: str) -> str:
    c = 0
    for ch in payload:
        c ^= ord(ch)
    return f"{c:02X}"

seq_env = 0
seq_esc = 0
seq_hb = 0
seq_alm = 0
t0 = time.time()
PWR_HZ = 5.0
next_pwr = time.time()
next_alm = time.time()
seq_pwr = 0
vmot_lock = threading.Lock()
vmot_on = [1, 1, 0, 1, 0, 0]  # VMOT1..VMOT6
strobe_on = 0
alarm_active = {}

def ts_ms():
    return int((time.time() - t0) * 1000) & 0xFFFFFFFF

next_env = time.time()
next_esc = time.time()
next_hb  = time.time()
next_controller = time.time()
seq_controller = 0

ALARM_SCENES = [
    {"src": "BAT1", "id": 300, "sev": 2, "latched": 0, "text": "ALM_VBUS_LOW: VBUS 47.8V"},
    {"src": "BAT2", "id": 210, "sev": 3, "latched": 1, "text": "ALM_OVERTEMP: PCB 71.4C"},
    {"src": "BAT2", "id": 200, "sev": 4, "latched": 1, "text": "ALM_LEAK: water ingress sensor active"},
    {"src": "BAT1", "id": 320, "sev": 4, "latched": 1, "text": "ALM_PWR_FAULT: VMOT driver fault precheck"},
]

def send_alarm(src: str, alarm_id: int, sev: int, active: int, latched: int, text: str):
    global seq_alm
    seq_alm = (seq_alm + 1) & 0xFFFFFFFF
    payload = (
        f"{src},SFC,ALM,2,{seq_alm},{ts_ms()},"
        f"Id,{alarm_id},Sev,{sev},Active,{active},Latched,{latched},Text,{text}"
    )
    send_line(payload)

def desired_alarm_state(elapsed_s: float):
    cycle = int(elapsed_s) % 60
    if cycle < 12:
        return None
    if cycle < 24:
        return ALARM_SCENES[0]
    if cycle < 36:
        return ALARM_SCENES[1]
    if cycle < 48:
        return ALARM_SCENES[2]
    return ALARM_SCENES[3]

def update_alarm_stream():
    desired = desired_alarm_state(time.time() - t0)
    desired_key = None
    if desired:
        desired_key = (desired["src"], desired["id"])

    for key, cfg in list(alarm_active.items()):
        if key == desired_key:
            continue
        send_alarm(
            cfg["src"],
            cfg["id"],
            cfg["sev"],
            0,
            cfg["latched"],
            cfg["text"],
        )
        del alarm_active[key]

    if desired_key and desired_key not in alarm_active:
        alarm_active[desired_key] = desired
        send_alarm(
            desired["src"],
            desired["id"],
            desired["sev"],
            1,
            desired["latched"],
            desired["text"],
        )

def parse_line(line: str):
    line = line.strip()
    if not line.startswith("$") or "*" not in line:
        return None
    payload, cs = line[1:].split("*", 1)
    cs = cs[:2].upper()
    if cks(payload) != cs:
        return None
    return payload.split(",")

def cmd_listener():
    global strobe_on
    rx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    rx.bind(("0.0.0.0", CMD_LISTEN_PORT))
    while True:
        data, addr = rx.recvfrom(4096)
        try:
            line = data.decode("ascii", errors="ignore")
        except Exception:
            continue

        parts = parse_line(line)
        if not parts or len(parts) < 6:
            continue

        src, dst, msg, ver, seq, ts_ms, *rest = parts
        if msg != "CMD":
            continue

        kv = {}
        for i in range(0, len(rest) - 1, 2):
            kv[rest[i]] = rest[i + 1]

        cmd_id = kv.get("CmdId", "0")
        cmd_type = str(kv.get("Type", "")).upper()
        ok = 1
        text = ""

        if cmd_type in ("VMOT", "VMOT_MASTER"):
            tok = str(kv.get("On", kv.get("Enable", kv.get("Val", "0")))).strip().lower()
            enable = 1 if tok in ("1", "true", "on", "enable", "enabled") else 0
            with vmot_lock:
                for i in range(6):
                    vmot_on[i] = enable
            text = f"VMOT_{'ON' if enable else 'OFF'}"
        elif cmd_type == "STROBO":
            tok = str(kv.get("On", kv.get("Enable", kv.get("Val", "0")))).strip().lower()
            strobe_on = 1 if tok in ("1", "true", "on", "enable", "enabled") else 0
            text = f"STROBO_{'ON' if strobe_on else 'OFF'}"

        ack = f"{dst},{src},ACK,2,{seq},{ts_ms},CmdId,{cmd_id},Ok,{ok}"
        if text:
            ack += f",Text,{text}"
        send_line(ack)

# start command listener thread (MUST be after def cmd_listener)
threading.Thread(target=cmd_listener, daemon=True).start()

while True:
    now = time.time()

    if now >= next_hb:
        seq_hb = (seq_hb + 1) & 0xFFFFFFFF
        payload = f"BAT1,SFC,HB,2,{seq_hb},{ts_ms()},Up,1,NodeState,1,RxErr,0,TxErr,0"
        send_line(payload)
        payload = f"BAT2,SFC,HB,2,{seq_hb},{ts_ms()},Up,1,NodeState,1,RxErr,0,TxErr,0"
        send_line(payload)
        next_hb = now + (1.0 / HB_HZ)

    if now >= next_env:
        seq_env = (seq_env + 1) & 0xFFFFFFFF
        # bozza con int scalati (mV, mA, dC)
        payload = f"BAT1,SFC,ENV,2,{seq_env},{ts_ms()},Vbatt_mv,50210,Vmot_mv,49700,V48_mv,48500,Ibatt_ma,10500,Temp_dC,253,BusConn,1,LeakIn,0,VbusOn,1"
        send_line(payload)
        payload = f"BAT2,SFC,ENV,2,{seq_env},{ts_ms()},Vbatt_mv,50180,Vmot_mv,49650,V48_mv,48480,Ibatt_ma,9800,Temp_dC,249,BusConn,0,LeakIn,1,VbusOn,1"
        send_line(payload)
        next_env = now + (1.0 / ENV_HZ)

    if now >= next_esc:
        seq_esc = (seq_esc + 1) & 0xFFFFFFFF
        for esc_id in range(1, 7):
            payload = f"BAT1,SFC,ESC,2,{seq_esc},{ts_ms()},VescId,{esc_id},InVoltage_mv,50000,AvgInCur_ma,1200,Wh_x10,153,RPM,1800"
            send_line(payload)
        next_esc = now + (1.0 / ESC_HZ)

    if now >= next_alm:
        update_alarm_stream()
        next_alm = now + (1.0 / ALM_HZ)

    if now >= next_controller:
        seq_controller = (seq_controller + 1) & 0xFFFFFFFF
        t = time.time() - t0
        lx = int(math.sin(t * 0.9) * 550)
        ly = int(math.cos(t * 0.5) * 420)
        rx = int(math.sin(t * 0.35) * 300)
        ry = int(math.cos(t * 0.7) * 650)
        b2 = (int(t) % 8) == 3
        controller = {
            "seq": seq_controller,
            "ts_ms": ts_ms(),
            "controller_online": True,
            "active_link": "usb",
            "usb_available": True,
            "bt_available": True,
            "source_quality": 100,
            "profile": "pilot_default",
            "mode": "pilot",
            "raw": {
                "lx": lx,
                "ly": ly,
                "rx": rx,
                "ry": ry,
                "lt": 0,
                "rt": 0,
            },
            "buttons": {
                "b1": False,
                "b2": b2,
                "b3": False,
                "b4": False,
                "b5": False,
                "b6": False,
            },
            "switches": {
                "sw1": 1,
                "sw2": 0,
            },
            "mapped": {
                "surge": round(ly / 1000.0, 2),
                "sway": round(rx / 1000.0, 2),
                "heave": round(ry / 1000.0, 2),
                "yaw": round(lx / 1000.0, 2),
                "lights_up": False,
                "lights_down": b2,
                "camera_rec": False,
            },
            "events": [{"type": "button_down", "id": "b2"}] if b2 else [],
            "health": {
                "link_stale": False,
                "vjoy_ok": True,
                "safe_output": False,
            },
        }
        send_json(controller, SIM_CONTROLLER_TARGET_PORT)
        next_controller = now + (1.0 / CONTROLLER_HZ)

    time.sleep(0.001)

    if now >= next_pwr:
        seq_pwr = (seq_pwr + 1) & 0xFFFFFFFF
        dv_thr = 200
        dv = 45
        with vmot_lock:
            v1, v2, v3, v4, v5, v6 = vmot_on

        vmot_reason = 2 if (int(time.time() - t0) % 60) >= 48 else 0
        ina_fault = 1 if vmot_reason else 0
        send_line(f"BAT1,SFC,PWR,2,{seq_pwr},{ts_ms()},BusConn,1,SwVbusCmd,1,VbusOn,1,Vbus_mv,49800,ParState,5,dV_thr_mv,{dv_thr},dV_mv,{dv},Reason,0,VmotReason,{vmot_reason},InaFault,{ina_fault},Vmot1On,{v1},Vmot2On,{v2},Vmot3On,{v3}")
        send_line(f"BAT2,SFC,PWR,2,{seq_pwr},{ts_ms()},BusConn,0,SwVbusCmd,0,VbusOn,1,Vbus_mv,49800,ParState,4,dV_thr_mv,{dv_thr},dV_mv,{dv},Reason,0,VmotReason,0,InaFault,0,Vmot4On,{v4},Vmot5On,{v5},Vmot6On,{v6}")

        next_pwr = now + (1.0 / PWR_HZ)

    


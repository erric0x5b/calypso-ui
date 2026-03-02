import os
import socket
import time
import threading

CMD_LISTEN_PORT = int(os.getenv("SIM_CMD_LISTEN_PORT", "14591"))
SIM_TARGET_HOST = (os.getenv("SIM_TARGET_HOST", "calypso-ui-backend") or "calypso-ui-backend").strip()
SIM_TARGET_PORT = int(os.getenv("SIM_TARGET_PORT", "14590"))
ENV_HZ = float(os.getenv("SIM_RATE_ENV_HZ", "10"))
ESC_HZ = float(os.getenv("SIM_RATE_ESC_HZ", "10"))
HB_HZ  = float(os.getenv("SIM_RATE_HB_HZ", "1"))

sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

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
t0 = time.time()
PWR_HZ = 5.0
next_pwr = time.time()
seq_pwr = 0
vmot_lock = threading.Lock()
vmot_on = [1, 1, 0, 1, 0, 0]  # VMOT1..VMOT6

def ts_ms():
    return int((time.time() - t0) * 1000) & 0xFFFFFFFF

next_env = time.time()
next_esc = time.time()
next_hb  = time.time()

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

        if cmd_type == "VMOT_MASTER":
            tok = str(kv.get("Enable", "0")).strip().lower()
            enable = 1 if tok in ("1", "true", "on", "enable", "enabled") else 0
            with vmot_lock:
                for i in range(6):
                    vmot_on[i] = enable
            text = f"VMOT_{'ON' if enable else 'OFF'}"

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

    time.sleep(0.001)

    if now >= next_pwr:
        seq_pwr = (seq_pwr + 1) & 0xFFFFFFFF
        dv_thr = 200
        dv = 45
        with vmot_lock:
            v1, v2, v3, v4, v5, v6 = vmot_on

        send_line(f"BAT1,SFC,PWR,2,{seq_pwr},{ts_ms()},BusConn,1,SwVbusCmd,1,VbusOn,1,Vbus_mv,49800,VcpuOn,1,VeletOn,1,ParState,4,dV_thr_mv,{dv_thr},dV_mv,{dv},Reason,0,Vmot1On,{v1},Vmot2On,{v2},Vmot3On,{v3}")
        send_line(f"BAT2,SFC,PWR,2,{seq_pwr},{ts_ms()},BusConn,0,SwVbusCmd,0,VbusOn,1,Vbus_mv,49800,VcpuOn,1,VeletOn,1,ParState,3,dV_thr_mv,{dv_thr},dV_mv,{dv},Reason,0,Vmot4On,{v4},Vmot5On,{v5},Vmot6On,{v6}")

        next_pwr = now + (1.0 / PWR_HZ)

    


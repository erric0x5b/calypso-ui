import asyncio
import logging
import os
import socket
import time
from dataclasses import dataclass
from typing import Callable, Optional

log = logging.getLogger("calypso.udp")


def nmea_xor_cksum(line: bytes) -> int | None:
    """
    line: b"$....*HH\\r\\n"
    returns int checksum or None if format invalid
    """
    try:
        if not line.startswith(b"$"):
            return None
        star = line.find(b"*")
        if star < 0:
            return None
        body = line[1:star]
        c = 0
        for b in body:
            c ^= b
        return c
    except Exception:
        return None


@dataclass
class UdpRxStats:
    listener_ok: bool = False
    listener_bind: str = "?"
    listener_port: int = 0
    listener_error: str = ""

    rx_total: int = 0
    rx_last_ts_ms: int = 0
    rx_last_from: str = ""
    rx_last_len: int = 0
    rx_last_prefix: str = ""
    rx_last_ck_ok: int = 0  # 1 ok, 0 fail, -1 unknown/invalid format
    rx_last_msg: str = ""  # ENV/PWR/...
    rx_last_src: str = ""  # BAT1/...
    rx_last_dst: str = ""  # SFC/...


class UdpRxProtocol(asyncio.DatagramProtocol):
    def __init__(self, stats: UdpRxStats, on_datagram: Optional[Callable[[bytes, tuple], None]] = None):
        self.stats = stats
        self.on_datagram = on_datagram

    def connection_made(self, transport):
        sock = transport.get_extra_info("socket")
        if sock:
            try:
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 1_048_576)
            except Exception:
                pass

    def datagram_received(self, data: bytes, addr):
        s = self.stats
        s.rx_total += 1
        s.rx_last_ts_ms = int(time.time() * 1000)
        s.rx_last_from = f"{addr[0]}:{addr[1]}"
        s.rx_last_len = len(data)
        s.rx_last_prefix = data[:160].decode("ascii", errors="replace")

        ck = nmea_xor_cksum(data)
        if ck is None:
            s.rx_last_ck_ok = -1
        else:
            try:
                star = data.find(b"*")
                declared = int(data[star + 1:star + 3], 16)
                s.rx_last_ck_ok = 1 if declared == ck else 0
            except Exception:
                s.rx_last_ck_ok = 0

        try:
            if data.startswith(b"$"):
                head = data[1:].split(b"*", 1)[0]
                parts = head.split(b",")
                if len(parts) >= 3:
                    s.rx_last_src = parts[0].decode(errors="replace")
                    s.rx_last_dst = parts[1].decode(errors="replace")
                    s.rx_last_msg = parts[2].decode(errors="replace")
        except Exception:
            pass

        if (s.rx_total % 50) == 1:
            log.info(
                "UDP RX total=%d last_from=%s last_len=%d last_msg=%s ck_ok=%d",
                s.rx_total,
                s.rx_last_from,
                s.rx_last_len,
                s.rx_last_msg,
                s.rx_last_ck_ok,
            )

        if self.on_datagram:
            self.on_datagram(data, addr)


async def start_udp_listener(
    stats: UdpRxStats,
    on_datagram: Optional[Callable[[bytes, tuple], None]] = None,
):
    port = int(os.getenv("CALYPSO_UDP_RX_PORT", "14590"))
    bind_host = os.getenv("CALYPSO_UDP_BIND", "0.0.0.0")

    loop = asyncio.get_running_loop()
    try:
        transport, _protocol = await loop.create_datagram_endpoint(
            lambda: UdpRxProtocol(stats, on_datagram=on_datagram),
            local_addr=(bind_host, port),
        )
        stats.listener_ok = True
        stats.listener_bind = bind_host
        stats.listener_port = port
        log.info("UDP listener started on %s:%d", bind_host, port)
        return transport
    except Exception as e:
        stats.listener_ok = False
        stats.listener_error = repr(e)
        stats.listener_bind = bind_host
        stats.listener_port = port
        log.exception("UDP listener FAILED on %s:%d", bind_host, port)
        return None

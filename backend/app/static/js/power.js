import { fmtV, fmtA, fmtC, pill, vmotRow } from "./utils.js";

export function renderPowerScada(state){
  const b1 = state.pods?.BAT1 || {};
  const b2 = state.pods?.BAT2 || {};
  const n1 = state.nodes?.BAT1 || {};
  const n2 = state.nodes?.BAT2 || {};

  const bus1 = (b1.bus_conn === 1 || b1.bus_conn === "1" || b1.BusConn === 1 || b1.BusConn === "1");
  const bus2 = (b2.bus_conn === 1 || b2.bus_conn === "1" || b2.BusConn === 1 || b2.BusConn === "1");
  const online1 = Boolean(b1.online ?? n1.online);
  const online2 = Boolean(b2.online ?? n2.online);
  const vbusOn = ((b1.VbusOn === 1 || b1.VbusOn === "1") || (b2.VbusOn === 1 || b2.VbusOn === "1"));

  const dv = (b1.dV_mv ?? b2.dV_mv);
  const dvThr = (b1.dV_thr_mv ?? b2.dV_thr_mv);
  const reason = (b1.Reason ?? b2.Reason ?? 0);

  const dvBad = (dv != null && dvThr != null) ? (Number(dv) > Number(dvThr)) : false;
  const powerFault = (Number(reason) !== 0) || dvBad;
  const alarmsActive = Array.isArray(state.alarms_active) ? state.alarms_active.length : 0;
  const hasFault = powerFault || alarmsActive > 0;

  const vbusMv = (b1.Vbus_mv ?? b2.Vbus_mv);
  const vbusTxt = (vbusMv==null ? "-" : (vbusMv/1000).toFixed(2) + " V");

  const badge = (kind, text) => {
    const map = {
      ok:  { bg:"rgba(34,197,94,.18)", bd:"rgba(34,197,94,.55)", fg:"#bff7d3" },
      warn:{ bg:"rgba(245,158,11,.18)", bd:"rgba(245,158,11,.55)", fg:"#ffe7b8" },
      bad: { bg:"rgba(239,68,68,.18)", bd:"rgba(239,68,68,.55)", fg:"#ffd1d1" },
      info:{ bg:"rgba(148,163,184,.12)", bd:"rgba(148,163,184,.35)", fg:"#e7eefc" },
    };
    const c = map[kind] || map.info;
    return `<span style="
      display:inline-flex;align-items:center;gap:8px;
      padding:6px 10px;border-radius:999px;
      border:1px solid ${c.bd};background:${c.bg};color:${c.fg};
      font-size:12px;font-weight:900;letter-spacing:.2px;">
      ${text}
    </span>`;
  };

  const podKind = (online, busConn) => {
    if (!online) return "bad";
    if (!busConn) return "warn";
    return "ok";
  };
  const podText = (online, busConn) => (!online ? "OFFLINE" : (busConn ? "BUS ON" : "BUS OFF"));
  const vbusKind = hasFault ? "bad" : (vbusOn ? "ok" : "warn");
  const faultKind = hasFault ? "bad" : "ok";
  const faultText = hasFault
    ? `FAULT/ALARM (${alarmsActive}) - vedi scheda Allarmi`
    : "No fault / no alarm";

    return `
    <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;">
      ${badge(podKind(online1, bus1), `POD1 ${podText(online1, bus1)}`)}
      ${badge(podKind(online2, bus2), `POD2 ${podText(online2, bus2)}`)}
      ${badge(vbusKind, `VBUS ${vbusTxt}`)}
      ${badge(faultKind, faultText)}
    </div>
  `;
}

export function scadaSvg(s) {
  const b1 = (s.pods?.BAT1) || {};
  const b2 = (s.pods?.BAT2) || {};
  const n1 = (s.nodes?.BAT1) || {};
  const n2 = (s.nodes?.BAT2) || {};

  const busOn = ((b1.VbusOn ?? b2.VbusOn) ? 1 : 0);
  const vbus = (b1.Vbus_mv ?? b2.Vbus_mv);

  const c1 = (b1.bus_conn === 1 || b1.bus_conn === "1" || b1.BusConn === 1 || b1.BusConn === "1");
  const c2 = (b2.bus_conn === 1 || b2.bus_conn === "1" || b2.BusConn === 1 || b2.BusConn === "1");
  const o1 = Boolean(b1.online ?? n1.online);
  const o2 = Boolean(b2.online ?? n2.online);
  const parallel = c1 && c2 && busOn;

  const vb1 = fmtV(b1.Vbatt_mv), ib1 = fmtA(b1.Ibatt_ma), tb1 = fmtC(b1.Temp_dC);
  const vb2 = fmtV(b2.Vbatt_mv), ib2 = fmtA(b2.Ibatt_ma), tb2 = fmtC(b2.Temp_dC);
  const vbusTxt = (vbus == null ? "-" : (vbus / 1000).toFixed(2) + " V");

  const v1 = (b1.Vmot1On === 1 || b1.Vmot1On === "1");
  const v2 = (b1.Vmot2On === 1 || b1.Vmot2On === "1");
  const v3 = (b1.Vmot3On === 1 || b1.Vmot3On === "1");

  const v4 = (b2.Vmot4On === 1 || b2.Vmot4On === "1");
  const v5 = (b2.Vmot5On === 1 || b2.Vmot5On === "1");
  const v6 = (b2.Vmot6On === 1 || b2.Vmot6On === "1");

  const dv = (b1.dV_mv ?? b2.dV_mv);
  const dvThr = (b1.dV_thr_mv ?? b2.dV_thr_mv);
  const reason = (b1.Reason ?? b2.Reason ?? 0);
  const dvBad = (dv != null && dvThr != null) ? (Number(dv) > Number(dvThr)) : false;
  const fault = (Number(reason) !== 0) || dvBad;

  const colOn = "#22c55e";
  const colWarn = "#f59e0b";
  const colOff = "#5b6780";
  const colFault = "#ef4444";

  const frameColor = (kind) => {
    if (kind === "ok") return colOn;
    if (kind === "warn") return colWarn;
    if (kind === "bad") return colFault;
    return "rgba(255,255,255,0.18)";
  };

  const frameFilter = (kind) => {
    if (kind === "ok") return 'filter="url(#glowGreen)"';
    if (kind === "warn") return 'filter="url(#glowAmber)"';
    if (kind === "bad") return 'filter="url(#glowRed)"';
    return "";
  };

  const podKind = (online, busConn) => {
    if (!online) return "bad";
    if (!busConn) return "warn";
    return "ok";
  };

  const bat1Kind = podKind(o1, c1);
  const bat2Kind = podKind(o2, c2);
  const vbusKind = fault ? "bad" : (busOn ? "ok" : "off");
  const parKind = fault ? "bad" : (parallel ? "ok" : "off");
  const link1Kind = c1 ? (fault ? "bad" : "ok") : bat1Kind;
  const link2Kind = c2 ? (fault ? "bad" : "ok") : bat2Kind;

  const led = (on) => (on ? colOn : colOff);

  const tMain = "#eaf0ff";
  const tMuted = "#aab6d6";

  const VBUS_CX = 360 + 180 / 2;
  const PAR_CX = 360 + 180 / 2;

  const row = (xL, xR, y, label, value) => `
    <text x="${xL}" y="${y}" font-size="12" fill="${tMuted}">${label}</text>
    <text x="${xR}" y="${y}" font-size="12" fill="${tMain}" text-anchor="end">${value}</text>
  `;

  const ledDot = (cx, cy, on, label) => `
    <circle cx="${cx}" cy="${cy}" r="6" fill="${led(on)}" />
    <text x="${cx + 12}" y="${cy + 4}" font-size="11" fill="${tMuted}">${label}</text>
  `;

  const podBg = (online, busConn) => {
    if (!online) return "rgba(239,68,68,0.20)";   // offline
    if (!busConn) return "rgba(245,158,11,0.18)"; // online, bus off
    return "rgba(34,197,94,0.18)";                // online, bus on
  };

  /* BAT1 box */
  const BAT1_X = 40, BAT1_Y = 60, BAT_W = 220, BAT_H = 190;
  const BAT1_L = BAT1_X + 18;
  const BAT1_R = BAT1_X + BAT_W - 18;
  const BAT1_C = BAT1_X + BAT_W/2;
  const BAT1_BG = podBg(o1, c1);
  const bat1Block = `
      <rect x = "${BAT1_X}" y = "${BAT1_Y}" width = "${BAT_W}" height = "${BAT_H}" rx = "14" ry = "14"
        class="scadaFrame ${bat1Kind === "off" ? "" : "pulse"}"
        fill = "${BAT1_BG}" stroke = "${frameColor(bat1Kind)}" stroke-width="3"
        ${frameFilter(bat1Kind)} />

      <text x="${BAT1_C}" y="${BAT1_Y+28}" font-size="14" font-weight="900" fill="${tMain}" text-anchor="middle">BAT1</text>
      ${ row(BAT1_L, BAT1_R, BAT1_Y + 55, "Vbatt", vb1) }
      ${ row(BAT1_L, BAT1_R, BAT1_Y + 75, "Ibatt", ib1) }
      ${ row(BAT1_L, BAT1_R, BAT1_Y + 95, "Temp", tb1) }
      ${ row(BAT1_L, BAT1_R, BAT1_Y + 115, "BusConn", (c1 ? "ON" : "OFF")) }

      <text x="${BAT1_L}" y="${BAT1_Y+142}" font-size="12" font-weight="900" fill="${tMain}">VMOT</text>
      ${ ledDot(BAT1_L + 10, BAT1_Y + 162, v1, "VMOT1") }
      ${ ledDot(BAT1_L + 78, BAT1_Y + 162, v2, "VMOT2") }
      ${ ledDot(BAT1_L + 146, BAT1_Y + 162, v3, "VMOT3") }
    `;

  /* BAT2 box */
  const BAT2_X = 640, BAT2_Y = 60;
  const BAT2_L = BAT2_X + 18;
  const BAT2_R = BAT2_X + BAT_W - 18;
  const BAT2_C = BAT2_X + BAT_W/2;
  const BAT2_BG = podBg(o2, c2);
  const bat2Block = `
      <rect x = "${BAT2_X}" y = "${BAT2_Y}" width = "${BAT_W}" height = "${BAT_H}" rx = "14" ry = "14"
      class="scadaFrame ${bat2Kind === "off" ? "" : "pulse"}"
      fill = "${BAT2_BG}" stroke = "${frameColor(bat2Kind)}" stroke-width="3"
      ${frameFilter(bat2Kind)} />

      <text x="${BAT2_C}" y="${BAT2_Y+28}" font-size="14" font-weight="900" fill="${tMain}" text-anchor="middle">BAT2</text>
      ${ row(BAT2_L, BAT2_R, BAT2_Y + 55, "Vbatt", vb2) }
      ${ row(BAT2_L, BAT2_R, BAT2_Y + 75, "Ibatt", ib2) }
      ${ row(BAT2_L, BAT2_R, BAT2_Y + 95, "Temp", tb2) }
      ${ row(BAT2_L, BAT2_R, BAT2_Y + 115, "BusConn", (c2 ? "ON" : "OFF")) }

      <text x="${BAT2_L}" y="${BAT2_Y+142}" font-size="12" font-weight="900" fill="${tMain}">VMOT</text>
      ${ ledDot(BAT2_L + 10, BAT2_Y + 162, v4, "VMOT4") }
      ${ ledDot(BAT2_L + 78, BAT2_Y + 162, v5, "VMOT5") }
      ${ ledDot(BAT2_L + 146, BAT2_Y + 162, v6, "VMOT6") }
    `;

  return `
  
  <svg viewBox="0 0 900 420" preserveAspectRatio="xMidYMid meet">
    <defs>
      <style>
        .scadaFrame { stroke-linejoin: round; }
        .scadaFrame.pulse { animation: framePulse 1.8s ease-in-out infinite; }
        .scadaLink.pulse { animation: linkPulse 1.8s ease-in-out infinite; }
        @keyframes framePulse {
          0% { stroke-opacity: 0.45; }
          50% { stroke-opacity: 1.0; }
          100% { stroke-opacity: 0.55; }
        }
        @keyframes linkPulse {
          0% { opacity: 0.55; }
          50% { opacity: 1.0; }
          100% { opacity: 0.65; }
        }
      </style>
      <filter id="glowGreen" x="-60%" y="-60%" width="220%" height="220%">
        <feGaussianBlur stdDeviation="3.5" result="blur"/>
        <feColorMatrix in="blur" type="matrix"
          values="0 0 0 0 0.13
                  0 0 0 0 0.95
                  0 0 0 0 0.45
                  0 0 0 0.9 0" result="gblur"/>
        <feMerge>
          <feMergeNode in="gblur"/>
          <feMergeNode in="SourceGraphic"/>
        </feMerge>
      </filter>

      <filter id="glowAmber" x="-60%" y="-60%" width="220%" height="220%">
        <feGaussianBlur stdDeviation="3.5" result="blur"/>
        <feColorMatrix in="blur" type="matrix"
          values="0 0 0 0 0.96
                  0 0 0 0 0.62
                  0 0 0 0 0.06
                  0 0 0 0.9 0" result="ablur"/>
        <feMerge>
          <feMergeNode in="ablur"/>
          <feMergeNode in="SourceGraphic"/>
        </feMerge>
      </filter>

      <filter id="glowRed" x="-60%" y="-60%" width="220%" height="220%">
        <feGaussianBlur stdDeviation="3.5" result="blur"/>
        <feColorMatrix in="blur" type="matrix"
          values="0 0 0 0 0.95
                  0 0 0 0 0.20
                  0 0 0 0 0.20
                  0 0 0 0.9 0" result="rblur"/>
        <feMerge>
          <feMergeNode in="rblur"/>
          <feMergeNode in="SourceGraphic"/>
        </feMerge>
      </filter>
    </defs>

    ${bat1Block}
    ${bat2Block}  

    <!-- VBUS box (center) -->
    <rect x="360" y="95" width="180" height="90" rx="14" ry="14"
      fill="rgba(255,255,255,0.04)"
      class="scadaFrame ${vbusKind === "off" ? "" : "pulse"}"
      stroke="${frameColor(vbusKind)}" stroke-width="3"
      ${frameFilter(vbusKind)} />

    <text x="${VBUS_CX}" y="125" font-size="16" font-weight="900" fill="${tMain}" text-anchor="middle">VBUS</text>
    <text x="${VBUS_CX}" y="150" font-size="14" fill="${tMuted}" text-anchor="middle">Vbus: ${vbusTxt}</text>
    <text x="${VBUS_CX}" y="175" font-size="14" fill="${tMuted}" text-anchor="middle">
      ${fault ? `FAULT (Reason ${reason}${dvBad ? `, ΔV ${dv}/${dvThr}mV` : ""})` : `State: ${busOn ? "ON" : "OFF"}`}
    </text>

    <!-- Lines -->
    <line x1="260" y1="140" x2="360" y2="140"
      class="scadaLink ${link1Kind === "off" ? "" : "pulse"}"
      stroke="${frameColor(link1Kind)}" stroke-width="10" stroke-linecap="round"
      ${frameFilter(link1Kind)} />
    <circle cx="310" cy="140" r="10"
      class="scadaLink ${link1Kind === "off" ? "" : "pulse"}"
      fill="${frameColor(link1Kind)}" ${frameFilter(link1Kind)} />

    <line x1="540" y1="140" x2="640" y2="140"
      class="scadaLink ${link2Kind === "off" ? "" : "pulse"}"
      stroke="${frameColor(link2Kind)}" stroke-width="10" stroke-linecap="round"
      ${frameFilter(link2Kind)} />
    <circle cx="590" cy="140" r="10"
      class="scadaLink ${link2Kind === "off" ? "" : "pulse"}"
      fill="${frameColor(link2Kind)}" ${frameFilter(link2Kind)} />

    <!-- Parallel badge -->
    <rect x="360" y="230" width="180" height="50" rx="25" ry="25"
      fill="rgba(255,255,255,0.04)"
      class="scadaFrame ${parKind === "off" ? "" : "pulse"}"
      stroke="${frameColor(parKind)}" stroke-width="3"
      ${frameFilter(parKind)} />

    <text x="${PAR_CX}" y="262" font-size="16" font-weight="900" fill="${frameColor(parKind)}" text-anchor="middle">
      PARALLEL: ${parallel ? "ON" : "OFF"}
    </text>
  </svg>`;
}


const el = (id) => document.getElementById(id);

const fmtV = (mv) => (mv == null ? "-" : (mv / 1000).toFixed(2) + " V");
const fmtA = (ma) => (ma == null ? "-" : (ma / 1000).toFixed(2) + " A");
const fmtC = (dC) => (dC == null ? "-" : (dC / 10).toFixed(1) + " °C");

function sevLabel(sev) {
  if (sev == 3) return "CRIT";
  if (sev == 2) return "ERR";
  if (sev == 1) return "WARN";
  return "INFO";
}

function pill(on, label) {
  const bg = on ? "rgba(34,197,94,.18)" : "rgba(239,68,68,.18)";
  const bd = on ? "rgba(34,197,94,.55)" : "rgba(239,68,68,.55)";
  const fg = on ? "#bff7d3" : "#ffd1d1";  // testo chiaro ma leggibile su bg scuro
  return `<span style="
    display:inline-block;padding:3px 8px;border-radius:999px;
    border:1px solid ${bd};background:${bg};color:${fg};
    margin-right:6px;font-size:12px;font-weight:800">
    ${label}:${on ? "ON" : "OFF"}
  </span>`;
}

function vmotRow(d, keys) {
  return keys.map(k => pill(d[k] === 1 || d[k] === "1", k.replace("On", ""))).join("");
}

function parStateLabel(x) {
  const m = {
    0: "INIT",
    1: "CHECK_DV",
    2: "PRECHARGE",
    3: "RUN_PAR_DISABLED",
    4: "RUN_PAR_ENABLED",
    5: "FAULT_DV_HIGH",
    6: "FAULT_NODE",
    7: "MANUAL_LOCKOUT"
  };
  return m[x] || `STATE_${x ?? "?"}`;
}

function renderPowerScada(state){
  const b1 = state.pods?.BAT1 || {};
  const b2 = state.pods?.BAT2 || {};

  const bus1 = (b1.BusConn === 1 || b1.BusConn === "1");
  const bus2 = (b2.BusConn === 1 || b2.BusConn === "1");
  const vbusOn = ((b1.VbusOn === 1 || b1.VbusOn === "1") || (b2.VbusOn === 1 || b2.VbusOn === "1"));

  const parallel = bus1 && bus2 && vbusOn;

  const dv = (b1.dV_mv ?? b2.dV_mv);
  const dvThr = (b1.dV_thr_mv ?? b2.dV_thr_mv);
  const reason = (b1.Reason ?? b2.Reason ?? 0);

  const dvBad = (dv != null && dvThr != null) ? (Number(dv) > Number(dvThr)) : false;
  const fault = (Number(reason) !== 0) || dvBad;

  const vbus = (b1.Vbus_mv ?? b2.Vbus_mv);
  const vbusTxt = (vbus==null ? "-" : (vbus/1000).toFixed(2) + " V");

  const badge = (kind, text) => {
    // kind: "ok" | "warn" | "bad" | "info"
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

  const kindParallel = fault ? "bad" : (parallel ? "ok" : "info");
  const kindDv = fault ? "bad" : (dvBad ? "warn" : "ok");
  const kindReason = (Number(reason)===0) ? "ok" : "bad";

  return `
    <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;">
      ${badge(kindParallel, `PARALLEL ${parallel ? "ON" : "OFF"}`)}
      ${badge(kindDv, `ΔV ${dv ?? "-"} / THR ${dvThr ?? "-"} mV`)}
      ${badge(kindReason, `Reason ${reason}`)}
      ${badge("info", `VBUS ${vbusTxt}`)}
    </div>
  `;
}



function scadaSvg(s) {
  const b1 = (s.pods?.BAT1) || {};
  const b2 = (s.pods?.BAT2) || {};

  const busOn = ((b1.VbusOn ?? b2.VbusOn) ? 1 : 0);
  const vbus = (b1.Vbus_mv ?? b2.Vbus_mv);

  const c1 = (b1.BusConn === 1 || b1.BusConn === "1");
  const c2 = (b2.BusConn === 1 || b2.BusConn === "1");
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

  // ---- Fault logic (simple demo) ----
  const dv = (b1.dV_mv ?? b2.dV_mv);
  const dvThr = (b1.dV_thr_mv ?? b2.dV_thr_mv);
  const reason = (b1.Reason ?? b2.Reason ?? 0);
  const dvBad = (dv != null && dvThr != null) ? (Number(dv) > Number(dvThr)) : false;
  const fault = (Number(reason) !== 0) || dvBad;

  // ---- Colors / helpers ----
  const colOn = "#22c55e";     // green
  const colOff = "#5b6780";    // muted gray-blue
  const colFault = "#ef4444";  // red

  const line1 = c1 ? colOn : colOff;
  const line2 = c2 ? colOn : colOff;
  const busCol = busOn ? (fault ? colFault : colOn) : colOff;
  const parCol = parallel ? (fault ? colFault : colOn) : colOff;

  const led = (on) => (on ? colOn : colOff);

  // choose glow: green if ON, red if fault + ON, none if OFF
  const glow = (on, isFault) => {
    if (!on) return "";
    return isFault ? 'filter="url(#glowRed)"' : 'filter="url(#glowGreen)"';
  };

  // text colors (always readable on dark bg)
  const tMain = "#eaf0ff";
  const tMuted = "#aab6d6";

  // centers for boxes
  const VBUS_CX = 360 + 180 / 2;     // 450
  const PAR_CX = 360 + 180 / 2;     // 450

  const row = (xL, xR, y, label, value) => `
    <text x="${xL}" y="${y}" font-size="12" fill="${tMuted}">${label}</text>
    <text x="${xR}" y="${y}" font-size="12" fill="${tMain}" text-anchor="end">${value}</text>
  `;

  const ledDot = (cx, cy, on, label) => `
    <circle cx="${cx}" cy="${cy}" r="6" fill="${led(on)}" />
    <text x="${cx + 12}" y="${cy + 4}" font-size="11" fill="${tMuted}">${label}</text>
  `;

  /* BAT1 box */
  const BAT1_X = 40, BAT1_Y = 60, BAT_W = 220, BAT_H = 190;
  const BAT1_L = BAT1_X + 18;
  const BAT1_R = BAT1_X + BAT_W - 18;
  const BAT1_C = BAT1_X + BAT_W/2;
  const bat1Block = `
      <rect x = "${BAT1_X}" y = "${BAT1_Y}" width = "${BAT_W}" height = "${BAT_H}" rx = "14" ry = "14"
        fill = "rgba(255,255,255,0.04)" stroke = "rgba(255,255,255,0.10)" />

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
  const bat2Block = `
      < rect x = "${BAT2_X}" y = "${BAT2_Y}" width = "${BAT_W}" height = "${BAT_H}" rx = "14" ry = "14"
      fill = "rgba(255,255,255,0.04)" stroke = "rgba(255,255,255,0.10)" />

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
  
  <svg viewBox="0 0 900 320" width="100%" height="260">
    <defs>
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
      stroke="${busCol}" stroke-width="3"
      ${glow(busOn, fault)} />

    <text x="${VBUS_CX}" y="125" font-size="16" font-weight="900" fill="${tMain}" text-anchor="middle">VBUS</text>
    <text x="${VBUS_CX}" y="150" font-size="14" fill="${tMuted}" text-anchor="middle">Vbus: ${vbusTxt}</text>
    <text x="${VBUS_CX}" y="175" font-size="14" fill="${tMuted}" text-anchor="middle">
      ${fault ? `FAULT (Reason ${reason}${dvBad ? `, ΔV ${dv}/${dvThr}mV` : ""})` : `State: ${busOn ? "ON" : "OFF"}`}
    </text>

    <!-- Lines -->
    <line x1="260" y1="140" x2="360" y2="140"
      stroke="${line1}" stroke-width="10" stroke-linecap="round"
      ${glow(c1, fault && busOn)} />
    <circle cx="310" cy="140" r="10" fill="${line1}" ${glow(c1, fault && busOn)} />

    <line x1="540" y1="140" x2="640" y2="140"
      stroke="${line2}" stroke-width="10" stroke-linecap="round"
      ${glow(c2, fault && busOn)} />
    <circle cx="590" cy="140" r="10" fill="${line2}" ${glow(c2, fault && busOn)} />

    <!-- Parallel badge -->
    <rect x="360" y="230" width="180" height="50" rx="25" ry="25"
      fill="rgba(255,255,255,0.04)"
      stroke="${parCol}" stroke-width="3"
      ${glow(parallel, fault)} />

    <text x="${PAR_CX}" y="262" font-size="16" font-weight="900" fill="${parCol}" text-anchor="middle">
      PARALLEL: ${parallel ? "ON" : "OFF"}
    </text>
  </svg>`;
}


function setupLights() {
  const slider = el("lgt_dim");
  const label = el("lgt_dim_val");
  slider.addEventListener("input", () => label.textContent = slider.value);

  el("lgt_on").onclick = () => sendLight("ON", parseInt(slider.value, 10));
  el("lgt_off").onclick = () => sendLight("OFF", 0);

  slider.addEventListener("change", () => sendLight("ON", parseInt(slider.value, 10)));
}

let lightsCfg = null;

function parseIdsCsv(s) {
  return (s || "")
    .split(",")
    .map(x => x.trim())
    .filter(x => x.length)
    .map(x => parseInt(x, 10))
    .filter(x => Number.isFinite(x) && x > 0);
}

async function loadLightsCfg() {
  lightsCfg = await fetch("/api/config/lights").then(r => r.json());
  renderLightsCfg();
  renderLightsCtrl();
  el("lgt_cfg_status").textContent = "loaded";
}

function renderLightsCfg() {
  const ch = lightsCfg?.channels || {};
  let html = `<table><tr><th>CH</th><th>Name</th><th>Lamp IDs (csv)</th></tr>`;
  for (const k of ["1", "2", "3", "4"]) {
    const c = ch[k] || { name: `CH${k}`, lamp_ids: [] };
    html += `<tr>
      <td>${k}</td>
      <td><input id="lgt_name_${k}" value="${c.name ?? ""}" style="width:120px"></td>
      <td><input id="lgt_ids_${k}" value="${(c.lamp_ids || []).join(",")}" style="width:180px"></td>
    </tr>`;
  }
  html += `</table>`;
  el("lgt_cfg").innerHTML = html;
}

async function saveLightsCfg() {
  const cfg = { version: 1, channels: {} };
  for (const k of ["1", "2", "3", "4"]) {
    cfg.channels[k] = {
      name: el(`lgt_name_${k}`).value || `CH${k}`,
      lamp_ids: Array.from(new Set(parseIdsCsv(el(`lgt_ids_${k}`).value))).sort((a, b) => a - b)
    };
  }
  const r = await fetch("/api/config/lights", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cfg)
  });
  if (!r.ok) {
    const t = await r.text();
    el("lgt_cfg_status").textContent = "save ERR";
    console.error("save cfg err", t);
    return;
  }
  el("lgt_cfg_status").textContent = "saved";
  lightsCfg = cfg;
  renderLightsCtrl();
}

async function sendLightsChannel(ch, mode, dim) {
  const r = await fetch("/api/cmd/lights_channel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ch, mode, dim })
  });
  const j = await r.json();
  el("lgt_ack").textContent = j.ok ? (`sent CmdId ${j.cmd_id} (CH${ch} → ${j.lamp_ids?.length || 0} lamps)`) : "send fail";
}

function renderLightsCtrl() {
  let html = `<div class="lightsGrid">`;
  for (const k of ["1", "2", "3", "4"]) {
    const name = lightsCfg?.channels?.[k]?.name || `CH${k}`;
    html += `
      <div class="chcol">
        <div style="font-weight:800">${name}</div>
        <div class="vslider-wrap">
          <input id="lgt_dim_${k}" class="vslider" type="range" min="0" max="1000" value="0">
        </div>
        <div><span id="lgt_val_${k}">0</span></div>
        <div style="display:flex;gap:6px;">
          <button id="lgt_on_${k}">ON</button>
          <button id="lgt_off_${k}">OFF</button>
        </div>
      </div>`;
  }
  html += `</div>`;
  el("lgt_ctrl").innerHTML = html;

  // wiring (come già fai)
  for (const k of ["1", "2", "3", "4"]) {
    const slider = el(`lgt_dim_${k}`);
    const label = el(`lgt_val_${k}`);
    slider.addEventListener("input", () => label.textContent = slider.value);
    el(`lgt_on_${k}`).onclick = () => sendLightsChannel(parseInt(k, 10), "ON", parseInt(slider.value, 10));
    el(`lgt_off_${k}`).onclick = () => sendLightsChannel(parseInt(k, 10), "OFF", 0);
    slider.addEventListener("change", () => sendLightsChannel(parseInt(k, 10), "ON", parseInt(slider.value, 10)));
  }
}


function render(state) {
  // nodes
  const nodes = state.nodes || {};
  let nhtml = "<table><tr><th>Node</th><th>Status</th><th>Last HB</th></tr>";
  for (const [k, v] of Object.entries(nodes)) {
    const on = v.online ? "ok" : "bad";
    nhtml += `<tr><td>${k}</td><td class="${on}">${v.online ? "ONLINE" : "OFFLINE"}</td><td>${v.last_hb_ms ?? "-"}</td></tr>`;
  }
  nhtml += "</table>";
  el("nodes").innerHTML = nhtml;

  // pods
  const pods = state.pods || {};
  let phtml = "<table><tr><th>Pod</th><th>Vbatt</th><th>Ibatt</th><th>Temp</th><th>BUS</th><th>VMOT</th></tr>";
  for (const pod of ["BAT1", "BAT2"]) {
    const d = pods[pod] || {};
    const bus = (d.BusConn === 1 || d.BusConn === "1") ? "ON" : "OFF";
    const vmot = (pod === "BAT1")
      ? vmotRow(d, ["Vmot1On", "Vmot2On", "Vmot3On"])
      : vmotRow(d, ["Vmot4On", "Vmot5On", "Vmot6On"]);
    phtml += `<tr><td>${pod}</td><td>${fmtV(d.Vbatt_mv)}</td><td>${fmtA(d.Ibatt_ma)}</td><td>${fmtC(d.Temp_dC)}</td><td>${bus}</td><td>${vmot}</td></tr>`;
  }
  phtml += "</table>";
  el("pods").innerHTML = phtml;

  // power scada unified
  el("power_scada_badges").innerHTML = renderPowerScada(state);
  el("power_scada_svg").innerHTML = scadaSvg(state);
  el("mission_log").textContent = `last_update_ms: ${state.last_update_ms ?? "-"}\nudp_rx: ${state.counters?.udp_rx ?? "-"}`;


  // esc
  const esc = state.esc || {};
  let ehtml = "<table><tr><th>ID</th><th>RPM</th><th>Vin</th><th>Iin</th><th>Wh</th><th>Src</th></tr>";
  const ids = Object.keys(esc).map(x => parseInt(x, 10)).sort((a, b) => a - b);
  for (const id of ids) {
    const d = esc[id] || {};
    ehtml += `<tr><td>${id}</td><td>${d.RPM ?? "-"}</td><td>${fmtV(d.InVoltage_mv)}</td><td>${fmtA(d.AvgInCur_ma)}</td><td>${d.Wh_x10 != null ? (d.Wh_x10 / 10).toFixed(1) : "-"}</td><td>${d.src ?? "-"}</td></tr>`;
  }
  ehtml += "</table>";
  el("esc").innerHTML = ehtml;

  // alarms
  const aa = state.alarms_active || [];
  el("alarms_active").innerHTML = aa.length
    ? aa.map(a => `<div class="${a.sev >= 2 ? 'bad' : 'ok'}">[${sevLabel(a.sev)}] ${a.text ?? ""} <span class="mono">${a.ts_ms}</span></div>`).join("")
    : "<div class='ok'>none</div>";

  const hist = (state.alarms_history || []).slice(-10).reverse();
  el("alarms_hist").innerHTML = hist.length
    ? hist.map(a => `<div>[${sevLabel(a.sev)}] ${a.text ?? ""} <span class="mono">${a.ts_ms}</span></div>`).join("")
    : "<div class='ok'>none</div>";

  // last raw + counters
  el("last_raw").textContent = (state.__last_raw || "");
  el("counters").innerHTML = `<div class="mono">${JSON.stringify(state.counters || {}, null, 2)}</div>`;

  // Power badges in dock
  el("power_scada_badges").innerHTML = renderPowerScada(state);

  // Dock power badges
  const pb = document.getElementById("power_scada_badges");
  if(pb) pb.innerHTML = renderPowerScada(state);

  // Main SCADA only in mission tab
  if((uiPrefs?.mainTab || "mission") === "mission"){
    const mb = document.getElementById("main_power_badges");
    const ms = document.getElementById("main_scada");
    if(mb) mb.innerHTML = renderPowerScada(state);
    if(ms) ms.innerHTML = scadaSvg(state);

    // init 3D se serve
    //init3D();

    // per ora: se non hai ancora MAVLink attitude, simulo usando ts
    // Se in futuro metti state.att = {roll_deg,pitch_deg,yaw_deg}
    const att = state.att || null;

    let roll = 0, pitch = 0, yaw = 0;
    if(att && (att.roll_deg!=null || att.pitch_deg!=null || att.yaw_deg!=null)){
      roll = degToRad(att.roll_deg);
      pitch = degToRad(att.pitch_deg);
      yaw = degToRad(att.yaw_deg);
    }else{
      // demo: piccola oscillazione per vedere che funziona
      const t = (state.last_update_ms || 0) / 1000;
      roll = Math.sin(t * 0.6) * 0.25;
      pitch = Math.sin(t * 0.4) * 0.18;
      yaw = (t * 0.2);
    }

    setRovAttitudeRad(roll, pitch, yaw);

    const r = (roll*180/Math.PI).toFixed(1);
    const p = (pitch*180/Math.PI).toFixed(1);
    const y = (yaw*180/Math.PI).toFixed(1);
    const ar = document.getElementById("att_readout");
    if(ar) ar.textContent = `roll ${r}°  pitch ${p}°  yaw ${y}°`;
  }
}

let snapshot = null;

window.addEventListener("load", () => {
  try { init(); } catch (e) { console.error(e); }
});

async function init() {
  snapshot = await fetch("/api/state").then(r => r.json());
  render(snapshot);
  renderWidgetsMenu();
  setupWidgetsMenu();
  setupCollapseButtons();
  applyWidgetVisibility();
  setupTabs();


  await loadLightsCfg();
  el("lgt_cfg_save").onclick = saveLightsCfg;
  setupLightsConfigToggle();
  el("lgt_cfg_save").onclick = saveLightsCfg;

  setupLogs();
  await refreshLogStatus();
  await refreshLogSessions();

  const wsProto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${wsProto}://${location.host}/ws`);

  ws.onopen = () => { const s = el("status"); if (s) s.textContent = "WS connected"; };
  ws.onclose = () => { const s = el("status"); if (s) s.textContent = "WS closed"; };
  ws.onerror = () => { const s = el("status"); if (s) s.textContent = "WS error"; };

  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === "udp" || msg.type === "alarm" || msg.type === "update") {
        const lastRaw = msg.raw;
        fetch("/api/state").then(r => r.json()).then(s => {
          snapshot = s;
          if (lastRaw) snapshot.__last_raw = lastRaw;
          render(snapshot);
        });
      }
    } catch (e) { }
  };
}

const WIDGETS = [
  { id: "alarms", title: "Allarmi" },
  { id: "power", title: "Power" },
  { id: "lights", title: "Luci" },
  { id: "motors", title: "Motori" },
  { id: "missionlog", title: "Mission Log" },
];

function loadUiPrefs() {
  try { return JSON.parse(localStorage.getItem("calypso_ui_prefs") || "{}"); } catch (e) { return {}; }
}
function saveUiPrefs(p) { localStorage.setItem("calypso_ui_prefs", JSON.stringify(p)); }

let uiPrefs = loadUiPrefs();
uiPrefs.visible ??= Object.fromEntries(WIDGETS.map(w => [w.id, true]));
uiPrefs.collapsed ??= {};
uiPrefs.mainTab ??= "mission";

function applyWidgetVisibility() {
  for (const w of WIDGETS) {
    const card = document.querySelector(`[data-widget="${w.id}"]`);
    if (!card) continue;
    card.style.display = uiPrefs.visible[w.id] ? "" : "none";
    const body = card.querySelector(".cardBody");
    const col = !!uiPrefs.collapsed[w.id];
    if (body) body.style.display = col ? "none" : "";
  }
}

function renderWidgetsMenu() {
  const panel = el("widgets_panel");
  panel.innerHTML = WIDGETS.map(w => `
    <label>
      <input type="checkbox" ${uiPrefs.visible[w.id] ? "checked" : ""} data-wid="${w.id}">
      <span>${w.title}</span>
    </label>`).join("");
  panel.querySelectorAll("input[type=checkbox]").forEach(cb => {
    cb.addEventListener("change", () => {
      uiPrefs.visible[cb.dataset.wid] = cb.checked;
      saveUiPrefs(uiPrefs);
      applyWidgetVisibility();
    });
  });
}

function setupWidgetsMenu() {
  el("btn_widgets").onclick = () => {
    el("widgets_panel").classList.toggle("hidden");
  };
  document.addEventListener("click", (e) => {
    const p = el("widgets_panel");
    if (p.classList.contains("hidden")) return;
    if (e.target.id === "btn_widgets" || p.contains(e.target)) return;
    p.classList.add("hidden");
  });
}

function setupCollapseButtons() {
  document.querySelectorAll("[data-collapse]").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.collapse;
      uiPrefs.collapsed[id] = !uiPrefs.collapsed[id];
      saveUiPrefs(uiPrefs);
      applyWidgetVisibility();
    });
  });
}

function renderMainSlot(tab){
  el("main_mode").textContent = tab.toUpperCase();

  if(tab === "video"){
    el("main_slot").innerHTML = `<div class="mono">VIDEO SLOT (da integrare)</div>`;
    return;
  }
  if(tab === "sonar"){
    el("main_slot").innerHTML = `<div class="mono">SONAR SLOT (da integrare)</div>`;
    return;
  }

  if(tab === "mission"){
    //if(tab === "sonar"){
    // dentro renderMainSlot(tab) quando tab === "mission"
    el("main_slot").innerHTML = `
      <div class="missionGrid">
        <div class="card">
          <div class="cardHead"><div class="cardTitle">Power SCADA</div></div>
          <div class="cardBody">
            <div id="main_power_badges"></div>
            <div id="main_scada" style="margin-top:12px;"></div>
          </div>
        </div>

        <div class="card">
          <div class="cardHead"><div class="cardTitle">ROV 3D</div></div>
          <div class="cardBody">
            <div id="att_readout" class="mono" style="margin-bottom:8px;"></div>
            <div id="rov3d" style="width:100%; height:340px; border-radius:12px; overflow:hidden; border:1px solid rgba(255,255,255,.08);"></div>
          </div>
        </div>
      </div>
    `;  
    return;
  };
}

function setupTabs() {
  document.querySelectorAll(".tab").forEach(t => {
    t.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach(x => x.classList.remove("active"));
      t.classList.add("active");
      uiPrefs.mainTab = t.dataset.tab;
      saveUiPrefs(uiPrefs);
      renderMainSlot(uiPrefs.mainTab);
    });
  });

  // apply saved tab
  const cur = uiPrefs.mainTab || "mission";
  document.querySelectorAll(".tab").forEach(x => {
    x.classList.toggle("active", x.dataset.tab === cur);
  });
  renderMainSlot(cur);
}

function setupLightsConfigToggle() {
  const btn = el("lgt_btn_cfg");
  const wrap = el("lgt_cfg_wrap");
  if (!btn || !wrap) return;
  btn.onclick = () => {
    wrap.classList.toggle("hidden");
  };
}

let three = {
  inited: false,
  scene: null,
  camera: null,
  renderer: null,
  root: null,
  model: null,
  container: null,
  lastSize: {w:0,h:0},
  // offset assi: se il modello non “punta” avanti correttamente, qui correggiamo
  modelEulerOffset: {x: 0, y: 0, z: 0},
  rafId: null, 
  animRunning: false,
};

function init3D(){
  const container = document.getElementById("rov3d");
  if(!container) return;
  if(three.inited) return;

  // evita init se il container non ha ancora size (tab appena renderizzata)
  const cw = container.clientWidth || 0;
  const ch = container.clientHeight || 0;
  if(cw < 50 || ch < 50){
    // riprova tra poco
    setTimeout(init3D, 150);
    return;
  }

  three.container = container;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b1220);

  const camera = new THREE.PerspectiveCamera(45, cw/ch, 0.01, 2000);

  const renderer = new THREE.WebGLRenderer({ antialias:true, alpha:false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(cw, ch, false);

  // color space corretto (aiuta molto materiali scuri)
  if(renderer.outputColorSpace !== undefined){
    renderer.outputColorSpace = THREE.SRGBColorSpace;
  }else if(renderer.outputEncoding !== undefined){
    renderer.outputEncoding = THREE.sRGBEncoding;
  }

  container.innerHTML = "";
  container.appendChild(renderer.domElement);

  // luci più “visibili”
  scene.add(new THREE.AmbientLight(0xffffff, 0.35));

  const hemi = new THREE.HemisphereLight(0xffffff, 0x223355, 0.85);
  scene.add(hemi);

  const dir = new THREE.DirectionalLight(0xffffff, 1.2);
  dir.position.set(2.5, 3.5, 2.0);
  scene.add(dir);

  // aiuti visivi
  const axes = new THREE.AxesHelper(0.25);
  scene.add(axes);

  const grid = new THREE.GridHelper(2.0, 10, 0x20304a, 0x18243a);
  grid.position.y = -0.25;
  scene.add(grid);

  // root: qui applicheremo attitude
  const root = new THREE.Group();
  scene.add(root);

  // funzione per inquadrare automaticamente il modello
  function fitCameraToObject(obj){
    const box = new THREE.Box3().setFromObject(obj);
    const size = new THREE.Vector3();
    box.getSize(size);
    const center = new THREE.Vector3();
    box.getCenter(center);

    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const fov = camera.fov * (Math.PI / 180);
    let cameraZ = Math.abs(maxDim / (2 * Math.tan(fov / 2)));

    cameraZ *= 1.6; // margine
    camera.position.set(center.x + cameraZ*0.55, center.y + cameraZ*0.35, center.z + cameraZ);
    camera.near = maxDim / 200;
    camera.far  = maxDim * 200;
    camera.updateProjectionMatrix();
    camera.lookAt(center);
  }

  const loader = new THREE.GLTFLoader();
  const statusEl = document.getElementById("att_readout");
  if(statusEl) statusEl.textContent = "Loading ROV model…";

  loader.load(
    "/static/models/rov.glb",
    (gltf) => {
      const model = gltf.scene;

      // se il modello è super scuro, rendi doubleSide e assicurati che non sia trasparente weird
      model.traverse((o)=>{
        if(o.isMesh){
          o.frustumCulled = false;
          if(o.material){
            o.material.transparent = false;
            o.material.side = THREE.DoubleSide;
          }
        }
      });

      // centra sull'origine e scala “umana”
      const box = new THREE.Box3().setFromObject(model);
      const size = new THREE.Vector3();
      box.getSize(size);
      const center = new THREE.Vector3();
      box.getCenter(center);

      const maxDim = Math.max(size.x, size.y, size.z) || 1;
      const target = 0.9;                 // dimensione target in scena
      const scale = target / maxDim;

      model.scale.setScalar(scale);
      model.position.set(-center.x*scale, -center.y*scale, -center.z*scale);

      // offset assi (se necessario, per ora 0)
      model.rotation.set(
        three.modelEulerOffset.x,
        three.modelEulerOffset.y,
        three.modelEulerOffset.z
      );

      root.add(model);
      three.model = model;

      fitCameraToObject(root);

      if(statusEl) statusEl.textContent = "ROV model loaded";
    },
    (xhr) => {
      // opzionale: progress
      // if(statusEl && xhr.total) statusEl.textContent = `Loading… ${Math.round(xhr.loaded/xhr.total*100)}%`;
    },
    (err) => {
      if(statusEl) statusEl.textContent = "GLB load error (check console)";
      console.error("GLB load error", err);
    }
  );

  three.scene = scene;
  three.camera = camera;
  three.renderer = renderer;
  three.root = root;
  three.inited = true;

  if(three.animRunning) return;
    three.animRunning = true;

  function animate(){
    requestAnimationFrame(animate);
    resize3DIfNeeded();
    renderer.render(scene, camera);
    three.rafId = requestAnimationFrame(animate);
  }
  
  animate();
}

function resize3DIfNeeded(){
  if(!three.inited || !three.container) return;
  const w = three.container.clientWidth || 640;
  const h = three.container.clientHeight || 360;
  if(w === three.lastSize.w && h === three.lastSize.h) return;

  three.lastSize = {w,h};
  three.camera.aspect = w/h;
  three.camera.updateProjectionMatrix();
  three.renderer.setSize(w, h, false);
}

// Attitude: roll/pitch/yaw in radianti (se li hai in gradi converti)
function setRovAttitudeRad(roll, pitch, yaw){
  if(!three.inited || !three.root) return;

  // convenzione tipica:
  // roll  = rotazione attorno asse X
  // pitch = rotazione attorno asse Y
  // yaw   = rotazione attorno asse Z
  // NB: potrebbe servire remapping; per ora partiamo così.
  three.root.rotation.set(roll || 0, pitch || 0, yaw || 0, "XYZ");
}

function degToRad(d){ return (d || 0) * Math.PI / 180; }

function stop3D(){
    if(three.rafId) cancelAnimationFrame(three.rafId);
    three.rafId = null;
    three.animRunning = false;
  }

  async function refreshLogSessions(){
  const j = await fetch("/api/log/sessions").then(r=>r.json());
  const s = j.sessions || [];
  el("log_sessions").innerHTML = s.slice(0,8).map(x=>`
    <div style="display:flex;justify-content:space-between;align-items:center;margin:6px 0;">
      <div class="mono">${x.sid}</div>
      <div>
        <a class="btn" href="/api/log/zip?sid=${x.sid}">ZIP</a>
      </div>
    </div>
  `).join("") || "<div class='mono'>No sessions</div>";
}

async function refreshLogStatus(){
  const j = await fetch("/api/log/status").then(r=>r.json());
  const enabled = !!j.enabled;
  const sid = j.sid || "-";
  el("log_status").textContent = `${enabled ? "ON" : "OFF"}  ${sid}`;

  const zip = el("log_zip");
  if(sid && sid !== "-"){
    zip.href = `/api/log/zip?sid=${sid}`;
    zip.style.pointerEvents = "auto";
    zip.style.opacity = "1";
  }else{
    zip.href = "#";
    zip.style.pointerEvents = "none";
    zip.style.opacity = ".5";
  }
}

async function refreshLogSessions(){
  const j = await fetch("/api/log/sessions").then(r=>r.json());
  const s = j.sessions || [];
  el("log_sessions").innerHTML = s.slice(0,6).map(x=>`
    <div style="display:flex;justify-content:space-between;align-items:center;margin:6px 0;">
      <span>${x.sid}</span>
      <a class="btn" href="/api/log/zip?sid=${x.sid}">ZIP</a>
    </div>
  `).join("") || "<div>no sessions</div>";
}

function setupLogs(){
  el("log_start").onclick = async ()=>{
    await fetch("/api/log/start", {method:"POST"});
    await refreshLogStatus();
    await refreshLogSessions();
  };
  el("log_stop").onclick = async ()=>{
    await fetch("/api/log/stop", {method:"POST"});
    await refreshLogStatus();
    await refreshLogSessions();
  };
}

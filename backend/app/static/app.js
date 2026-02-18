//const el = (id) => document.getElementById(id);
const el = (id) => {
  const n = document.getElementById(id);
  if(!n) console.warn("[DOM] missing element id:", id);
  return n;
};

const exists = (id) => !!el(id);

const fmtV = (mv) => (mv == null ? "-" : (mv / 1000).toFixed(2) + " V");
const fmtA = (ma) => (ma == null ? "-" : (ma / 1000).toFixed(2) + " A");
const fmtC = (dC) => (dC == null ? "-" : (dC / 10).toFixed(1) + " °C");

function setText(id, txt){
  const e = document.getElementById(id);
  if(!e) return;
  e.textContent = txt ?? "";
}
function setHTML(id, html){
  const e = document.getElementById(id);
  if(!e) return;
  e.innerHTML = html ?? "";
}


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




function setupLights(){
  const host = el("lgt_ctrl");
  if(!host) return;

  // crea UI base (4 canali)
  host.innerHTML = `
    <div class="lgtGrid">
      ${[1,2,3,4].map(ch => `
        <div class="lgtChan" data-ch="${ch}">
          <div class="lgtTitle">CH${ch}</div>
          <input class="lgtSlider" type="range" min="0" max="1000" value="0" step="1" />
          <div class="lgtVal mono">0</div>
          <div class="lgtBtns">
            <button class="lgtOn">ON</button>
            <button class="lgtOff">OFF</button>
          </div>
        </div>
      `).join("")}
    </div>
  `;

  // bind handlers
  host.querySelectorAll(".lgtChan").forEach(card => {
    const ch = parseInt(card.getAttribute("data-ch"), 10);
    const slider = card.querySelector(".lgtSlider");
    const val = card.querySelector(".lgtVal");
    const btnOn = card.querySelector(".lgtOn");
    const btnOff = card.querySelector(".lgtOff");

    slider.addEventListener("input", () => { val.textContent = String(slider.value); });

    btnOn.addEventListener("click", () => sendLight(ch, "ON", parseInt(slider.value,10)));
    btnOff.addEventListener("click", () => sendLight(ch, "OFF", 0));

    // invio “al rilascio”
    slider.addEventListener("change", () => sendLight(ch, "ON", parseInt(slider.value,10)));
  });

  const btn = document.getElementById("lgt_cfg_toggle");
  const body = document.getElementById("lgt_cfg_body");
  if(btn && body){
    // default: config visibile
    let open = true;
    btn.addEventListener("click", () => {
      open = !open;
      body.classList.toggle("hidden", !open);
      body.style.display = open ? "" : "none";
      btn.textContent = open ? "▾" : "▸";
    });

    // se vuoi: dopo save chiudila automaticamente
    const save = document.getElementById("lgt_cfg_save");
    if(save){
      save.addEventListener("click", () => {
        // aspetta esito save nel tuo handler, ma intanto la richiudi:
        open = false;
        body.classList.add("hidden");
        body.style.display = "none";
        btn.textContent = "▸";
      });
    }
  }
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
  // ---------- Nodes ----------
  // const nodes = state.nodes || {};
  // let nhtml = `<table><tr><th>Node</th><th>Status</th><th>Last HB</th></tr>`;
  // for (const [k, v] of Object.entries(nodes)) {
  //   const on = v.online ? "ok" : "bad";
  //   nhtml += `<tr>
  //     <td>${k}</td>
  //     <td class="${on}">${v.online ? "ONLINE" : "OFFLINE"}</td>
  //     <td>${v.last_hb_ms ?? "-"}</td>
  //   </tr>`;
  // }
  // nhtml += `</table>`;
  // setHTML("nodes", nhtml);

  // // ---------- Pods ----------
  // const pods = state.pods || {};
  // let phtml = `<table><tr><th>Pod</th><th>Vbatt</th><th>Ibatt</th><th>Temp</th><th>BUS</th><th>VMOT</th></tr>`;
  // for (const pod of ["BAT1", "BAT2"]) {
  //   const d = pods[pod] || {};
  //   const bus = (d.BusConn === 1 || d.BusConn === "1") ? "ON" : "OFF";
  //   const vmot = (pod === "BAT1")
  //     ? vmotRow(d, ["Vmot1On", "Vmot2On", "Vmot3On"])
  //     : vmotRow(d, ["Vmot4On", "Vmot5On", "Vmot6On"]);

  //   phtml += `<tr>
  //     <td>${pod}</td>
  //     <td>${fmtV(d.Vbatt_mv)}</td>
  //     <td>${fmtA(d.Ibatt_ma)}</td>
  //     <td>${fmtC(d.Temp_dC)}</td>
  //     <td>${bus}</td>
  //     <td>${vmot}</td>
  //   </tr>`;
  // }
  // phtml += `</table>`;
  // setHTML("pods", phtml);

  // ---------- ESC ----------
  const esc = state.esc || {};
  let ehtml = `<table><tr><th>ID</th><th>RPM</th><th>Vin</th><th>Iin</th><th>Wh</th><th>Src</th></tr>`;
  const ids = Object.keys(esc).map(x => parseInt(x, 10)).sort((a, b) => a - b);
  for (const id of ids) {
    const d = esc[id] || {};
    ehtml += `<tr>
      <td>${id}</td>
      <td>${d.RPM ?? "-"}</td>
      <td>${fmtV(d.InVoltage_mv)}</td>
      <td>${fmtA(d.AvgInCur_ma)}</td>
      <td>${d.Wh_x10 != null ? (d.Wh_x10 / 10).toFixed(1) : "-"}</td>
      <td>${d.src ?? "-"}</td>
    </tr>`;
  }
  ehtml += `</table>`;
  setHTML("esc", ehtml);

  // ---------- Alarms ----------
  const aa = state.alarms_active || [];
  setHTML(
    "alarms_active",
    aa.length
      ? aa.map(a => `<div class="${a.sev >= 2 ? "bad" : "ok"}">[${sevLabel(a.sev)}] ${a.text ?? ""} <span class="mono">${a.ts_ms}</span></div>`).join("")
      : `<div class="ok">none</div>`
  );

  const hist = (state.alarms_history || []).slice(-10).reverse();
  setHTML(
    "alarms_hist",
    hist.length
      ? hist.map(a => `<div>[${sevLabel(a.sev)}] ${a.text ?? ""} <span class="mono">${a.ts_ms}</span></div>`).join("")
      : `<div class="ok">none</div>`
  );

  // ---------- Counters + last raw ----------
  //setText("last_raw", state.__last_raw || "");
 // setHTML("counters", `<div class="mono">${JSON.stringify(state.counters || {}, null, 2)}</div>`);

  // ---------- Power badges (dock) ----------
  setHTML("power_scada_badges", renderPowerScada(state));

  // ---------- Mission view elements (only if present) ----------
  const mb = document.getElementById("main_power_badges");
  const ms = document.getElementById("main_scada");
  if (mb) mb.innerHTML = renderPowerScada(state);
  if (ms) ms.innerHTML = scadaSvg(state);

  // Attitude readout + 3D
  const ar = document.getElementById("att_readout");
  if (ar) {
    const att = state.att || null;
    let roll = 0, pitch = 0, yaw = 0;

    if (att && (att.roll_deg != null || att.pitch_deg != null || att.yaw_deg != null)) {
      roll  = degToRad(att.roll_deg  || 0);
      pitch = degToRad(att.pitch_deg || 0);
      yaw   = degToRad(att.yaw_deg   || 0);
    } else {
      const t = (state.last_update_ms || 0) / 1000;
      roll  = Math.sin(t * 0.6) * 0.25;
      pitch = Math.sin(t * 0.4) * 0.18;
      yaw   = (t * 0.2);
    }

    if (typeof setRovAttitudeRad === "function") {
      setRovAttitudeRad(roll, pitch, yaw);
    }

    const r = (roll  * 180 / Math.PI).toFixed(1);
    const p = (pitch * 180 / Math.PI).toFixed(1);
    const y = (yaw   * 180 / Math.PI).toFixed(1);
    ar.textContent = `roll ${r}°  pitch ${p}°  yaw ${y}°`;
  }
}


let snapshot = null;

window.addEventListener("load", () => {
  try { init(); } catch (e) { console.error(e); }
});

async function init() {
  snapshot = await fetch("/api/state").then(r => r.json());
  setupTabs();
  renderWidgetsMenu();
  setupWidgetsMenu(); 
  applyWidgetVisibility();
  setupCollapseButtons();
  setupLights();
  
  await loadLightsCfg();
  el("lgt_cfg_save").onclick = saveLightsCfg;
  setupLightsConfigToggle();
  el("lgt_cfg_save").onclick = saveLightsCfg;

  setupLogs();
  await refreshLogStatus();
  await refreshLogSessions();
  render(snapshot);
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

let collapseWired = false;

function setupCollapseButtons(){
  if(collapseWired) return;
  collapseWired = true;

  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-collapse]");
    if(!b) return;

    // evita doppi click / bubbling strani
    e.preventDefault();
    e.stopPropagation();

    const card = b.closest(".card");
    if(!card) return;

    let body = card.querySelector(":scope > .cardBody");
    if(!body) body = card.querySelector(".cardBody");
    if(!body) return;

    const isHidden = body.classList.toggle("hidden");
    body.style.display = isHidden ? "none" : "";
    b.textContent = isHidden ? "▸" : "▾";
  }, true); // <- capture=true: prende il click prima di altri handler
}

function renderMainSlot(tab){
  setText("main_mode", tab.toUpperCase()); // se non esiste, non fa nulla

  const m = document.getElementById("missionWrap");
  const v = document.getElementById("videoWrap");
  const s = document.getElementById("sonarWrap");

  if(m) m.classList.toggle("hidden", tab !== "mission");
  if(v) v.classList.toggle("hidden", tab !== "video");
  if(s) s.classList.toggle("hidden", tab !== "sonar");

  if(tab === "mission"){
    ensure3D(); // se ti serve (ma attenzione a non reinizializzare)
  }
}


function renderMainMission(){
  const slot = document.getElementById("main_slot");
  if(!slot) return;

  slot.innerHTML = `
    <div class="missionWrap">
      <div class="missionTop">
        <div class="card missionSide">
          <div class="cardHead"><div class="cardTitle">Motori SX</div></div>
          <div class="cardBody"><div id="motors_left" class="motorsRings"></div></div>
        </div>

        <div class="card missionCenter">
          <div class="cardHead"><div class="cardTitle">ROV 3D</div></div>
          <div class="cardBody">
            <div id="rov3d" class="rov3d"></div>
            <div class="mono" id="att_readout" style="margin-top:8px;opacity:.85;">—</div>
          </div>
        </div>

        <div class="card missionSide">
          <div class="cardHead"><div class="cardTitle">Motori DX</div></div>
          <div class="cardBody"><div id="motors_right" class="motorsRings"></div></div>
        </div>
      </div>

      <div class="card missionBottom">
        <div class="cardHead"><div class="cardTitle">Power SCADA</div></div>
        <div class="cardBody">
          <div id="main_power_badges"></div>
          <div id="main_scada" style="margin-top:10px;"></div>
        </div>
      </div>
    </div>
  `;

  ensure3D();
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
  const btn = el("lgt_cfg_toggle");
  const wrap = el("lgt_cfg_body");
  if (!btn || !wrap) return;
  btn.onclick = () => wrap.classList.toggle("hidden");
}

let rov3d = {
  inited: false,
  scene: null,
  camera: null,
  renderer: null,
  model: null,
  anim: null,
};

function init3DOnce(){
  if(rov3d.inited) return;

  const host = document.getElementById("rov3d");
  if(!host){ console.warn("[3D] missing #rov3d"); return; }

  const w0 = host.clientWidth || 0;
const h0 = host.clientHeight || 0;
if (w0 < 10 || h0 < 10) {
  console.warn("[3D] host size too small", w0, h0);
  setTimeout(init3DOnce, 120);
  return;
}

const renderer = new THREE.WebGLRenderer({ antialias:true, alpha:false, powerPreference:"low-power" });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(w0, h0, false);
renderer.setClearColor(0x0b1220, 1);

// mount
host.innerHTML = "";
host.appendChild(renderer.domElement);
renderer.domElement.style.width = "100%";
renderer.domElement.style.height = "100%";
renderer.domElement.style.display = "block";

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, w0 / h0, 0.05, 100);
camera.position.set(0.8, 0.35, 1.2);
camera.lookAt(0,0,0);

  camera.position.set(0.8, 0.35, 1.2);
  camera.lookAt(0, 0, 0);

  // lights
  scene.add(new THREE.AmbientLight(0xffffff, 0.8));
  const dir = new THREE.DirectionalLight(0xffffff, 1.2);
  dir.position.set(2, 2, 2);
  scene.add(dir);

  // render loop
  const tick = () => {
    renderer.render(scene, camera);
    rov3d.anim = requestAnimationFrame(tick);
  };
  tick();

  // resize
  const onResize = () => {
    const r2 = host.getBoundingClientRect();
    if(r2.width < 10 || r2.height < 10) return;
    camera.aspect = r2.width / r2.height;
    camera.updateProjectionMatrix();
    renderer.setSize(r2.width, r2.height);
  };
  const ro = new ResizeObserver(() => {
    const w = host.clientWidth || 0;
    const h = host.clientHeight || 0;
    if (w < 10 || h < 10) return;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  });
  ro.observe(host);


  // store
  rov3d.inited = true;
  rov3d.scene = scene;
  rov3d.camera = camera;
  rov3d.renderer = renderer;

  // load model
  const loader = new GLTFLoader();
  loader.load(
    "/static/models/rov.glb",
    (gltf) => {
      const model = gltf.scene;

      // center + scale
      const box = new THREE.Box3().setFromObject(model);
      const size = new THREE.Vector3();
      const center = new THREE.Vector3();
      box.getSize(size);
      box.getCenter(center);

      model.position.sub(center);
      const maxDim = Math.max(size.x, size.y, size.z) || 1;
      const s = 1.0 / maxDim;
      model.scale.setScalar(s);

      scene.add(model);
      rov3d.model = model;

      console.log("[3D] model loaded, size:", size, "scale:", s);

      // fit camera to model
      const fov = camera.fov * (Math.PI / 180);
      let camZ = Math.abs(1 / (2 * Math.tan(fov / 2)));
      camZ *= 1.8;
      camera.position.set(0, 0.4, camZ);
      camera.lookAt(0, 0, 0);
      camera.updateProjectionMatrix();
    },
    undefined,
    (err) => console.error("[3D] load error", err)
  );
}

function setRovAttitudeRad(roll, pitch, yaw){
  if(!rov3d.model) return;
  // qui puoi cambiare ordine assi se serve
  rov3d.model.rotation.set(pitch || 0, yaw || 0, roll || 0);
}

function ensure3D(){
  const host = document.getElementById("rov3d");
  if(!host){ setTimeout(ensure3D, 100); return; }
  init3DOnce();
}

function degToRad(d){ return (d || 0) * Math.PI / 180; }

async function refreshLogStatus(){
  // Se i controlli log non sono presenti in pagina, non fare nulla
  if(!exists("log_status")) return;

  const j = await fetch("/api/log/status").then(r=>r.json());
  const enabled = !!j.enabled;
  const sid = j.sid || "-";

  el("log_status").textContent = `${enabled ? "ON" : "OFF"}  ${sid}`;

  const zip = el("log_zip");
  if(zip){
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
}

async function refreshLogSessions(){
  if(!exists("log_sessions")) return;

  const j = await fetch("/api/log/sessions").then(r=>r.json());
  const s = j.sessions || [];
  el("log_sessions").innerHTML = s.slice(0,8).map(x=>`
    <div style="display:flex;justify-content:space-between;align-items:center;margin:6px 0;">
      <span class="mono">${x.sid}</span>
      <a class="btn" href="/api/log/zip?sid=${x.sid}">ZIP</a>
    </div>
  `).join("") || "<div class='mono'>No sessions</div>";
}

function setupLogs(){
  // Se non hai i bottoni in pagina (come ora), non deve rompere la UI
  if(!exists("log_start") || !exists("log_stop")) return;

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

// --- bootstrap ---
window.addEventListener("DOMContentLoaded", () => {
  init().catch(err => {
    console.error("init failed:", err);
    const s = document.getElementById("status");
    if (s) s.textContent = "init error: " + (err?.message || err);
  });
});

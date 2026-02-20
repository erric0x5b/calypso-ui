import { el as domEl } from './utils.js';

export let lightsCfg = null;

export function parseIdsCsv(s) {
  return (s || "")
    .split(",")
    .map(x => x.trim())
    .filter(x => x.length)
    .map(x => parseInt(x, 10))
    .filter(x => Number.isFinite(x) && x > 0);
}

export async function loadLightsCfg() {
  lightsCfg = await fetch("/api/config/lights").then(r => r.json());
  renderLightsCfg();
  renderLightsCtrl();
  const st = domEl("lgt_cfg_status"); if(st) st.textContent = "loaded";
}

export function renderLightsCfg() {
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
  domEl("lgt_cfg").innerHTML = html;
}

export async function saveLightsCfg() {
  const cfg = { version: 1, channels: {} };
  for (const k of ["1", "2", "3", "4"]) {
    cfg.channels[k] = {
      name: (domEl(`lgt_name_${k}`).value || `CH${k}`),
      lamp_ids: Array.from(new Set(parseIdsCsv(domEl(`lgt_ids_${k}`).value))).sort((a, b) => a - b)
    };
  }
  const r = await fetch("/api/config/lights", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cfg)
  });
  if (!r.ok) {
    const t = await r.text();
    domEl("lgt_cfg_status").textContent = "save ERR";
    console.error("save cfg err", t);
    return;
  }
  domEl("lgt_cfg_status").textContent = "saved";
  lightsCfg = cfg;
  renderLightsCtrl();
}

export async function sendLightsChannel(ch, mode, dim) {
  const r = await fetch("/api/cmd/lights_channel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ch, mode, dim })
  });
  const j = await r.json();
  const a = domEl("lgt_ack");
  if (a) a.textContent = j.ok ? (`sent CmdId ${j.cmd_id} (CH${ch} → ${j.lamp_ids?.length || 0} lamps)`) : "send fail";
}

export function renderLightsCtrl() {
  let html = `<div class="lgtGrid">`;

  for (const k of ["1", "2", "3", "4"]) {
    const name = lightsCfg?.channels?.[k]?.name || `CH${k}`;

    html += `
      <div class="lgtCh">
        <div class="lgtChHead">
          <div class="lgtChName">${name}</div>
        </div>

        <div class="lgtSliderZone">
          <div class="lgtSliderWrap">
            <input id="lgt_dim_${k}" class="lgtSlider" type="range" min="0" max="1000" value="0">
          </div>
          <div class="lgtVal"><span id="lgt_val_${k}">0</span></div>
        </div>

        <div class="lgtBtns">
          <button id="lgt_on_${k}">ON</button>
          <button id="lgt_off_${k}">OFF</button>
        </div>
      </div>`;
  }

  html += `</div>`;
  domEl("lgt_ctrl").innerHTML = html;

  for (const k of ["1", "2", "3", "4"]) {
    const slider = domEl(`lgt_dim_${k}`);
    const label = domEl(`lgt_val_${k}`);
    const btnOn = domEl(`lgt_on_${k}`);
    const btnOff = domEl(`lgt_off_${k}`);

    if (!slider || !label || !btnOn || !btnOff) continue;

    slider.addEventListener("input", () => label.textContent = slider.value);

    btnOn.onclick  = () => sendLightsChannel(parseInt(k, 10), "ON",  parseInt(slider.value, 10));
    btnOff.onclick = () => sendLightsChannel(parseInt(k, 10), "OFF", 0);

    slider.addEventListener("change", () =>
      sendLightsChannel(parseInt(k, 10), "ON", parseInt(slider.value, 10))
    );
  }
}

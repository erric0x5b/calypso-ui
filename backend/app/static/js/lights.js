import { el as domEl } from './utils.js?v=16';

export let lightsCfg = null;
const ACK_TIMEOUT_MS = 2000;
const ACK_POLL_MS = 120;

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
  const st = domEl("lgt_cfg_status"); if (st) st.textContent = "loaded";
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitAck(cmdId, timeoutMs = ACK_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await fetch(`/api/cmd/ack?cmd_id=${encodeURIComponent(cmdId)}`, { cache: "no-store" });
    const j = await r.json();
    if (j?.ok && j.status === "ack" && j.ack) return j.ack;
    await sleep(ACK_POLL_MS);
  }
  return null;
}

export async function sendLightsChannel(ch, mode, dim) {
  const r = await fetch("/api/cmd/lights_channel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ch, mode, dim, dst: "ALL" })
  });
  const j = await r.json();
  const a = domEl("lgt_ack");
  if (!a) return;
  if (!j.ok) {
    a.textContent = "send fail";
    return;
  }

  a.textContent = `sent CmdId ${j.cmd_id} (CH${ch} -> ${j.lamp_ids?.length || 0} lamps)`;
  if (j.await_ack === false) {
    a.textContent = `forwarded CmdId ${j.cmd_id} (CH${ch} -> ${j.lamp_ids?.length || 0} lamps)`;
    return;
  }

  const ack = await waitAck(j.cmd_id).catch(() => null);
  if (!ack) {
    a.textContent = `CmdId ${j.cmd_id}: ACK timeout`;
    return;
  }

  const ok = Number(ack.ok) === 1;
  const txt = ack.text ? ` (${ack.text})` : "";
  const err = ack.err != null ? ` err:${ack.err}` : "";
  a.textContent = ok
    ? `ACK OK CmdId ${j.cmd_id}${txt}`
    : `ACK ERR CmdId ${j.cmd_id}${err}${txt}`;
}

function sendByDim(ch, dim) {
  if (!Number.isFinite(dim) || dim <= 0) return sendLightsChannel(ch, "OFF", 0);
  return sendLightsChannel(ch, "ON", dim);
}

export function renderLightsCtrl() {
  let html = `<div class="lgtGrid">`;

  for (const k of ["1", "2", "3", "4"]) {
    const name = lightsCfg?.channels?.[k]?.name || `CH${k}`;

    html += `
      <div class="lgtCh" id="lgt_ch_${k}" data-ch="${k}">
        <div class="lgtChHead">
          <div class="lgtChName">${name}</div>
        </div>

        <div class="lgtSliderZone">
          <div class="lgtSliderWrap">
            <input id="lgt_dim_${k}" class="lgtSlider" type="range" min="0" max="1000" value="0">
          </div>
          <div class="lgtVal"><span id="lgt_val_${k}">0</span></div>
        </div>

        <div class="lgtActions">
          <div class="lgtPreset">
            <select id="lgt_preset_${k}">
              <option value="">Preset...</option>
              <option value="250">LOW</option>
              <option value="600">MED</option>
              <option value="1000">HIGH</option>
            </select>
          </div>
        </div>
      </div>`;
  }

  html += `</div>`;
  domEl("lgt_ctrl").innerHTML = html;

  for (const k of ["1", "2", "3", "4"]) {
    const slider = domEl(`lgt_dim_${k}`);
    const label = domEl(`lgt_val_${k}`);
    const preset = domEl(`lgt_preset_${k}`);

    if (!slider || !label || !preset) continue;

    let sendTimer = null;
    const flushSlider = () => {
      const v = parseInt(slider.value || "0", 10);
      sendByDim(parseInt(k, 10), v);
    };

    slider.addEventListener("input", () => {
      label.textContent = slider.value;
      if (sendTimer) clearTimeout(sendTimer);
      sendTimer = setTimeout(() => {
        sendTimer = null;
        flushSlider();
      }, 120);
    });

    slider.addEventListener("change", () => {
      if (sendTimer) {
        clearTimeout(sendTimer);
        sendTimer = null;
      }
      flushSlider();
    });

    preset.addEventListener("change", () => {
      const v = parseInt(preset.value || "", 10);
      if (!Number.isFinite(v)) return;
      if (sendTimer) {
        clearTimeout(sendTimer);
        sendTimer = null;
      }
      slider.value = String(v);
      label.textContent = slider.value;
      sendByDim(parseInt(k, 10), v);
      preset.value = "";
    });
  }
}

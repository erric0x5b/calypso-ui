import * as utils from './utils.js';
import { renderPowerScada, scadaSvg } from './power.js';
import * as lights from './lights.js';
import * as thrusters from './thrusters.js';
import * as video from './video.js';
import * as th3 from './three3d.js';
import * as logs from './logs.js';

let snapshot = null;

function render(state) {
    const esc = state.esc || {};
    let ehtml = `<table><tr><th>ID</th><th>RPM</th><th>Vin</th><th>Iin</th><th>Wh</th><th>Src</th></tr>`;
    const ids = Object.keys(esc).map(x => parseInt(x, 10)).sort((a, b) => a - b);
    for (const id of ids) {
        const d = esc[id] || {};
        ehtml += `<tr>
      <td>${id}</td>
      <td>${d.RPM ?? "-"}</td>
      <td>${utils.fmtV(d.InVoltage_mv)}</td>
      <td>${utils.fmtA(d.AvgInCur_ma)}</td>
      <td>${d.Wh_x10 != null ? (d.Wh_x10 / 10).toFixed(1) : "-"}</td>
      <td>${d.src ?? "-"}</td>
    </tr>`;
    }
    ehtml += `</table>`;
    utils.setHTML("esc", ehtml);

    const aa = state.alarms_active || [];
    utils.setHTML("alarms_active", aa.length ? aa.map(a => `<div class="${a.sev >= 2 ? "bad" : "ok"}">[${utils.sevLabel(a.sev)}] ${a.text ?? ""} <span class="mono">${a.ts_ms}</span></div>`).join("") : `<div class="ok">none</div>`);

    const hist = (state.alarms_history || []).slice(-10).reverse();
    utils.setHTML("alarms_hist", hist.length ? hist.map(a => `<div>[${utils.sevLabel(a.sev)}] ${a.text ?? ""} <span class="mono">${a.ts_ms}</span></div>`).join("") : `<div class="ok">none</div>`);

    utils.setHTML("power_scada_badges", renderPowerScada(state));
    const mb = document.getElementById("main_power_badges"); const ms = document.getElementById("main_scada");
    if (mb) mb.innerHTML = renderPowerScada(state);
    if (ms) ms.innerHTML = scadaSvg(state);

    const ar = document.getElementById("att_readout");
    if (ar) {
        const att = state.att || null; let roll = 0, pitch = 0, yaw = 0;
        if (att && (att.roll_deg != null || att.pitch_deg != null || att.yaw_deg != null)) {
            roll = th3.degToRad(att.roll_deg || 0); pitch = th3.degToRad(att.pitch_deg || 0); yaw = th3.degToRad(att.yaw_deg || 0);
        } else { const t = (state.last_update_ms || 0) / 1000; roll = Math.sin(t * 0.6) * 0.25; pitch = Math.sin(t * 0.4) * 0.18; yaw = (t * 0.2); }
        if (typeof th3.setRovAttitudeRad === 'function') th3.setRovAttitudeRad(roll, pitch, yaw);
        const r = (roll * 180 / Math.PI).toFixed(1); const p = (pitch * 180 / Math.PI).toFixed(1); const y = (yaw * 180 / Math.PI).toFixed(1);
        ar.textContent = `roll ${r}°  pitch ${p}°  yaw ${y}°`;
    }

    thrusters.renderMotorsRings(state);
}

async function init() {
    snapshot = await fetch("/api/state").then(r => r.json());
    setupTabs();
    video.setupVideo();
    renderWidgetsMenu();
    setupWidgetsMenu();
    applyWidgetVisibility();
    setupCollapseButtons();
    lights.setupLights && lights.setupLights();
    await lights.loadLightsCfg().catch(() => { });
    const saveBtn = document.getElementById("lgt_cfg_save"); if (saveBtn) saveBtn.onclick = lights.saveLightsCfg;
    setupLightsConfigToggle();
    logs.setupLogs();
    await logs.refreshLogStatus().catch(() => { });
    await logs.refreshLogSessions().catch(() => { });
    render(snapshot);

    const wsProto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${wsProto}://${location.host}/ws`);
    ws.onopen = () => { const s = utils.el("status"); if (s) s.textContent = "WS connected"; };
    ws.onclose = () => { const s = utils.el("status"); if (s) s.textContent = "WS closed"; };
    ws.onerror = () => { const s = utils.el("status"); if (s) s.textContent = "WS error"; };
    ws.onmessage = (ev) => {
        try {
            const msg = JSON.parse(ev.data);
            if (msg.type === "udp" || msg.type === "alarm" || msg.type === "update") {
                const lastRaw = msg.raw;
                fetch("/api/state").then(r => r.json()).then(s => { snapshot = s; if (lastRaw) snapshot.__last_raw = lastRaw; render(snapshot); });
            }
            if (msg.type === "sonar") { if (window.sonarPing360) window.sonarPing360.apply(msg); return; }
        } catch (e) { }
    };
}

// --- UI / widgets related functions (kept here for clarity) ---
const WIDGETS = [{ id: "alarms", title: "Allarmi" }, { id: "power", title: "Power" }, { id: "lights", title: "Luci" }, { id: "motors", title: "Motori" }, { id: "missionlog", title: "Mission Log" },];

function loadUiPrefs() { try { return JSON.parse(localStorage.getItem("calypso_ui_prefs") || "{}"); } catch (e) { return {}; } }
function saveUiPrefs(p) { localStorage.setItem("calypso_ui_prefs", JSON.stringify(p)); }
let uiPrefs = loadUiPrefs(); uiPrefs.visible ??= Object.fromEntries(WIDGETS.map(w => [w.id, true])); uiPrefs.collapsed ??= {}; uiPrefs.mainTab ??= "mission";

function applyWidgetVisibility() { for (const w of WIDGETS) { const card = document.querySelector(`[data-widget="${w.id}"]`); if (!card) continue; card.style.display = uiPrefs.visible[w.id] ? "" : "none"; const body = card.querySelector(":scope > .cardBody") || card.querySelector('.cardBody'); const col = !!uiPrefs.collapsed[w.id]; if (body) body.style.display = col ? "none" : ""; } }

function renderWidgetsMenu() { const panel = utils.el("widgets_panel"); if (!panel) return; panel.innerHTML = WIDGETS.map(w => `<label><input type="checkbox" ${uiPrefs.visible[w.id] ? "checked" : ""} data-wid="${w.id}"><span>${w.title}</span></label>`).join(""); panel.querySelectorAll("input[type=checkbox]").forEach(cb => { cb.addEventListener('change', () => { uiPrefs.visible[cb.dataset.wid] = cb.checked; saveUiPrefs(uiPrefs); applyWidgetVisibility(); }); }); }

function setupWidgetsMenu() { const btn = document.getElementById("btn_widgets"); if (btn) btn.onclick = () => { const p = utils.el('widgets_panel'); p.classList.toggle('hidden'); }; document.addEventListener('click', (e) => { const p = utils.el('widgets_panel'); if (!p) return; if (p.classList.contains('hidden')) return; if (e.target.id === 'btn_widgets' || p.contains(e.target)) return; p.classList.add('hidden'); }); }

let collapseWired = false;
function setupCollapseButtons() { if (collapseWired) return; collapseWired = true; document.addEventListener('click', (e) => { const b = e.target.closest('[data-collapse]'); if (!b) return; e.preventDefault(); e.stopPropagation(); const card = b.closest('.card'); if (!card) return; let body = card.querySelector(':scope > .cardBody') || card.querySelector('.cardBody'); if (!body) return; const isHidden = body.classList.toggle('hidden'); body.style.display = isHidden ? 'none' : ''; b.textContent = isHidden ? '▸' : '▾'; }, true); }

function renderMainSlot(tab) { utils.setText('main_mode', tab.toUpperCase()); const mw = utils.el('missionWrap'); const vw = utils.el('videoWrap'); const sw = utils.el('sonarWrap'); if (mw) mw.classList.toggle('hidden', tab !== 'mission'); if (vw) vw.classList.toggle('hidden', tab !== 'video'); if (sw) sw.classList.toggle('hidden', tab !== 'sonar'); if (tab === 'mission') { th3.ensure3D(); return; } if (tab === 'video') { video.mountVideo(video.videoState.kind, video.videoState.url); return; } }

function renderMainMission() { const slot = document.getElementById('main_slot'); if (!slot) return; slot.innerHTML = `...`; th3.ensure3D(); }

function setupTabs() { document.querySelectorAll('.tab').forEach(t => { t.addEventListener('click', () => { document.querySelectorAll('.tab').forEach(x => x.classList.remove('active')); t.classList.add('active'); uiPrefs.mainTab = t.dataset.tab; saveUiPrefs(uiPrefs); renderMainSlot(uiPrefs.mainTab); }); }); const cur = uiPrefs.mainTab || 'mission'; document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x.dataset.tab === cur)); renderMainSlot(cur); }

function setupLightsConfigToggle() { const btn = utils.el('lgt_cfg_toggle'); const wrap = utils.el('lgt_cfg_body'); if (!btn || !wrap) return; btn.onclick = () => wrap.classList.toggle('hidden'); }

window.addEventListener('load', () => { try { init(); } catch (e) { console.error(e); } });

window.addEventListener('DOMContentLoaded', () => { init().catch(err => { console.error('init failed:', err); const s = document.getElementById('status'); if (s) s.textContent = 'init error: ' + (err?.message || err); }); });

export { render, init };

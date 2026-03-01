import * as utils from './utils.js';
import { renderPowerScada, scadaSvg } from './power.js';
import * as lights from './lights.js';
import * as thrusters from './thrusters.js';
import * as video from './video.js';
import * as th3 from './three3d.js';
import * as logs from './logs.js';

let snapshot = null;
let missionRefreshTimer = null;
let missionTabWired = false;
let missionCurrentSid = null;
let missionMetaAppliedSid = null;

const ALARM_GUIDE_BY_ID = {
    9001: {
        label: "NODE_OFFLINE",
        meaning: "Nodo offline: heartbeat assente oltre la soglia OFFLINE_MS.",
        action: "Controlla alimentazione nodo, link comunicazione e riavvio modulo."
    },
};

const ALARM_GUIDE_BY_TEXT = [
    {
        rx: /BUSCONN|BUS OFF|BUS OFFLINE/i,
        label: "BusConn OFF",
        meaning: "POD online ma non agganciato al bus di potenza.",
        action: "Verifica contattori, consenso parallelo e comandi di connessione bus."
    },
    {
        rx: /\bDV\b|DELTA.?V|D_V|DVMV|DV_THR/i,
        label: "dV fuori soglia",
        meaning: "Differenza tensione tra POD oltre soglia.",
        action: "Non forzare parallelo; equalizza batterie e ricontrolla cablaggio."
    },
    {
        rx: /ESC|VMOT|MOTOR|THR/i,
        label: "ESC/Motore fault",
        meaning: "Anomalia su ESC o linea motore.",
        action: "Riduci carico motori, identifica canale e controlla termica/corrente."
    },
    {
        rx: /VBUS|VOLT|LOW|UNDERVOLT|OVERVOLT/i,
        label: "VBUS anomalo",
        meaning: "Tensione bus fuori range o instabile.",
        action: "Controlla stato POD, carico, cavi potenza e protezioni."
    },
];

function resolveAlarmGuide(alarm) {
    const idNum = Number(alarm?.id);
    if (Number.isFinite(idNum) && ALARM_GUIDE_BY_ID[idNum]) {
        return ALARM_GUIDE_BY_ID[idNum];
    }

    const txt = String(alarm?.text || "");
    for (const rule of ALARM_GUIDE_BY_TEXT) {
        if (rule.rx.test(txt)) return rule;
    }
    return null;
}

function renderHelpAlarmLinks(state) {
    const box = document.getElementById("help_alarm_links");
    if (!box) return;

    const active = Array.isArray(state?.alarms_active) ? state.alarms_active : [];
    if (!active.length) {
        box.innerHTML = "Nessun allarme attivo.";
        return;
    }

    const rows = active.map((a) => {
        const g = resolveAlarmGuide(a);
        const sev = utils.sevLabel(a?.sev);
        const idTxt = (a?.id == null ? "-" : String(a.id));
        const txt = String(a?.text || "");
        const base = `<div><b>[${sev}] ID ${idTxt}</b> ${txt || "-"}</div>`;
        if (!g) {
            return `${base}<div style="opacity:.85;">Azione: verifica scheda Allarmi e log firmware (ID non mappato).</div>`;
        }
        return `${base}<div style="opacity:.85;">${g.label}: ${g.meaning}</div><div style="opacity:.95;">Azione: ${g.action}</div>`;
    });
    box.innerHTML = rows.join("<hr style=\"border:0;border-top:1px solid rgba(255,255,255,.08);margin:8px 0;\">");
}

function formatEscValue(key, value) {
    if (value == null) return "-";
    if (typeof value === "number") {
        if (key.endsWith("_mv")) return utils.fmtV(value);
        if (key.endsWith("_ma")) return utils.fmtA(value);
        if (key.endsWith("_dC")) return utils.fmtC(value);
        if (key === "Wh_x10") return (value / 10).toFixed(1);
    }
    return String(value);
}

function isMotorAlarm(a) {
    const txt = String(a?.text || "").toUpperCase();
    const src = String(a?.src || "").toUpperCase();
    return (
        src.startsWith("ESC") ||
        txt.includes("ESC") ||
        txt.includes("MOT") ||
        txt.includes("VMOT") ||
        txt.includes("THR") ||
        txt.includes("TH")
    );
}

function buildMotorErrorsHtml(state, escIds) {
    const esc = state.esc || {};
    const errs = [];

    for (const id of escIds) {
        const d = esc[id] || {};
        const fault = d.Fault ?? d.FaultCode ?? d.Error ?? d.Err;
        if (fault != null && Number(fault) !== 0) {
            errs.push(`ESC ${id}: fault ${fault}`);
        }
    }

    const activeMotorAlarms = (state.alarms_active || []).filter(isMotorAlarm);
    for (const a of activeMotorAlarms) {
        errs.push(`ALM [${utils.sevLabel(a.sev)}] ${a.text ?? ""}`);
    }

    if (!errs.length) {
        return `<div style="margin-top:8px;" class="ok"><b>Errori Motori:</b> none</div>`;
    }

    return `<div style="margin-top:8px;">
      <b class="bad">Errori Motori (${errs.length})</b>
      <div style="margin-top:4px;">${errs.map(e => `<div class="bad">${e}</div>`).join("")}</div>
    </div>`;
}

function escapeHtml(s) {
    return String(s ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}

function sidToDate(sid) {
    const m = /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})$/.exec(String(sid || ""));
    if (!m) return null;
    const [_, y, mo, d, h, mi, se] = m;
    return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(se));
}

function fmtDuration(totalSec) {
    const sec = Math.max(0, Number(totalSec || 0));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function fmtBytes(n) {
    const x = Number(n);
    if (!Number.isFinite(x) || x < 0) return "-";
    if (x < 1024) return `${x} B`;
    if (x < 1024 * 1024) return `${(x / 1024).toFixed(1)} KB`;
    return `${(x / (1024 * 1024)).toFixed(2)} MB`;
}

function missionElapsedSecFromSid(sid) {
    const dt = sidToDate(sid);
    if (!dt) return null;
    return Math.max(0, Math.floor((Date.now() - dt.getTime()) / 1000));
}

function formatMissionEventLine(evt) {
    const ts = evt?.ts_ms != null ? `ts:${evt.ts_ms}` : "ts:-";
    const mt = evt?.mission_time != null ? ` mission:${evt.mission_time}` : "";
    const lat = evt?.lat != null ? ` lat:${Number(evt.lat).toFixed(6)}` : "";
    const lon = evt?.lon != null ? ` lon:${Number(evt.lon).toFixed(6)}` : "";
    const hdg = evt?.heading != null ? ` hdg:${Number(evt.heading).toFixed(1)}` : "";
    const dep = evt?.depth != null ? ` depth:${Number(evt.depth).toFixed(2)}` : "";
    const typ = escapeHtml(evt?.type || "EVENT");
    const text = escapeHtml(evt?.text || evt?.raw || "-");
    return `<div><b>${typ}</b> ${text} <span style="opacity:.75;">(${ts}${mt}${lat}${lon}${hdg}${dep})</span></div>`;
}

function missionMetaFormNodes() {
    return {
        title: document.getElementById("mission_meta_title"),
        place: document.getElementById("mission_meta_place"),
        objective: document.getElementById("mission_meta_objective"),
        operator: document.getElementById("mission_meta_operator"),
        date: document.getElementById("mission_meta_date"),
    };
}

function missionMetaReadForm() {
    const f = missionMetaFormNodes();
    return {
        title: String(f.title?.value || "").trim(),
        place: String(f.place?.value || "").trim(),
        objective: String(f.objective?.value || "").trim(),
        operator: String(f.operator?.value || "").trim(),
        date: String(f.date?.value || "").trim(),
    };
}

function missionMetaWriteForm(meta, sid) {
    const f = missionMetaFormNodes();
    const activeId = document.activeElement?.id || "";
    const editing = activeId.startsWith("mission_meta_");
    if (editing && missionMetaAppliedSid === sid) return;

    const m = meta || {};
    if (f.title) f.title.value = String(m.title || "");
    if (f.place) f.place.value = String(m.place || "");
    if (f.objective) f.objective.value = String(m.objective || "");
    if (f.operator) f.operator.value = String(m.operator || "");
    if (f.date) f.date.value = String(m.date || "");
    missionMetaAppliedSid = sid || null;
}

function renderMissionManifestBlock(data) {
    const box = document.getElementById("mission_manifest");
    if (!box) return;
    if (!data?.ok || !data?.manifest) {
        box.textContent = "Nessun manifest disponibile.";
        return;
    }
    const m = data.manifest;
    const files = m.files || {};
    const sizes = data.sizes || {};
    const mm = m.mission || {};
    const rows = [
        `<div><b>SID:</b> ${escapeHtml(m.sid || "-")}</div>`,
        `<div><b>Stato:</b> ${data.logging_enabled ? "LOG ON" : "LOG OFF"}${data.is_current ? " (sessione corrente)" : ""}</div>`,
        `<div><b>Creato (SID):</b> ${escapeHtml(m.created_utc || "-")}</div>`,
        `<div><b>Titolo:</b> ${escapeHtml(mm.title || "-")}</div>`,
        `<div><b>Luogo:</b> ${escapeHtml(mm.place || "-")}</div>`,
        `<div><b>Oggetto:</b> ${escapeHtml(mm.objective || "-")}</div>`,
        `<div><b>Operatore:</b> ${escapeHtml(mm.operator || "-")}</div>`,
        `<div><b>Data:</b> ${escapeHtml(mm.date || "-")}</div>`,
        `<div><b>Telemetria:</b> ${escapeHtml(files.telemetry || "-")} (${fmtBytes(sizes.telemetry)})</div>`,
        `<div><b>Allarmi:</b> ${escapeHtml(files.alarms || "-")} (${fmtBytes(sizes.alarms)})</div>`,
        `<div><b>Eventi:</b> ${escapeHtml(files.events || "-")} (${fmtBytes(sizes.events)})</div>`,
    ];
    box.innerHTML = rows.join("");
}

function renderMissionEventsBlock(data) {
    const box = document.getElementById("mission_events");
    if (!box) return;
    const arr = data?.events || [];
    if (!arr.length) {
        box.textContent = "Nessun evento registrato.";
        return;
    }
    box.innerHTML = arr.map(formatMissionEventLine).join("");
}

function renderMissionTimePill(data) {
    const pill = document.getElementById("mission_time_pill");
    if (!pill) return;
    const sid = data?.manifest?.sid || data?.sid || snapshot?.logging?.sid || null;
    const sec = missionElapsedSecFromSid(sid);
    pill.textContent = sec == null ? "--:--:--" : fmtDuration(sec);
}

async function refreshMissionTab() {
    const [manifest, events] = await Promise.all([
        fetch("/api/log/manifest").then(r => r.json()).catch(() => ({ ok: false })),
        fetch("/api/log/events_tail?limit=12").then(r => r.json()).catch(() => ({ ok: false, events: [] })),
    ]);

    missionCurrentSid = manifest?.manifest?.sid || events?.sid || snapshot?.logging?.sid || null;
    renderMissionManifestBlock(manifest);
    missionMetaWriteForm(manifest?.manifest?.mission || {}, missionCurrentSid);
    renderMissionEventsBlock(events);
    renderMissionTimePill(manifest);
}

function setupMissionTab() {
    if (missionTabWired) return;
    missionTabWired = true;

    const metaBtn = document.getElementById("mission_meta_save");
    const metaAck = document.getElementById("mission_meta_ack");
    const btn = document.getElementById("mission_event_add");
    const input = document.getElementById("mission_event_text");
    const ack = document.getElementById("mission_event_ack");

    const saveMeta = async () => {
        try {
            const mission = missionMetaReadForm();
            await logs.apiPost("/api/log/manifest_meta", {
                sid: missionCurrentSid,
                mission,
            });
            if (metaAck) metaAck.textContent = "Metadata missione salvati.";
            await refreshMissionTab();
        } catch (e) {
            if (metaAck) metaAck.textContent = e?.message || "Errore salvataggio metadata";
        }
    };

    const send = async () => {
        const text = String(input?.value || "").trim();
        if (!text) return;
        try {
            await logs.apiPost("/api/log/event", { type: "NOTE", text });
            if (input) input.value = "";
            if (ack) ack.textContent = "Evento salvato.";
            await refreshMissionTab();
        } catch (e) {
            if (ack) ack.textContent = e?.message || "Errore salvataggio evento";
        }
    };

    if (metaBtn) metaBtn.onclick = saveMeta;

    if (btn) btn.onclick = send;
    if (input) {
        input.addEventListener("keydown", (ev) => {
            if (ev.key === "Enter") send();
        });
    }

    if (!missionRefreshTimer) {
        missionRefreshTimer = setInterval(() => {
            refreshMissionTab().catch(() => { });
        }, 3000);
    }
}

function render(state) {
    const esc = state.esc || {};
    const ids = Object.keys(esc).map(x => parseInt(x, 10)).filter(Number.isFinite).sort((a, b) => a - b);
    const preferred = [
        "RPM", "Duty_x1000", "InVoltage_mv", "AvgInCur_ma", "TempMos_dC", "TempMotor_dC",
        "Wh_x10", "Tach", "Fault", "src", "ts_ms"
    ];
    const keySet = new Set();
    for (const id of ids) {
        const d = esc[id] || {};
        Object.keys(d).forEach(k => keySet.add(k));
    }
    const extra = [...keySet].filter(k => !preferred.includes(k)).sort((a, b) => a.localeCompare(b));
    const keys = preferred.filter(k => keySet.has(k)).concat(extra);

    let ehtml = `<table><tr><th>Campo</th>`;
    for (const id of ids) ehtml += `<th>ESC ${id}</th>`;
    ehtml += `</tr>`;

    if (!ids.length) {
        ehtml += `<tr><td colspan="2">No ESC data</td></tr>`;
    } else {
        for (const key of keys) {
            ehtml += `<tr><td>${key}</td>`;
            for (const id of ids) {
                const d = esc[id] || {};
                ehtml += `<td>${formatEscValue(key, d[key])}</td>`;
            }
            ehtml += `</tr>`;
        }
    }
    ehtml += `</table>`;
    ehtml += buildMotorErrorsHtml(state, ids);
    utils.setHTML("esc", ehtml);

    const aa = state.alarms_active || [];
    utils.setHTML("alarms_active", aa.length ? aa.map(a => `<div class="${a.sev >= 2 ? "bad" : "ok"}">[${utils.sevLabel(a.sev)}] ${a.text ?? ""} <span class="mono">${a.ts_ms}</span></div>`).join("") : `<div class="ok">none</div>`);

    const hist = (state.alarms_history || []).slice(-10).reverse();
    utils.setHTML("alarms_hist", hist.length ? hist.map(a => `<div>[${utils.sevLabel(a.sev)}] ${a.text ?? ""} <span class="mono">${a.ts_ms}</span></div>`).join("") : `<div class="ok">none</div>`);
    renderHelpAlarmLinks(state);

    utils.setHTML("power_scada_badges", renderPowerScada(state));
    const mb = document.getElementById("main_power_badges");
    const ms = document.getElementById("main_scada");

    if (mb) mb.innerHTML = renderPowerScada(state);
    if (ms) ms.innerHTML = scadaSvg(state);

    const ar = document.getElementById("att_readout");
    if (ar) {
        const att = state.att || null;
        let roll = 0, pitch = 0, yaw = 0;

        //console.log("att raw deg:", att?.roll_deg, att?.pitch_deg, att?.yaw_deg);
        //console.log("degToRad test 12:", th3.degToRad(12));

        if (att && (att.roll_deg != null || att.pitch_deg != null || att.yaw_deg != null)) {
            roll = th3.degToRad(att.roll_deg || 0);
            pitch = th3.degToRad(att.pitch_deg || 0);
            yaw = th3.degToRad(att.yaw_deg || 0);
        } else {
            const t = (state.last_update_ms || 0) / 1000;
            roll = Math.sin(t * 0.6) * 0.25;
            pitch = Math.sin(t * 0.4) * 0.18; yaw = (t * 0.2);
        }
        if (typeof th3.setRovAttitudeRad === 'function')
            th3.setRovAttitudeRad(roll, pitch, yaw);
        const r = (roll * 180 / Math.PI).toFixed(1);
        const p = (pitch * 180 / Math.PI).toFixed(1);
        const y = (yaw * 180 / Math.PI).toFixed(1);

        const depth = state.nav?.depth_m;
        const d = (depth == null) ? "-" : depth.toFixed(1) + " m";

        const hdg = state.nav?.heading_deg;
        const h = (hdg == null) ? "-" : hdg.toFixed(0) + "°";

        ar.textContent = `roll ${r}°  pitch ${p}°  heading ${h}  depth ${d}`;

        //console.log("roll rad:", roll, "roll deg shown:", (roll*180/Math.PI));

    }

    thrusters.renderMotorsRingsAdvanced(state);
}

async function init() {
    snapshot = await fetch("/api/state").then(r => r.json());
    setupTabs();
    setupMissionTab();
    video.setupVideo();
    setupHelpPanel();
    renderWidgetsMenu();
    setupWidgetsMenu();
    applyWidgetVisibility();
    setupCollapseButtons();

    lights.setupLights && lights.setupLights();
    await lights.loadLightsCfg().catch(() => { });

    const saveBtn = document.getElementById("lgt_cfg_save");
    if (saveBtn)
        saveBtn.onclick = lights.saveLightsCfg;
    setupLightsConfigToggle();

    logs.setupLogs();
    await logs.refreshLogStatus().catch(() => { });
    await logs.refreshLogSessions().catch(() => { });
    await refreshMissionTab().catch(() => { });
    render(snapshot);

    const wsProto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${wsProto}://${location.host}/ws`);

    ws.onopen = () => { const s = utils.el("status"); if (s) s.textContent = "WS connected"; };
    ws.onclose = () => { const s = utils.el("status"); if (s) s.textContent = "WS closed"; };
    ws.onerror = () => { const s = utils.el("status"); if (s) s.textContent = "WS error"; };

    // --- WS -> refresh state (throttled) ---
    //let snapshot = null;

    let fetchInFlight = false;
    let fetchScheduled = false;
    let lastFetchMs = 0;
    const MIN_FETCH_INTERVAL_MS = 150; // ~6.6Hz (metti 100 se vuoi ~10Hz)

    async function refreshState(lastRaw) {
        // se c’è già una fetch in corso, schedula un refresh dopo
        if (fetchInFlight) {
            fetchScheduled = true;
            return;
        }

        const now = performance.now();
        const dt = now - lastFetchMs;
        if (dt < MIN_FETCH_INTERVAL_MS) {
            // troppo presto: schedula un refresh quando scade l’intervallo
            if (!fetchScheduled) {
                fetchScheduled = true;
                setTimeout(() => {
                    fetchScheduled = false;
                    refreshState(lastRaw);
                }, MIN_FETCH_INTERVAL_MS - dt);
            }
            return;
        }

        fetchInFlight = true;
        lastFetchMs = now;

        try {
            const r = await fetch("/api/state", { cache: "no-store" });
            const s = await r.json();
            snapshot = s;
            if (lastRaw) snapshot.__last_raw = lastRaw;
            render(snapshot);
        } catch (e) {
            console.warn("Failed to fetch /api/state", e);
        } finally {
            fetchInFlight = false;
            // se durante la fetch è arrivato altro, fai un refresh subito (ma sempre throttled)
            if (fetchScheduled) {
                fetchScheduled = false;
                refreshState();
            }
        }
    }

    ws.onmessage = (ev) => {
        try {
            const msg = JSON.parse(ev.data);

            if (msg.type === "state") {
                snapshot = snapshot || {};
                if (msg.thr) snapshot.thr = msg.thr;
                if (msg.att) snapshot.att = msg.att;
                if (msg.nav) snapshot.nav = msg.nav;
                requestRender();
                return;
                }

            if (msg.type === "sonar") {
                if (window.sonarPing360) window.sonarPing360.apply(msg);
                return;
            }

            if (msg.type === "udp" || msg.type === "alarm") {
                refreshState(msg.raw).then(() => requestRender());
                }
        } catch (e) {
            // ignora pacchetti non JSON
        }
    };
}

let renderScheduled = false;
let lastRender = 0;
const MIN_RENDER_MS = 80; // ~12.5 FPS (puoi 100ms=10fps)

function requestRender() {
  if (renderScheduled) return;
  const now = performance.now();
  const dt = now - lastRender;
  const delay = dt >= MIN_RENDER_MS ? 0 : (MIN_RENDER_MS - dt);

  renderScheduled = true;
  setTimeout(() => {
    renderScheduled = false;
    lastRender = performance.now();
    render(snapshot);
  }, delay);
}

// --- UI / widgets related functions (kept here for clarity) ---
const WIDGETS = [
    { id: "alarms", title: "Allarmi" },
    { id: "power", title: "Status" },
    { id: "lights", title: "Luci" },
    { id: "motors", title: "Motori" },
    { id: "missionlog", title: "Mission Log" },
];

function loadUiPrefs() {
    try { return JSON.parse(localStorage.getItem("calypso_ui_prefs") || "{}"); }
    catch (e) { return {}; }
}
function saveUiPrefs(p) {
    localStorage.setItem("calypso_ui_prefs", JSON.stringify(p));
}
let uiPrefs = loadUiPrefs();
uiPrefs.visible ??= Object.fromEntries(WIDGETS.map(w => [w.id, true]));
uiPrefs.collapsed ??= {};
uiPrefs.mainTab ??= "vehicle";
uiPrefs.collapsed.alarms ??= true;
uiPrefs.collapsed.power ??= false;
uiPrefs.collapsed.lights ??= false;
uiPrefs.collapsed.motors ??= true;
uiPrefs.collapsed.missionlog ??= true;
uiPrefs.lightsCfgCollapsed ??= true;
if (uiPrefs.mainTabPresetVersion !== 2) {
    if (uiPrefs.mainTab === "mission") uiPrefs.mainTab = "vehicle";
    uiPrefs.mainTabPresetVersion = 2;
    saveUiPrefs(uiPrefs);
}
if (uiPrefs.layoutPresetVersion !== 1) {
    uiPrefs.collapsed.alarms = true;
    uiPrefs.collapsed.power = false;
    uiPrefs.collapsed.lights = false;
    uiPrefs.collapsed.motors = true;
    uiPrefs.collapsed.missionlog = true;
    uiPrefs.lightsCfgCollapsed = true;
    uiPrefs.layoutPresetVersion = 1;
    saveUiPrefs(uiPrefs);
}

function applyWidgetVisibility() {
    for (const w of WIDGETS) {
        const card = document.querySelector(`[data-widget="${w.id}"]`);
        if (!card)
            continue;
        card.style.display = uiPrefs.visible[w.id] ? "" : "none"; const body = card.querySelector(":scope > .cardBody") || card.querySelector('.cardBody');
        const col = !!uiPrefs.collapsed[w.id];
        if (body) {
            body.classList.toggle("hidden", col);
            body.style.display = col ? "none" : "";
        }
        const btn = card.querySelector('[data-collapse]');
        if (btn)
            btn.textContent = col ? '>' : 'v';
    }
}

function renderWidgetsMenu() {
    const panel = utils.el("widgets_panel");
    if (!panel)
        return;
    panel.innerHTML = WIDGETS.map(w => `<label><input type="checkbox" ${uiPrefs.visible[w.id] ? "checked" : ""} data-wid="${w.id}"><span>${w.title}</span></label>`).join("");
    panel.querySelectorAll("input[type=checkbox]").forEach(cb => {
        cb.addEventListener('change', () => {
            uiPrefs.visible[cb.dataset.wid] = cb.checked;
            saveUiPrefs(uiPrefs);
            applyWidgetVisibility();
        });
    });
}

function setupWidgetsMenu() {
    const btn = document.getElementById("btn_widgets");
    if (btn)
        btn.onclick = () => {
            const p = utils.el('widgets_panel');
            p.classList.toggle('hidden');
        };
    document.addEventListener('click', (e) => {
        const p = utils.el('widgets_panel');
        if (!p) return; if (p.classList.contains('hidden'))
            return;
        if (e.target.id === 'btn_widgets' || p.contains(e.target))
            return;
        p.classList.add('hidden');
    });
}

let collapseWired = false;
function setupCollapseButtons() {
    if (collapseWired)
        return;
    collapseWired = true;
    document.addEventListener('click', (e) => {
        const b = e.target.closest('[data-collapse]');
        if (!b)
            return;
        e.preventDefault();
        e.stopPropagation();
        const card = b.closest('.card');
        if (!card)
            return;
        let body = card.querySelector(':scope > .cardBody') || card.querySelector('.cardBody');
        if (!body)
            return;
        const isHidden = body.classList.toggle('hidden');
        body.style.display = isHidden ? 'none' : '';
        b.textContent = isHidden ? '>' : 'v';
        const wid = b.getAttribute('data-collapse');
        if (wid) {
            uiPrefs.collapsed[wid] = isHidden;
            saveUiPrefs(uiPrefs);
        }
    }, true);
}

function renderMainSlot(tab) {
    utils.setText('main_mode', tab.toUpperCase());
    const mw = utils.el('missionWrap');
    const tw = utils.el('missionTabWrap');
    const vw = utils.el('videoWrap');
    const sw = utils.el('sonarWrap');
    if (mw)
        mw.classList.toggle('hidden', tab !== 'vehicle');
    if (tw)
        tw.classList.toggle('hidden', tab !== 'mission');
    if (vw)
        vw.classList.toggle('hidden', tab !== 'video');
    if (sw)
        sw.classList.toggle('hidden', tab !== 'sonar');
    if (tab === 'vehicle') {
        th3.ensure3D();
        return;
    }
    if (tab === 'mission') {
        refreshMissionTab().catch(() => { });
        return;
    }
    if (tab === 'video') {
        video.mountVideo(video.videoState.kind, video.videoState.url);
        return;
    }
}

function renderMainMission() {
    const slot = document.getElementById('main_slot');
    if (!slot)
        return;
    slot.innerHTML = `...`;
    th3.ensure3D();
}

function setupTabs() {
    document.querySelectorAll('.tab').forEach(t => {
        t.addEventListener('click', () => {
            document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
            t.classList.add('active');
            uiPrefs.mainTab = t.dataset.tab; saveUiPrefs(uiPrefs);
            renderMainSlot(uiPrefs.mainTab);
        });
    });
    const cur = uiPrefs.mainTab || 'vehicle';
    document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x.dataset.tab === cur));
    renderMainSlot(cur);
}

function setupLightsConfigToggle() {
    const btn = utils.el('lgt_cfg_toggle');
    const wrap = utils.el('lgt_cfg_body');
    if (!btn || !wrap)
        return;
    const apply = () => {
        const hidden = !!uiPrefs.lightsCfgCollapsed;
        wrap.classList.toggle('hidden', hidden);
        wrap.style.display = hidden ? 'none' : '';
        btn.textContent = hidden ? '>' : 'v';
    };
    apply();
    btn.onclick = () => {
        uiPrefs.lightsCfgCollapsed = !uiPrefs.lightsCfgCollapsed;
        saveUiPrefs(uiPrefs);
        apply();
    };
}

let helpWired = false;
function setupHelpPanel() {
    if (helpWired) return;
    helpWired = true;
    const btn = document.getElementById("btn_help");
    const closeBtn = document.getElementById("btn_help_close");
    const ov = document.getElementById("help_overlay");
    if (!btn || !ov) return;

    const open = () => ov.classList.remove("hidden");
    const close = () => ov.classList.add("hidden");

    btn.onclick = open;
    if (closeBtn) closeBtn.onclick = close;

    ov.addEventListener("click", (e) => {
        if (e.target === ov) close();
    });

    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && !ov.classList.contains("hidden")) close();
    });
}

window.addEventListener('DOMContentLoaded', () => {
    init().catch(err => {
        console.error('init failed:', err);
        const s = document.getElementById('status');
        if (s)
            s.textContent = 'init error: ' + (err?.message || err);
    });
});

export { render, init };



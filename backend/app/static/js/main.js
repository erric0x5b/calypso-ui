import * as utils from './utils.js?v=16';
import { scadaSvg } from './power.js?v=17';
import * as lights from './lights.js';
import * as thrusters from './thrusters.js';
import * as video from './video.js?v=18';
import * as th3 from './three3d.js';
import * as logs from './logs.js';

let snapshot = null;
let missionRefreshTimer = null;
let missionTabWired = false;
let missionCurrentSid = null;
let missionMetaAppliedSid = null;
let gpLoopStarted = false;
let gpPrevButtons = [];
let gpLightCh = 1;
let gpBusyLight = false;
let gpBusyEvent = false;
let gpBusyLog = false;
let setupWired = false;
let alarmPanelWired = false;
let alarmPrevActiveKeys = null;
let alarmBeepCtx = null;
let alarmBeepCooldownUntil = 0;
let alarmAudioUnlockWired = false;
let vmotHoldTimer = null;
let vmotHoldActive = false;
let vmotHoldStartMs = 0;
let vmotLastBeepSec = -1;
let vmotCmdBusy = false;
let gpVmotHoldActive = false;
let gpVmotHoldStartMs = 0;
let gpVmotLastBeepSec = -1;
let gpDeviceOptionsSignature = "";
let autologCfg = { enabled: true, depth_m: null, hyst_m: null };
let sonarCfg = null;

const VMOT_ENABLE_HOLD_MS = 3000;
const VMOT_ACK_TIMEOUT_MS = 3000;
const VMOT_ACK_POLL_MS = 120;
const ALARM_FILTERS = new Set(["all", "crit", "error", "warn"]);
const SONAR_CFG_FIELDS = [
    "host",
    "fallback_ip",
    "port",
    "device_id",
    "gain_setting",
    "transmit_duration_us",
    "sample_period_25ns",
    "frequency_khz",
    "num_samples",
    "range_m",
    "start_angle_grad",
    "stop_angle_grad",
    "num_steps",
    "delay_ms",
];

const TAB_ORDER = ["vehicle", "mission", "video", "sonar", "setup"];
const GP_ACTIONS = [
    { key: "tab_prev", label: "Tab precedente", def: 14 },
    { key: "tab_next", label: "Tab successivo", def: 15 },
    { key: "light_ch_prev", label: "Canale luce precedente", def: 12 },
    { key: "light_ch_next", label: "Canale luce successivo", def: 13 },
    { key: "light_on", label: "Luce ON (dim corrente)", def: 0 },
    { key: "light_off", label: "Luce OFF", def: 1 },
    { key: "vmot_enable_hold", label: "VMOT ENABLE hold 3s", def: -1 },
    { key: "vmot_disable", label: "VMOT DISABLE immediato", def: -1 },
    { key: "add_mark", label: "Aggiungi marker missione", def: 2 },
    { key: "toggle_log", label: "Start/Stop logging", def: 3 },
    { key: "video_stream_1", label: "Video stream 1", def: 4 },
    { key: "video_stream_2", label: "Video stream 2", def: 5 },
    { key: "video_stream_3", label: "Video stream 3", def: 6 },
    { key: "tab_cycle", label: "Ciclo tab", def: 9 },
];
const GP_DEFAULT_MAP = Object.fromEntries(GP_ACTIONS.map((x) => [x.key, x.def]));
let gpMap = loadGpMap();

const ALARM_GUIDE_BY_ID = {
    100: {
        label: "ALM_I2C_ERROR",
        meaning: "Errore bus I2C locale (sensori/IO expander).",
        action: "Controlla cablaggio I2C, alimentazioni periferiche e riprova."
    },
    110: {
        label: "ALM_PEER_LOST",
        meaning: "Heartbeat nodo peer non ricevuto entro timeout.",
        action: "Verifica link tra BAT1/BAT2, alimentazione peer e stato rete."
    },
    120: {
        label: "ALM_CAN_BUS",
        meaning: "Errore comunicazione CAN verso ESC/periferiche.",
        action: "Controlla terminazioni CAN, cablaggio e stato ESC."
    },
    200: {
        label: "ALM_LEAK",
        meaning: "Ingresso leak attivo.",
        action: "Metti in sicurezza il ROV, verifica sensore leak e infiltrazioni."
    },
    210: {
        label: "ALM_OVERTEMP",
        meaning: "Temperatura oltre soglia di sicurezza.",
        action: "Riduci carico, aumenta raffreddamento e verifica sensori termici."
    },
    300: {
        label: "ALM_VBUS_LOW",
        meaning: "VBUS sotto soglia.",
        action: "Controlla batterie, carico e connessioni di potenza."
    },
    310: {
        label: "ALM_DV_HIGH",
        meaning: "Delta tensione BAT1-BAT2 oltre soglia.",
        action: "Evita parallelo, equalizza batterie e verifica misura dV."
    },
    320: {
        label: "ALM_PWR_FAULT",
        meaning: "Fault logica power switch/PowerSM.",
        action: "Leggi Reason/VmotReason, rimuovi causa e poi riabilita."
    },
    9001: {
        label: "NODE_OFFLINE",
        meaning: "Nodo offline: heartbeat assente oltre la soglia OFFLINE_MS.",
        action: "Controlla alimentazione nodo, link comunicazione e riavvio modulo."
    },
};

const ALARM_GUIDE_BY_TEXT = [
    {
        rx: /I2C|SDA|SCL/i,
        label: "I2C error",
        meaning: "Anomalia comunicazione I2C locale.",
        action: "Verifica bus, pull-up e periferiche condivise."
    },
    {
        rx: /PEER|HEARTBEAT|OFFLINE/i,
        label: "Peer offline",
        meaning: "Nodo remoto non aggiornato o assente.",
        action: "Controlla stato peer BAT1/BAT2 e comunicazione tra nodi."
    },
    {
        rx: /LEAK|WATER|INTRUSION/i,
        label: "Leak",
        meaning: "Possibile infiltrazione rilevata.",
        action: "Metti in sicurezza il sistema e verifica immediatamente il leak sensor."
    },
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

function normalizeGpMap(raw) {
    const out = { ...GP_DEFAULT_MAP };
    const src = (raw && typeof raw === "object") ? raw : {};
    for (const it of GP_ACTIONS) {
        const v = Number(src[it.key]);
        out[it.key] = Number.isInteger(v) && v >= -1 && v <= 31 ? v : it.def;
    }
    return out;
}

function loadGpMap() {
    try {
        const raw = JSON.parse(localStorage.getItem("calypso_gp_map") || "{}");
        return normalizeGpMap(raw);
    } catch {
        return { ...GP_DEFAULT_MAP };
    }
}

function saveGpMap(map) {
    gpMap = normalizeGpMap(map);
    localStorage.setItem("calypso_gp_map", JSON.stringify(gpMap));
}

function gpSelectOptions(selected) {
    let html = `<option value="-1">Disabled</option>`;
    for (let i = 0; i <= 15; i++) {
        html += `<option value="${i}" ${Number(selected) === i ? "selected" : ""}>Button ${i}</option>`;
    }
    return html;
}

function alarmKey(a) {
    const src = String(a?.src || "");
    const id = String(a?.id ?? "");
    const text = String(a?.text || "");
    return `${src}|${id}|${text}`;
}

function ensureAlarmAudioUnlock() {
    if (alarmAudioUnlockWired) return;
    alarmAudioUnlockWired = true;

    const unlock = () => {
        try {
            const Ctor = window.AudioContext || window.webkitAudioContext;
            if (!Ctor) return;
            if (!alarmBeepCtx) alarmBeepCtx = new Ctor();
            if (alarmBeepCtx.state === "suspended") alarmBeepCtx.resume().catch(() => { });
        } catch {
            // Browser may block audio contexts; ignore and keep UI responsive.
        }
    };

    document.addEventListener("pointerdown", unlock, { passive: true });
    document.addEventListener("keydown", unlock);
}

function playUiBeep(freqHz = 880, durationSec = 0.20, peak = 0.08, force = false) {
    try {
        const Ctor = window.AudioContext || window.webkitAudioContext;
        if (!Ctor) return false;
        if (!alarmBeepCtx) alarmBeepCtx = new Ctor();
        if (alarmBeepCtx.state === "suspended") {
            if (force) alarmBeepCtx.resume().catch(() => { });
            if (alarmBeepCtx.state === "suspended") return false;
        }

        const dur = Math.max(0.05, Number(durationSec) || 0.20);
        const gainPeak = Math.max(0.005, Math.min(0.20, Number(peak) || 0.08));
        const t0 = alarmBeepCtx.currentTime + 0.01;
        const osc = alarmBeepCtx.createOscillator();
        const gain = alarmBeepCtx.createGain();

        osc.type = "sine";
        osc.frequency.setValueAtTime(Math.max(120, Number(freqHz) || 880), t0);
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.exponentialRampToValueAtTime(gainPeak, t0 + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        osc.connect(gain);
        gain.connect(alarmBeepCtx.destination);
        osc.start(t0);
        osc.stop(t0 + dur + 0.01);
        return true;
    } catch {
        return false;
    }
}

function playAlarmBeep(force = false) {
    if (!force && !uiPrefs.showAlarmBeep) return;
    const now = performance.now();
    if (!force && now < alarmBeepCooldownUntil) return;
    alarmBeepCooldownUntil = now + 1200;
    playUiBeep(880, 0.20, 0.08, force);
}

function handleAlarmBeep(state) {
    const active = visibleActiveAlarms(state);
    const cur = new Set(active.map(alarmKey));

    if (alarmPrevActiveKeys == null) {
        alarmPrevActiveKeys = cur;
        return;
    }

    let hasNew = false;
    for (const key of cur) {
        if (!alarmPrevActiveKeys.has(key)) {
            hasNew = true;
            break;
        }
    }
    alarmPrevActiveKeys = cur;

    if (hasNew) playAlarmBeep();
}

function vmotBits(state) {
    const b1 = state?.pods?.BAT1 || {};
    const b2 = state?.pods?.BAT2 || {};
    return [
        (b1.Vmot1On === 1 || b1.Vmot1On === "1"),
        (b1.Vmot2On === 1 || b1.Vmot2On === "1"),
        (b1.Vmot3On === 1 || b1.Vmot3On === "1"),
        (b2.Vmot4On === 1 || b2.Vmot4On === "1"),
        (b2.Vmot5On === 1 || b2.Vmot5On === "1"),
        (b2.Vmot6On === 1 || b2.Vmot6On === "1"),
    ];
}

function anyVmotOn(state) {
    return vmotBits(state).some(Boolean);
}

function isCanDeviceAlarm(alarm) {
    const idNum = Number(alarm?.id);
    if (idNum === 120) return true;
    if (Number.isFinite(idNum) && idNum >= 401 && idNum <= 499) return true;

    const txt = String(alarm?.text || "").toUpperCase();
    const src = String(alarm?.src || "").toUpperCase();
    return (
        src.startsWith("ESC") ||
        txt.includes("ALM_CAN_BUS") ||
        txt.includes("CAN") ||
        txt.includes("VESC_LOST") ||
        txt.includes("ESC CHAIN")
    );
}

function visibleActiveAlarms(state) {
    const active = Array.isArray(state?.alarms_active) ? state.alarms_active : [];
    if (anyVmotOn(state)) return active;
    return active.filter((alarm) => !isCanDeviceAlarm(alarm));
}

function renderVmotState(state) {
    const out = document.getElementById("vmot_state");
    if (!out) return;

    const b1 = state?.pods?.BAT1 || {};
    const b2 = state?.pods?.BAT2 || {};
    const bits = vmotBits(state);
    const onCount = bits.filter(Boolean).length;
    const allOn = onCount === 6;
    const allOff = onCount === 0;
    const vmotReason1 = Number(b1.VmotReason ?? 0);
    const vmotReason2 = Number(b2.VmotReason ?? 0);
    const vmotReason = vmotReason1 !== 0 ? vmotReason1 : vmotReason2;
    const reasonSuffix = vmotReason === 0 ? "" : ` - ${utils.vmotReasonLabel(vmotReason)}`;

    out.classList.remove("vmotOn", "vmotOff", "vmotPartial");
    if (allOn) out.classList.add("vmotOn");
    else if (allOff) out.classList.add("vmotOff");
    else out.classList.add("vmotPartial");

    out.textContent = allOn
        ? `VMOT: ENABLED (6/6)${reasonSuffix}`
        : allOff
            ? `VMOT: DISABLED (0/6)${reasonSuffix}`
            : `VMOT: PARTIAL (${onCount}/6)${reasonSuffix}`;
}

function renderVmotCockpitWarning(state) {
    const box = document.getElementById("vmot_cockpit_warn");
    if (!box) return;

    const armedRaw = state?.mav?.safety_armed;
    const cockpitArmed = (armedRaw === 1 || armedRaw === "1" || armedRaw === true);
    const show = cockpitArmed && !anyVmotOn(state);

    box.classList.toggle("hidden", !show);
    box.textContent = show
        ? "ATTENZIONE: motori ARMATI in Cockpit, ma VMOT OFF"
        : "";
}

function vmotAckText(txt) {
    const out = document.getElementById("vmot_cmd_ack");
    if (out) out.textContent = txt;
}

function vmotEnableUi(progress, text = null) {
    const btn = document.getElementById("vmot_enable_hold");
    const fill = document.getElementById("vmot_enable_fill");
    const label = document.getElementById("vmot_enable_text");
    if (!btn || !fill || !label) return;

    const p = Math.max(0, Math.min(1, Number(progress) || 0));
    fill.style.width = `${(p * 100).toFixed(1)}%`;
    btn.classList.toggle("holding", vmotHoldActive);
    label.textContent = text || "ENABLE VMOT (hold 3s)";
}

function vmotSetBusy(busy) {
    const b = !!busy;
    vmotCmdBusy = b;
    const enBtn = document.getElementById("vmot_enable_hold");
    const disBtn = document.getElementById("vmot_disable_now");
    if (enBtn) {
        enBtn.disabled = b;
        enBtn.classList.toggle("busy", b);
    }
    if (disBtn) disBtn.disabled = b;
}

function sleepMs(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitCmdAck(cmdId, timeoutMs = VMOT_ACK_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const r = await fetch(`/api/cmd/ack?cmd_id=${encodeURIComponent(cmdId)}`, { cache: "no-store" });
        const j = await r.json();
        if (j?.ok && j.status === "ack" && j.ack) return j.ack;
        await sleepMs(VMOT_ACK_POLL_MS);
    }
    return null;
}

async function sendVmotMaster(enable) {
    if (vmotCmdBusy) return false;
    vmotSetBusy(true);
    try {
        const en = Number(enable) === 1 ? 1 : 0;
        vmotAckText(`VMOT ${en ? "ENABLE" : "DISABLE"}: sending...`);
        const r = await fetch("/api/cmd/vmot", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ on: en, dst: "ALL" }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j?.ok) {
            vmotAckText(`VMOT ${en ? "ENABLE" : "DISABLE"}: send failed`);
            return false;
        }

        vmotAckText(`CmdId ${j.cmd_id} sent (${en ? "ENABLE" : "DISABLE"})`);
        const ack = await waitCmdAck(j.cmd_id).catch(() => null);
        if (!ack) {
            vmotAckText(`CmdId ${j.cmd_id}: ACK timeout`);
            return false;
        }

        const ok = Number(ack.ok) === 1;
        const txt = ack.text ? ` (${ack.text})` : "";
        const err = ack.err != null ? ` err:${ack.err}` : "";
        vmotAckText(ok
            ? `ACK OK CmdId ${j.cmd_id}${txt}`
            : `ACK ERR CmdId ${j.cmd_id}${err}${txt}`);
        return ok;
    } catch {
        vmotAckText(`VMOT ${Number(enable) === 1 ? "ENABLE" : "DISABLE"}: error`);
        return false;
    } finally {
        vmotSetBusy(false);
    }
}

function cancelVmotHold() {
    if (!vmotHoldActive) return;
    vmotHoldActive = false;
    if (vmotHoldTimer != null) {
        cancelAnimationFrame(vmotHoldTimer);
        vmotHoldTimer = null;
    }
    vmotEnableUi(0);
}

function vmotHoldStep() {
    if (!vmotHoldActive) return;
    const elapsed = Math.max(0, performance.now() - vmotHoldStartMs);
    const progress = Math.min(1, elapsed / VMOT_ENABLE_HOLD_MS);
    const remainSec = Math.max(0, Math.ceil((VMOT_ENABLE_HOLD_MS - elapsed) / 1000));
    vmotEnableUi(progress, `ENABLE VMOT (${remainSec}s)`);

    const sec = Math.floor(elapsed / 1000);
    if (sec > vmotLastBeepSec && sec > 0) {
        vmotLastBeepSec = sec;
        playUiBeep(740, 0.12, 0.06, true);
    }

    if (elapsed >= VMOT_ENABLE_HOLD_MS) {
        vmotHoldActive = false;
        vmotHoldTimer = null;
        vmotEnableUi(1, "ENABLE VMOT (sending...)");
        sendVmotMaster(1).finally(() => vmotEnableUi(0));
        return;
    }

    vmotHoldTimer = requestAnimationFrame(vmotHoldStep);
}

function startVmotHold(ev) {
    if (vmotCmdBusy || vmotHoldActive) return;
    cancelGpVmotHold();
    ensureAlarmAudioUnlock();
    vmotHoldActive = true;
    vmotHoldStartMs = performance.now();
    vmotLastBeepSec = -1;
    vmotEnableUi(0, "ENABLE VMOT (3s hold)");

    const btn = document.getElementById("vmot_enable_hold");
    if (btn && ev && typeof ev.pointerId === "number" && btn.setPointerCapture) {
        try { btn.setPointerCapture(ev.pointerId); } catch { }
    }

    vmotHoldTimer = requestAnimationFrame(vmotHoldStep);
}

function setupVmotControls() {
    const enBtn = document.getElementById("vmot_enable_hold");
    const disBtn = document.getElementById("vmot_disable_now");

    if (enBtn && !enBtn.dataset.wired) {
        enBtn.dataset.wired = "1";
        enBtn.addEventListener("pointerdown", (ev) => {
            ev.preventDefault();
            startVmotHold(ev);
        });
        enBtn.addEventListener("pointerup", () => cancelVmotHold());
        enBtn.addEventListener("pointercancel", () => cancelVmotHold());
        enBtn.addEventListener("lostpointercapture", () => cancelVmotHold());
        enBtn.addEventListener("contextmenu", (ev) => ev.preventDefault());
    }

    if (disBtn && !disBtn.dataset.wired) {
        disBtn.dataset.wired = "1";
        disBtn.addEventListener("click", () => {
            cancelGpVmotHold();
            cancelVmotHold();
            sendVmotMaster(0);
        });
    }

    vmotEnableUi(0);
}

function resolveAlarmGuide(alarm) {
    const idNum = Number(alarm?.id);
    if (Number.isFinite(idNum) && ALARM_GUIDE_BY_ID[idNum]) {
        return ALARM_GUIDE_BY_ID[idNum];
    }
    if (Number.isFinite(idNum) && idNum >= 401 && idNum <= 499) {
        const escId = idNum - 400;
        return {
            label: "ALM_VESC_LOST",
            meaning: `Telemetria persa su ESC ${escId}.`,
            action: "Controlla alimentazione ESC, linea CAN e stato controller."
        };
    }

    const txt = String(alarm?.text || "");
    for (const rule of ALARM_GUIDE_BY_TEXT) {
        if (rule.rx.test(txt)) return rule;
    }
    return null;
}

function splitAlarmText(alarm) {
    const raw = String(alarm?.text || "").trim();
    if (!raw) return { type: "Alarm", detail: "" };

    const colon = raw.indexOf(":");
    if (colon > 0) {
        return {
            type: raw.slice(0, colon).trim(),
            detail: raw.slice(colon + 1).trim(),
        };
    }

    return { type: raw, detail: "" };
}

function normalizeAlarmFilter(filter) {
    return ALARM_FILTERS.has(filter) ? filter : "all";
}

function alarmMatchesFilter(alarm, filter) {
    const sev = Number(alarm?.sev);
    if (filter === "crit") return sev === 4;
    if (filter === "error") return sev === 3;
    if (filter === "warn") return sev === 2;
    return true;
}

function filterAlarms(list) {
    const arr = Array.isArray(list) ? list : [];
    const filter = normalizeAlarmFilter(uiPrefs.alarmFilter);
    return arr.filter((alarm) => alarmMatchesFilter(alarm, filter));
}

function renderAlarmItem(alarm, opts = {}) {
    const sev = utils.sevLabel(alarm?.sev);
    const sevClass = utils.sevClass(alarm?.sev);
    const latch = Number(alarm?.latched) === 1 ? "LAT" : "TRN";
    const idTxt = (alarm?.id == null ? "-" : String(alarm.id));
    const srcTxt = String(alarm?.src || "-");
    const parsed = splitAlarmText(alarm);
    const guide = resolveAlarmGuide(alarm);
    const typeTxt = guide?.label || parsed.type || "Alarm";
    const detailTxt = parsed.detail || "";
    const metaTxt = `ID ${idTxt} | ${latch} | SRC ${srcTxt}`;
    const extraClass = opts.history ? " alarmItemHist" : "";

    return `<div class="alarmItem ${sevClass}${extraClass}">
        <div class="alarmItemHead">
            <span class="alarmItemSev">${sev}</span>
            <span class="alarmItemType">${escapeHtml(typeTxt)}</span>
        </div>
        ${detailTxt ? `<div class="alarmItemDetail mono">${escapeHtml(detailTxt)}</div>` : ""}
        <div class="alarmItemMeta mono">${escapeHtml(metaTxt)}</div>
    </div>`;
}

function applyAlarmPanelPrefs() {
    const filter = normalizeAlarmFilter(uiPrefs.alarmFilter);
    document.querySelectorAll("[data-alarm-filter]").forEach((btn) => {
        const active = btn.getAttribute("data-alarm-filter") === filter;
        btn.classList.toggle("is-active", active);
        btn.setAttribute("aria-pressed", active ? "true" : "false");
    });

    const hist = document.getElementById("alarms_hist");
    if (hist) {
        const collapsed = !!uiPrefs.alarmHistoryCollapsed;
        hist.classList.toggle("hidden", collapsed);
        hist.style.display = collapsed ? "none" : "";
    }
    const histToggle = document.getElementById("alarms_hist_toggle");
    setChevronState(histToggle, !!uiPrefs.alarmHistoryCollapsed);
    if (histToggle) {
        histToggle.setAttribute("aria-label", uiPrefs.alarmHistoryCollapsed ? "Mostra ultimi 10" : "Nascondi ultimi 10");
    }
}

function setupAlarmPanelControls() {
    if (alarmPanelWired) return;
    alarmPanelWired = true;

    const tools = document.getElementById("alarm_tools");
    if (tools) {
        tools.addEventListener("click", (ev) => {
            const btn = ev.target.closest("[data-alarm-filter]");
            if (!btn) return;
            const filter = normalizeAlarmFilter(btn.getAttribute("data-alarm-filter"));
            if (uiPrefs.alarmFilter === filter) return;
            uiPrefs.alarmFilter = filter;
            saveUiPrefs(uiPrefs);
            applyAlarmPanelPrefs();
            if (snapshot) render(snapshot);
        });
    }

    const histToggle = document.getElementById("alarms_hist_toggle");
    if (histToggle) {
        histToggle.addEventListener("click", () => {
            uiPrefs.alarmHistoryCollapsed = !uiPrefs.alarmHistoryCollapsed;
            saveUiPrefs(uiPrefs);
            applyAlarmPanelPrefs();
        });
    }

    applyAlarmPanelPrefs();
}

function currentPowerTelemetry(state) {
    const b1 = state?.pods?.BAT1 || {};
    const b2 = state?.pods?.BAT2 || {};
    const reason = Number(b1.Reason ?? b2.Reason ?? 0);
    const vmotReason1 = Number(b1.VmotReason ?? 0);
    const vmotReason2 = Number(b2.VmotReason ?? 0);
    const vmotReason = vmotReason1 !== 0 ? vmotReason1 : vmotReason2;
    const dv = Number(b1.dV_mv ?? b2.dV_mv);
    const dvThr = Number(b1.dV_thr_mv ?? b2.dV_thr_mv);
    const dvKnown = Number.isFinite(dv) && Number.isFinite(dvThr);
    return {
        reason,
        vmotReason,
        dv: dvKnown ? dv : null,
        dvThr: dvKnown ? dvThr : null,
        dvBad: dvKnown ? dv > dvThr : false,
    };
}

function describeCurrentPowerCauses(state) {
    const diag = currentPowerTelemetry(state);
    const rows = [];
    if (diag.reason !== 0) {
        const info = utils.powerReasonInfo(diag.reason);
        rows.push({
            code: `Reason ${diag.reason}`,
            label: info.label,
            meaning: info.meaning,
        });
    }
    if (diag.vmotReason !== 0) {
        const info = utils.vmotReasonInfo(diag.vmotReason);
        rows.push({
            code: `VmotReason ${diag.vmotReason}`,
            label: info.label,
            meaning: info.meaning,
        });
    }
    if (diag.dvBad) {
        rows.push({
            code: "dV",
            label: `${diag.dv} mV > ${diag.dvThr} mV`,
            meaning: "Delta tensione oltre la soglia telemetrica dV_thr_mv.",
        });
    }
    return rows;
}

function alarmNeedsPowerCause(alarm) {
    const idNum = Number(alarm?.id);
    if (idNum === 300 || idNum === 310 || idNum === 320) return true;

    const txt = String(alarm?.text || "");
    return /PWR|POWER|VMOT|VBUS|DV|DELTA.?V|BUSCONN|FAULT/i.test(txt);
}

function renderHelpPowerReasons(state) {
    const box = document.getElementById("help_power_reasons");
    if (!box) return;

    const rows = describeCurrentPowerCauses(state);
    if (!rows.length) {
        box.innerHTML = "Nessuna causa power/VMOT attiva.";
        return;
    }

    box.innerHTML = rows.map((row) => `
        <div><b>${escapeHtml(row.code)}</b> ${escapeHtml(row.label)}</div>
        <div style="opacity:.85;">${escapeHtml(row.meaning)}</div>
    `).join("<hr style=\"border:0;border-top:1px solid rgba(255,255,255,.08);margin:8px 0;\">");
}

function renderHelpAlarmLinks(state) {
    const box = document.getElementById("help_alarm_links");
    if (!box) return;

    const active = visibleActiveAlarms(state);
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
        const powerCauses = alarmNeedsPowerCause(a)
            ? describeCurrentPowerCauses(state).map((row) => (
                `<div style="opacity:.85;">Causa telemetria: <b>${escapeHtml(row.code)}</b> ${escapeHtml(row.label)}. ${escapeHtml(row.meaning)}</div>`
            )).join("")
            : "";
        if (!g) {
            return `${base}${powerCauses}<div style="opacity:.85;">Azione: verifica scheda Allarmi e log firmware (ID non mappato).</div>`;
        }
        return `${base}<div style="opacity:.85;">${g.label}: ${g.meaning}</div>${powerCauses}<div style="opacity:.95;">Azione: ${g.action}</div>`;
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

function escPowerW(escRow) {
    const vinMv = Number(escRow?.InVoltage_mv);
    const iinMa = Number(escRow?.AvgInCur_ma);
    if (!Number.isFinite(vinMv) || !Number.isFinite(iinMa)) return null;
    return (vinMv * iinMa) / 1_000_000;
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
    if (!anyVmotOn(state)) {
        return `<div style="margin-top:8px;" class="ok"><b>Errori Motori:</b> n/a (VMOT OFF)</div>`;
    }

    const esc = state.esc || {};
    const errs = [];

    for (const id of escIds) {
        const d = esc[id] || {};
        const fault = d.Fault ?? d.FaultCode ?? d.Error ?? d.Err;
        if (fault != null && Number(fault) !== 0) {
            errs.push(`ESC ${id}: fault ${fault}`);
        }
    }

    const activeMotorAlarms = visibleActiveAlarms(state).filter(isMotorAlarm);
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

function clamp(n, min, max) {
    const v = Number(n);
    if (!Number.isFinite(v)) return min;
    return Math.max(min, Math.min(max, v));
}

function controllerBool(v) {
    return v === true || v === 1 || v === "1" || String(v).toLowerCase() === "true";
}

function fmtControllerValue(v, digits = 2) {
    const n = Number(v);
    if (!Number.isFinite(n)) return "-";
    return Math.abs(n) >= 10 ? String(Math.round(n)) : n.toFixed(digits);
}

function axisBarHtml(label, value, scale = 1000) {
    const n = Number(value);
    const norm = Number.isFinite(n) ? clamp(n / scale, -1, 1) : 0;
    const width = Math.abs(norm) * 50;
    const left = norm >= 0 ? 50 : 50 - width;
    return `
      <div class="controllerAxisRow">
        <span>${escapeHtml(label)}</span>
        <span class="controllerAxisBar"><span class="controllerAxisFill" style="left:${left.toFixed(2)}%;width:${width.toFixed(2)}%;"></span></span>
        <span>${escapeHtml(fmtControllerValue(value, 0))}</span>
      </div>
    `;
}

function renderControllerStatus(state) {
    const ctrl = state?.controller || {};
    const udp = state?.controller_udp || {};
    const linkPill = document.getElementById("controller_link");
    const online = controllerBool(ctrl.online) && !controllerBool(ctrl?.health?.link_stale);
    const activeLink = String(ctrl.active_link || "no_link").toUpperCase();

    if (linkPill) {
        linkPill.classList.remove("ok", "warn", "bad");
        linkPill.classList.add(online ? "ok" : (udp.listener_ok ? "warn" : "bad"));
        linkPill.textContent = online ? activeLink : (udp.listener_ok ? "WAIT" : "UDP OFF");
    }

    const raw = ctrl.raw || {};
    const mapped = ctrl.mapped || {};
    const health = ctrl.health || {};
    const mappedKeys = ["surge", "sway", "heave", "yaw", "lights_up", "lights_down", "camera_rec"];
    const mappedHtml = mappedKeys
        .filter((k) => Object.prototype.hasOwnProperty.call(mapped, k))
        .map((k) => {
            const v = mapped[k];
            const cls = controllerBool(v) ? "ok" : "muted";
            return `<span class="badge ${cls}"><span>${escapeHtml(k)}</span><span>${escapeHtml(typeof v === "boolean" ? (v ? "ON" : "OFF") : fmtControllerValue(v))}</span></span>`;
        })
        .join("");

    const events = Array.isArray(ctrl.events) ? ctrl.events : [];
    const lastEvents = events.slice(-3).map((ev) => `${ev?.type || "event"}:${ev?.id || "-"}`).join("  ");
    const ageMs = Number(ctrl.last_update_ms) > 0 ? Math.max(0, Date.now() - Number(ctrl.last_update_ms)) : null;

    utils.setHTML("controller_status", `
      <div class="controllerMeta">
        <span class="badge ${online ? "ok" : "bad"}"><span>online</span><span>${online ? "YES" : "NO"}</span></span>
        <span class="badge"><span>port</span><span>${escapeHtml(udp.port ?? "-")}</span></span>
        <span class="badge"><span>seq</span><span>${escapeHtml(ctrl.seq ?? "-")}</span></span>
        <span class="badge"><span>age</span><span>${ageMs == null ? "-" : `${Math.round(ageMs)} ms`}</span></span>
        <span class="badge ${controllerBool(ctrl.usb_available) ? "ok" : "muted"}"><span>USB</span><span>${controllerBool(ctrl.usb_available) ? "READY" : "-"}</span></span>
        <span class="badge ${controllerBool(ctrl.bt_available) ? "ok" : "muted"}"><span>BT</span><span>${controllerBool(ctrl.bt_available) ? "READY" : "-"}</span></span>
      </div>
      <div class="controllerAxes">
        ${axisBarHtml("lx", raw.lx)}
        ${axisBarHtml("ly", raw.ly)}
        ${axisBarHtml("rx", raw.rx)}
        ${axisBarHtml("ry", raw.ry)}
      </div>
      <div class="controllerMapped">
        ${mappedHtml || `<span class="badge muted">No mapped controls</span>`}
      </div>
      <div class="mono">profile=${escapeHtml(ctrl.profile || "-")} mode=${escapeHtml(ctrl.mode || "-")}
quality=${escapeHtml(ctrl.source_quality ?? "-")} stale=${controllerBool(health.link_stale) ? "true" : "false"} safe=${controllerBool(health.safe_output) ? "true" : "false"} vjoy=${controllerBool(health.vjoy_ok) ? "true" : "false"}
rx_valid=${escapeHtml(udp.rx_valid ?? 0)} rx_invalid=${escapeHtml(udp.rx_invalid ?? 0)} from=${escapeHtml(udp.last_from || "-")}
events=${escapeHtml(lastEvents || "-")}</div>
    `);
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
        `<div><b>Ora inizio:</b> ${escapeHtml(m.start_utc || m.created_utc || "-")}</div>`,
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

async function refreshMissionLogControls() {
    const pill = document.getElementById("mission_log_status");
    const bStart = document.getElementById("mission_log_start");
    const bStop = document.getElementById("mission_log_stop");
    try {
        const s = await fetch("/api/log/status").then((r) => r.json());
        const sid = String(s?.sid || "").trim();
        if (pill) pill.textContent = s?.enabled ? `LOG ON ${sid}` : (sid ? `LOG OFF ${sid}` : "LOG OFF");
        if (bStart) bStart.disabled = !!s?.enabled;
        if (bStop) bStop.disabled = !s?.enabled;
    } catch {
        if (pill) pill.textContent = "LOG ?";
    }
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
    await refreshMissionLogControls();
}

function setupMissionTab() {
    if (missionTabWired) return;
    missionTabWired = true;

    const metaBtn = document.getElementById("mission_meta_save");
    const metaAck = document.getElementById("mission_meta_ack");
    const logStartBtn = document.getElementById("mission_log_start");
    const logStopBtn = document.getElementById("mission_log_stop");
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

    if (logStartBtn) {
        logStartBtn.onclick = async () => {
            try {
                await logs.apiPost("/api/log/start");
                await logs.refreshLogStatus().catch(() => { });
                await logs.refreshLogSessions().catch(() => { });
                await refreshMissionTab();
            } catch (e) {
                if (metaAck) metaAck.textContent = e?.message || "Errore start log";
            }
        };
    }

    if (logStopBtn) {
        logStopBtn.onclick = async () => {
            try {
                await logs.apiPost("/api/log/stop");
                await logs.refreshLogStatus().catch(() => { });
                await logs.refreshLogSessions().catch(() => { });
                await refreshMissionTab();
            } catch (e) {
                if (metaAck) metaAck.textContent = e?.message || "Errore stop log";
            }
        };
    }

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
    const motorsPowered = anyVmotOn(state);
    const esc = state.esc || {};
    const ids = Object.keys(esc).map(x => parseInt(x, 10)).filter(Number.isFinite).sort((a, b) => a - b);
    const rows = ids.map((id) => {
        const d = esc[id] || {};
        const reason = motorsPowered ? (d.Fault ?? d.FaultCode ?? d.Error ?? d.Err) : null;
        const rpmNum = Number(d.RPM);
        return {
            id,
            vin: formatEscValue("InVoltage_mv", d.InVoltage_mv),
            iin: formatEscValue("AvgInCur_ma", d.AvgInCur_ma),
            rpm: Number.isFinite(rpmNum) ? String(Math.round(rpmNum)) : "-",
            powerW: escPowerW(d),
            reason: reason == null ? "-" : String(reason)
        };
    });

    const showReason = rows.some((r) => r.reason !== "-");
    const colspan = showReason ? 6 : 5;
    let ehtml = `<table class="escCompactTable"><thead><tr><th>ESC</th><th>Vin</th><th>Iin</th><th>RPM</th><th>W</th>`;
    if (showReason) ehtml += `<th>Reason</th>`;
    ehtml += `</tr></thead><tbody>`;

    if (!rows.length) {
        ehtml += `<tr><td colspan="${colspan}">No ESC data</td></tr>`;
    } else {
        for (const r of rows) {
            const pw = r.powerW == null ? "-" : `${r.powerW.toFixed(1)} W`;
            const reasonClass = r.reason === "-" || r.reason === "0" ? "" : " class=\"bad\"";
            ehtml += `<tr><td class="escId">ESC ${r.id}</td><td>${r.vin}</td><td>${r.iin}</td><td>${r.rpm}</td><td>${pw}</td>`;
            if (showReason) ehtml += `<td${reasonClass}>${r.reason}</td>`;
            ehtml += `</tr>`;
        }
    }
    ehtml += `</tbody></table>`;
    ehtml += buildMotorErrorsHtml(state, ids);
    utils.setHTML("esc", ehtml);

    const aa = filterAlarms(visibleActiveAlarms(state));
    const hist = filterAlarms(state.alarms_history || []).slice(-10).reverse();
    utils.setHTML("alarms_active", aa.length
        ? `<div class="alarmList">${aa.map((a) => renderAlarmItem(a)).join("")}</div>`
        : `<div class="ok">none</div>`);
    utils.setHTML("alarms_hist", hist.length
        ? `<div class="alarmList">${hist.map((a) => renderAlarmItem(a, { history: true })).join("")}</div>`
        : `<div class="ok">none</div>`);
    applyAlarmPanelPrefs();
    renderHelpPowerReasons(state);
    renderHelpAlarmLinks(state);
    handleAlarmBeep(state);

    const ms = document.getElementById("main_scada");

    if (ms) ms.innerHTML = scadaSvg(state);
    renderVmotState(state);
    renderVmotCockpitWarning(state);

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
    highlightGpLightChannel();
    syncSonarRuntimeStatus();
    renderControllerStatus(state);
}

async function refreshSnapshotOnce() {
    const r = await fetch("/api/state", { cache: "no-store" });
    snapshot = await r.json();
    render(snapshot);
}

async function init() {
    snapshot = await fetch("/api/state").then(r => r.json());
    setupTabs();
    setupSetupTab();
    setupMissionTab();
    video.setupVideo();
    ensureAlarmAudioUnlock();
    setupVmotControls();
    setupHelpPanel();
    setupAlarmPanelControls();
    renderWidgetsMenu();
    setupWidgetsMenu();
    applyWidgetVisibility();
    applyLightsAckVisibility();
    setupCollapseButtons();

    lights.setupLights && lights.setupLights();
    await lights.loadLightsCfg().catch(() => { });
    highlightGpLightChannel();

    const saveBtn = document.getElementById("lgt_cfg_save");
    if (saveBtn)
        saveBtn.onclick = lights.saveLightsCfg;
    setupLightsConfigToggle();
    setupJoystickControls();

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

            if (msg.type === "controller") {
                snapshot = snapshot || {};
                if (msg.controller) snapshot.controller = msg.controller;
                if (msg.udp) snapshot.controller_udp = msg.udp;
                requestRender();
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
    { id: "lights", title: "Luci" },
    { id: "controller", title: "Controller" },
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
for (const w of WIDGETS) {
    if (uiPrefs.visible[w.id] == null) uiPrefs.visible[w.id] = true;
}
uiPrefs.mainTab ??= "vehicle";
uiPrefs.showLightsAck ??= true;
uiPrefs.showAlarmBeep ??= true;
uiPrefs.alarmFilter ??= "all";
uiPrefs.alarmHistoryCollapsed ??= true;
uiPrefs.gamepadIndex ??= -1;
uiPrefs.sonarHeadingLock ??= false;
uiPrefs.collapsed.alarms ??= true;
uiPrefs.collapsed.lights ??= false;
uiPrefs.collapsed.controller ??= false;
uiPrefs.collapsed.motors ??= true;
uiPrefs.collapsed.missionlog ??= true;
uiPrefs.lightsCfgCollapsed ??= true;
if (!TAB_ORDER.includes(uiPrefs.mainTab)) uiPrefs.mainTab = "vehicle";
if (uiPrefs.mainTabPresetVersion !== 3) {
    uiPrefs.mainTabPresetVersion = 3;
    saveUiPrefs(uiPrefs);
}
if (uiPrefs.layoutPresetVersion !== 1) {
    uiPrefs.collapsed.alarms = true;
    uiPrefs.collapsed.lights = false;
    uiPrefs.collapsed.controller = false;
    uiPrefs.collapsed.motors = true;
    uiPrefs.collapsed.missionlog = true;
    uiPrefs.lightsCfgCollapsed = true;
    uiPrefs.layoutPresetVersion = 1;
    saveUiPrefs(uiPrefs);
}

function setChevronState(btn, collapsed) {
    if (!btn) return;
    btn.classList.add("chevBtn");
    btn.classList.toggle("is-collapsed", !!collapsed);
    btn.setAttribute("aria-label", collapsed ? "Expand section" : "Collapse section");
}

function applyLightsAckVisibility() {
    const ack = document.getElementById("lgt_ack");
    if (!ack) return;
    ack.classList.toggle("hidden", !uiPrefs.showLightsAck);
}

function setSetupUiAck(text) {
    const ack = document.getElementById("setup_ui_ack");
    if (ack) ack.textContent = text;
}

function syncAutologSetupControl() {
    const cb = document.getElementById("setup_log_autostart_enabled");
    if (cb) cb.checked = !!autologCfg.enabled;

    const label = document.getElementById("setup_log_autostart_label");
    if (label) {
        const depth = Number(autologCfg?.depth_m);
        const depthTxt = Number.isFinite(depth) ? depth.toFixed(2).replace(".", ",") : "?";
        label.textContent = `Log autostart (depth < ${depthTxt} m)`;
    }
}

async function loadAutologSetupConfig(publishAck = false) {
    try {
        const r = await fetch("/api/config/autolog", { cache: "no-store" });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j?.err || j?.detail || (`HTTP ${r.status}`));

        autologCfg.enabled = !!j?.enabled;
        const depth = Number(j?.depth_m);
        autologCfg.depth_m = Number.isFinite(depth) ? depth : null;
        const hyst = Number(j?.hyst_m);
        autologCfg.hyst_m = Number.isFinite(hyst) ? hyst : null;
        syncAutologSetupControl();
        if (publishAck) setSetupUiAck("Autostart config loaded.");
    } catch (e) {
        if (publishAck) setSetupUiAck(e?.message || "Errore lettura autostart.");
    }
}

async function saveAutologSetupEnabled(publishAck = true) {
    const cb = document.getElementById("setup_log_autostart_enabled");
    if (!cb) return;
    const desired = !!cb.checked;
    try {
        const j = await logs.apiPost("/api/config/autolog", { enabled: desired });
        autologCfg.enabled = !!j?.enabled;
        const depth = Number(j?.depth_m);
        if (Number.isFinite(depth)) autologCfg.depth_m = depth;
        const hyst = Number(j?.hyst_m);
        if (Number.isFinite(hyst)) autologCfg.hyst_m = hyst;
        syncAutologSetupControl();
        if (publishAck) setSetupUiAck(`Log autostart ${autologCfg.enabled ? "enabled" : "disabled"}.`);
    } catch (e) {
        await loadAutologSetupConfig(false);
        if (publishAck) setSetupUiAck(e?.message || "Errore salvataggio autostart.");
    }
}

function setSonarSetupAck(text) {
    const ack = document.getElementById("sonar_cfg_status");
    if (ack) ack.textContent = text || "-";
}

function sonarField(id) {
    return document.getElementById(`sonar_cfg_${id}`);
}

function writeSonarSetupConfig(cfg) {
    sonarCfg = cfg || {};
    const enabled = sonarField("enabled");
    if (enabled) enabled.checked = !!sonarCfg.enabled;
    for (const id of SONAR_CFG_FIELDS) {
        const node = sonarField(id);
        if (!node) continue;
        const v = sonarCfg[id];
        node.value = v == null ? "" : String(v);
    }
    const quickRange = document.getElementById("sonar_range_m");
    if (quickRange && document.activeElement !== quickRange) {
        const range = Number(sonarCfg.range_m);
        quickRange.value = Number.isFinite(range) ? String(Math.round(range)) : "";
    }
    syncSonarRuntimeStatus();
}

function numberFieldValue(id, fallback = 0) {
    const node = sonarField(id);
    const v = Number(node?.value);
    return Number.isFinite(v) ? v : fallback;
}

function readSonarSetupConfig() {
    const enabled = sonarField("enabled");
    const current = sonarCfg || {};
    return {
        enabled: !!enabled?.checked,
        host: String(sonarField("host")?.value || current.host || "blueos").trim(),
        fallback_ip: String(sonarField("fallback_ip")?.value || current.fallback_ip || "192.168.2.2").trim(),
        port: numberFieldValue("port", current.port ?? 9092),
        device_id: numberFieldValue("device_id", current.device_id ?? 1),
        gain_setting: numberFieldValue("gain_setting", current.gain_setting ?? 1),
        transmit_duration_us: numberFieldValue("transmit_duration_us", current.transmit_duration_us ?? 500),
        sample_period_25ns: numberFieldValue("sample_period_25ns", current.sample_period_25ns ?? 4000),
        frequency_khz: numberFieldValue("frequency_khz", current.frequency_khz ?? 750),
        num_samples: numberFieldValue("num_samples", current.num_samples ?? 800),
        range_m: numberFieldValue("range_m", current.range_m ?? 60),
        start_angle_grad: numberFieldValue("start_angle_grad", current.start_angle_grad ?? 0),
        stop_angle_grad: numberFieldValue("stop_angle_grad", current.stop_angle_grad ?? 399),
        num_steps: numberFieldValue("num_steps", current.num_steps ?? 1),
        delay_ms: numberFieldValue("delay_ms", current.delay_ms ?? 0),
    };
}

function sonarQuickRangeValue() {
    const quick = document.getElementById("sonar_range_m");
    const v = Number(quick?.value);
    if (Number.isFinite(v)) return v;
    const cfgRange = Number(sonarCfg?.range_m);
    return Number.isFinite(cfgRange) ? cfgRange : 60;
}

async function loadSonarSetupConfig(publishAck = false) {
    try {
        const r = await fetch("/api/sonar/ping360/config", { cache: "no-store" });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j?.err || j?.detail || (`HTTP ${r.status}`));
        writeSonarSetupConfig(j || {});
        if (publishAck) setSonarSetupAck("Ping360 config loaded.");
    } catch (e) {
        setSonarSetupAck(e?.message || "Errore lettura Ping360.");
    }
}

async function saveSonarSetupConfig() {
    try {
        setSonarSetupAck("Saving Ping360 config...");
        const j = await logs.apiPost("/api/sonar/ping360/config", readSonarSetupConfig());
        writeSonarSetupConfig(j?.config || readSonarSetupConfig());
        setSonarSetupAck("Ping360 config saved. Runtime restarted.");
        await refreshSnapshotOnce().catch(() => { });
    } catch (e) {
        setSonarSetupAck(e?.message || "Errore salvataggio Ping360.");
    }
}

async function startSonarScan() {
    try {
        setSonarSetupAck("Starting Ping360...");
        const payload = { ...(sonarCfg || readSonarSetupConfig()), range_m: sonarQuickRangeValue() };
        const j = await logs.apiPost("/api/sonar/ping360/start", payload);
        writeSonarSetupConfig(j?.config || payload);
        await refreshSnapshotOnce().catch(() => { });
    } catch (e) {
        setSonarSetupAck(e?.message || "Errore start Ping360.");
    }
}

async function stopSonarScan() {
    try {
        setSonarSetupAck("Stopping Ping360...");
        const j = await logs.apiPost("/api/sonar/ping360/stop", {});
        writeSonarSetupConfig(j?.config || { ...(sonarCfg || {}), enabled: false });
        await refreshSnapshotOnce().catch(() => { });
    } catch (e) {
        setSonarSetupAck(e?.message || "Errore stop Ping360.");
    }
}

async function applySonarRange() {
    try {
        const payload = { ...(sonarCfg || readSonarSetupConfig()), range_m: sonarQuickRangeValue() };
        const j = await logs.apiPost("/api/sonar/ping360/config", payload);
        writeSonarSetupConfig(j?.config || payload);
        setSonarSetupAck("Ping360 range saved. Runtime restarted.");
        await refreshSnapshotOnce().catch(() => { });
    } catch (e) {
        setSonarSetupAck(e?.message || "Errore range Ping360.");
    }
}

function syncSonarRuntimeStatus() {
    const rt = snapshot?.sonar?.ping360 || {};
    const status = document.getElementById("sonar_status");
    if (status) {
        const enabled = rt.enabled !== false;
        const connected = !!rt.connected;
        const scanning = !!rt.scanning;
        status.textContent = !enabled ? "PING360 OFF" : (scanning ? "PING360 SCAN" : (connected ? "PING360 READY" : "PING360 WAIT"));
        status.style.borderColor = scanning ? "rgba(34, 197, 94, .55)" : (enabled ? "rgba(245, 158, 11, .55)" : "rgba(148, 163, 184, .35)");
        status.style.background = scanning ? "rgba(34, 197, 94, .18)" : (enabled ? "rgba(245, 158, 11, .12)" : "rgba(148, 163, 184, .12)");
    }

    const cfgStatus = document.getElementById("sonar_cfg_status");
    if (cfgStatus && snapshot?.sonar?.ping360) {
        const err = rt.last_err ? ` err=${rt.last_err}` : "";
        const rx = Number(rt.rx_total || snapshot?.counters?.ping360_rx || 0);
        cfgStatus.textContent = `host=${rt.host || "-"}:${rt.port || "-"} rx=${rx} tx=${rt.tx_total || 0}${err}`;
    }

    const range = Number(rt.range_m ?? sonarCfg?.range_m);
    const rangeLabel = document.getElementById("sonar_range_label");
    if (rangeLabel) rangeLabel.textContent = Number.isFinite(range) ? `range: ${range.toFixed(0)} m` : "range: -";
    const rangeInput = document.getElementById("sonar_range_m");
    if (rangeInput && document.activeElement !== rangeInput && Number.isFinite(range)) {
        rangeInput.value = String(Math.round(range));
    }

    const headingLock = document.getElementById("sonar_heading_lock");
    if (headingLock) headingLock.checked = !!uiPrefs.sonarHeadingLock;
    const heading = Number(snapshot?.nav?.heading_deg);
    if (window.sonarPing360) {
        window.sonarPing360.setOptions({
            headingLock: !!uiPrefs.sonarHeadingLock,
            headingDeg: Number.isFinite(heading) ? heading : 0,
            rangeM: Number.isFinite(range) ? range : Number(sonarCfg?.range_m || 60),
        });
    }
}

function applySetupUiPrefs(publishAck = true) {
    const prevBeepEnabled = !!uiPrefs.showAlarmBeep;
    const tabSel = document.getElementById("setup_default_tab");
    const tab = String(tabSel?.value || "vehicle");
    if (TAB_ORDER.includes(tab)) uiPrefs.mainTab = tab;

    const lightCfg = document.getElementById("setup_lights_cfg_collapsed");
    uiPrefs.lightsCfgCollapsed = !!lightCfg?.checked;
    const showLightsAck = document.getElementById("setup_show_lights_ack");
    uiPrefs.showLightsAck = !!showLightsAck?.checked;
    const showAlarmBeep = document.getElementById("setup_alarm_beep_enabled");
    uiPrefs.showAlarmBeep = !!showAlarmBeep?.checked;

    for (const w of WIDGETS) {
        const cb = document.getElementById(`setup_widget_${w.id}`);
        if (cb) uiPrefs.visible[w.id] = !!cb.checked;
    }

    saveUiPrefs(uiPrefs);
    applyWidgetVisibility();
    applyLightsAckVisibility();
    renderWidgetsMenu();

    const wrap = utils.el("lgt_cfg_body");
    const btn = utils.el("lgt_cfg_toggle");
    if (wrap && btn) {
        const hidden = !!uiPrefs.lightsCfgCollapsed;
        wrap.classList.toggle("hidden", hidden);
        wrap.style.display = hidden ? "none" : "";
        setChevronState(btn, hidden);
    }

    if (!prevBeepEnabled && uiPrefs.showAlarmBeep) {
        playAlarmBeep(true);
    }

    if (publishAck) {
        const ack = document.getElementById("setup_ui_ack");
        if (ack) ack.textContent = "UI settings saved.";
    }
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
            setChevronState(btn, col);
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
        setChevronState(b, isHidden);
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
    const suw = utils.el('setupWrap');
    if (mw)
        mw.classList.toggle('hidden', tab !== 'vehicle');
    if (tw)
        tw.classList.toggle('hidden', tab !== 'mission');
    if (vw)
        vw.classList.toggle('hidden', tab !== 'video');
    if (sw)
        sw.classList.toggle('hidden', tab !== 'sonar');
    if (suw)
        suw.classList.toggle('hidden', tab !== 'setup');
    if (tab === 'vehicle') {
        th3.ensure3D();
        return;
    }
    if (tab === 'mission') {
        refreshMissionTab().catch(() => { });
        return;
    }
    if (tab === 'video') {
        video.mountActiveVideo();
        return;
    }
    if (tab === 'sonar') {
        if (window.sonarPing360) window.sonarPing360.init();
        syncSonarRuntimeStatus();
        return;
    }
    if (tab === 'setup') {
        syncSetupTab();
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

function setupSetupTab() {
    if (setupWired) return;
    setupWired = true;

    const widgetsBox = document.getElementById("setup_widgets");
    if (widgetsBox) {
        widgetsBox.innerHTML = WIDGETS.map((w) =>
            `<label class="setupCheck"><input type="checkbox" id="setup_widget_${w.id}" data-wid="${w.id}"> ${w.title}</label>`
        ).join("");
    }

    const gpTable = document.getElementById("setup_gp_table");
    if (gpTable) {
        gpTable.innerHTML = GP_ACTIONS.map((a) => `
          <div class="setupGpRow">
            <div class="setupGpLabel">${a.label}</div>
            <select id="setup_gp_${a.key}">${gpSelectOptions(gpMap[a.key])}</select>
          </div>
        `).join("");
    }

    const saveUiBtn = document.getElementById("setup_ui_save");
    if (saveUiBtn) {
        saveUiBtn.onclick = () => applySetupUiPrefs(true);
    }

    const resetUiBtn = document.getElementById("setup_ui_reset");
    if (resetUiBtn) {
        resetUiBtn.onclick = () => {
            uiPrefs.mainTab = "vehicle";
            uiPrefs.visible = Object.fromEntries(WIDGETS.map((w) => [w.id, true]));
            uiPrefs.collapsed.alarms = true;
            uiPrefs.collapsed.lights = false;
            uiPrefs.collapsed.controller = false;
            uiPrefs.collapsed.motors = true;
            uiPrefs.collapsed.missionlog = true;
            uiPrefs.lightsCfgCollapsed = true;
            uiPrefs.showLightsAck = true;
            uiPrefs.showAlarmBeep = true;
            saveUiPrefs(uiPrefs);
            applyWidgetVisibility();
            applyLightsAckVisibility();
            renderWidgetsMenu();
            const wrap = utils.el('lgt_cfg_body');
            const btn = utils.el('lgt_cfg_toggle');
            if (wrap && btn) {
                const hidden = !!uiPrefs.lightsCfgCollapsed;
                wrap.classList.toggle('hidden', hidden);
                wrap.style.display = hidden ? 'none' : '';
                setChevronState(btn, hidden);
            }
            syncSetupTab();
            const ack = document.getElementById("setup_ui_ack");
            if (ack) ack.textContent = "UI settings reset to defaults.";
        };
    }

    const saveGpBtn = document.getElementById("setup_gp_save");
    if (saveGpBtn) {
        saveGpBtn.onclick = () => {
            const map = {};
            for (const a of GP_ACTIONS) {
                const sel = document.getElementById(`setup_gp_${a.key}`);
                const v = Number(sel?.value);
                map[a.key] = Number.isInteger(v) ? v : a.def;
            }
            const deviceSel = document.getElementById("setup_gp_device");
            const deviceIdx = Number(deviceSel?.value);
            saveGpMap(map);
            uiPrefs.gamepadIndex = Number.isInteger(deviceIdx) ? deviceIdx : -1;
            saveUiPrefs(uiPrefs);
            syncSetupTab();
            const ack = document.getElementById("setup_gp_ack");
            if (ack) ack.textContent = "Joystick settings saved.";
        };
    }

    const resetGpBtn = document.getElementById("setup_gp_reset");
    if (resetGpBtn) {
        resetGpBtn.onclick = () => {
            saveGpMap({ ...GP_DEFAULT_MAP });
            uiPrefs.gamepadIndex = -1;
            saveUiPrefs(uiPrefs);
            syncSetupTab();
            const ack = document.getElementById("setup_gp_ack");
            if (ack) ack.textContent = "Joystick settings reset.";
        };
    }

    const beepTestBtn = document.getElementById("setup_alarm_beep_test");
    if (beepTestBtn) {
        beepTestBtn.onclick = () => {
            ensureAlarmAudioUnlock();
            playAlarmBeep(true);
            const ack = document.getElementById("setup_ui_ack");
            if (ack) ack.textContent = "Alarm beep test triggered.";
        };
    }

    const autologCb = document.getElementById("setup_log_autostart_enabled");
    if (autologCb) {
        autologCb.addEventListener("change", () => {
            saveAutologSetupEnabled(true).catch(() => { });
        });
    }

    const sonarSaveBtn = document.getElementById("sonar_cfg_save");
    if (sonarSaveBtn) {
        sonarSaveBtn.onclick = () => saveSonarSetupConfig();
    }

    const sonarReloadBtn = document.getElementById("sonar_cfg_reload");
    if (sonarReloadBtn) {
        sonarReloadBtn.onclick = () => loadSonarSetupConfig(true);
    }

    const sonarStartBtn = document.getElementById("sonar_start");
    if (sonarStartBtn) {
        sonarStartBtn.onclick = () => startSonarScan();
    }

    const sonarStopBtn = document.getElementById("sonar_stop");
    if (sonarStopBtn) {
        sonarStopBtn.onclick = () => stopSonarScan();
    }

    const sonarRangeBtn = document.getElementById("sonar_range_apply");
    if (sonarRangeBtn) {
        sonarRangeBtn.onclick = () => applySonarRange();
    }

    const sonarHeadingLock = document.getElementById("sonar_heading_lock");
    if (sonarHeadingLock) {
        sonarHeadingLock.addEventListener("change", () => {
            uiPrefs.sonarHeadingLock = !!sonarHeadingLock.checked;
            saveUiPrefs(uiPrefs);
            syncSonarRuntimeStatus();
        });
    }

    const setupAutosaveIds = [
        "setup_default_tab",
        "setup_lights_cfg_collapsed",
        "setup_show_lights_ack",
        "setup_alarm_beep_enabled",
    ];
    for (const id of setupAutosaveIds) {
        const node = document.getElementById(id);
        if (node) node.addEventListener("change", () => applySetupUiPrefs(false));
    }
    for (const w of WIDGETS) {
        const cb = document.getElementById(`setup_widget_${w.id}`);
        if (cb) cb.addEventListener("change", () => applySetupUiPrefs(false));
    }

    syncSetupTab();
    loadAutologSetupConfig(false).catch(() => { });
    loadSonarSetupConfig(false).catch(() => { });
}

function syncSetupTab() {
    if (!setupWired) return;
    applyLightsAckVisibility();

    const tabSel = document.getElementById("setup_default_tab");
    if (tabSel) tabSel.value = TAB_ORDER.includes(uiPrefs.mainTab) ? uiPrefs.mainTab : "vehicle";

    const lightCfg = document.getElementById("setup_lights_cfg_collapsed");
    if (lightCfg) lightCfg.checked = !!uiPrefs.lightsCfgCollapsed;
    const showLightsAck = document.getElementById("setup_show_lights_ack");
    if (showLightsAck) showLightsAck.checked = !!uiPrefs.showLightsAck;
    const showAlarmBeep = document.getElementById("setup_alarm_beep_enabled");
    if (showAlarmBeep) showAlarmBeep.checked = !!uiPrefs.showAlarmBeep;
    syncAutologSetupControl();

    for (const w of WIDGETS) {
        const cb = document.getElementById(`setup_widget_${w.id}`);
        if (cb) cb.checked = !!uiPrefs.visible[w.id];
    }

    for (const a of GP_ACTIONS) {
        const sel = document.getElementById(`setup_gp_${a.key}`);
        if (sel) sel.value = String(gpMap[a.key]);
    }
    syncGamepadDeviceControl();
    syncSonarRuntimeStatus();
}

function setMainTab(tab) {
    const btn = document.querySelector(`.tab[data-tab="${tab}"]`);
    if (btn) btn.click();
}

function listConnectedGamepads() {
    const pads = navigator.getGamepads ? Array.from(navigator.getGamepads()) : [];
    return pads.filter((x) => !!x);
}

function gamepadDeviceOptionsHtml(pads, selectedIndex) {
    const sel = Number.isInteger(selectedIndex) ? selectedIndex : -1;
    const rows = [`<option value="-1" ${sel < 0 ? "selected" : ""}>Auto (first connected)</option>`];
    for (const gp of pads) {
        const idx = Number(gp?.index);
        const label = `#${idx} ${String(gp?.id || "Gamepad").trim() || "Gamepad"}`;
        rows.push(`<option value="${idx}" ${idx === sel ? "selected" : ""}>${escapeHtml(label)}</option>`);
    }
    return rows.join("");
}

function syncGamepadDeviceControl(pads = null) {
    const sel = document.getElementById("setup_gp_device");
    if (!sel) return;
    const list = Array.isArray(pads) ? pads.filter((x) => !!x) : listConnectedGamepads();
    const signature = list.map((gp) => `${gp.index}:${gp.id}`).join("|");
    const desired = Number.isInteger(uiPrefs.gamepadIndex) ? uiPrefs.gamepadIndex : -1;
    if (signature !== gpDeviceOptionsSignature) {
        gpDeviceOptionsSignature = signature;
        sel.innerHTML = gamepadDeviceOptionsHtml(list, desired);
    }
    sel.value = String(desired);
}

function pickConfiguredGamepad(pads) {
    const list = Array.isArray(pads) ? pads.filter((x) => !!x) : [];
    const wanted = Number(uiPrefs.gamepadIndex);
    if (Number.isInteger(wanted) && wanted >= 0) {
        return list.find((gp) => Number(gp?.index) === wanted) || null;
    }
    return list[0] || null;
}

function cycleMainTab(delta) {
    const cur = uiPrefs.mainTab || "vehicle";
    const i = Math.max(0, TAB_ORDER.indexOf(cur));
    const n = (i + delta + TAB_ORDER.length) % TAB_ORDER.length;
    setMainTab(TAB_ORDER[n]);
}

function gamepadButtonPressed(buttons, idx) {
    if (!Number.isInteger(idx) || idx < 0) return false;
    return !!buttons[idx];
}

function gamepadEdge(buttons, idx) {
    return gamepadButtonPressed(buttons, idx) && !gpPrevButtons[idx];
}

function setGpLightChannel(ch) {
    const n = Math.max(1, Math.min(4, Number(ch) || 1));
    gpLightCh = n;
    highlightGpLightChannel();
}

function highlightGpLightChannel() {
    for (let k = 1; k <= 4; k++) {
        const card = document.getElementById(`lgt_ch_${k}`);
        if (!card) continue;
        if (k === gpLightCh) {
            card.style.outline = "2px solid rgba(45,107,255,.8)";
            card.style.outlineOffset = "2px";
        } else {
            card.style.outline = "";
            card.style.outlineOffset = "";
        }
    }
}

function gpCurrentDim() {
    const slider = document.getElementById(`lgt_dim_${gpLightCh}`);
    if (!slider) return 0;
    const v = parseInt(slider.value || "0", 10);
    return Number.isFinite(v) ? Math.max(0, Math.min(1000, v)) : 0;
}

async function gpSendLight(mode) {
    if (gpBusyLight) return;
    gpBusyLight = true;
    try {
        const dim = mode === "OFF" ? 0 : gpCurrentDim();
        await lights.sendLightsChannel(gpLightCh, mode, dim);
    } catch (e) {
        console.warn("gamepad lights error", e);
    } finally {
        gpBusyLight = false;
    }
}

async function gpAddMarkerEvent() {
    if (gpBusyEvent) return;
    gpBusyEvent = true;
    try {
        const input = document.getElementById("mission_event_text");
        const ack = document.getElementById("mission_event_ack");
        const text = String(input?.value || "").trim() || `MARK joystick ${new Date().toISOString()}`;
        await logs.apiPost("/api/log/event", { type: "MARK", text });
        if (input) input.value = "";
        if (ack) ack.textContent = "Evento joystick salvato.";
        await refreshMissionTab().catch(() => { });
    } catch (e) {
        const ack = document.getElementById("mission_event_ack");
        if (ack) ack.textContent = e?.message || "Errore evento joystick";
    } finally {
        gpBusyEvent = false;
    }
}

async function gpToggleLogging() {
    if (gpBusyLog) return;
    gpBusyLog = true;
    try {
        const s = await fetch("/api/log/status").then((r) => r.json());
        await logs.apiPost(s?.enabled ? "/api/log/stop" : "/api/log/start");
        await logs.refreshLogStatus().catch(() => { });
        await logs.refreshLogSessions().catch(() => { });
        await refreshMissionTab().catch(() => { });
    } catch (e) {
        console.warn("gamepad logging error", e);
    } finally {
        gpBusyLog = false;
    }
}

function cancelGpVmotHold() {
    if (!gpVmotHoldActive) return;
    gpVmotHoldActive = false;
    gpVmotLastBeepSec = -1;
    if (!vmotHoldActive) vmotEnableUi(0);
}

function updateGpVmotHold(buttons) {
    const idx = Number(gpMap.vmot_enable_hold);
    if (!Number.isInteger(idx) || idx < 0 || vmotCmdBusy || vmotHoldActive) {
        cancelGpVmotHold();
        return;
    }

    const pressed = gamepadButtonPressed(buttons, idx);
    if (!pressed) {
        cancelGpVmotHold();
        return;
    }

    ensureAlarmAudioUnlock();
    if (!gpVmotHoldActive) {
        gpVmotHoldActive = true;
        gpVmotHoldStartMs = performance.now();
        gpVmotLastBeepSec = -1;
        vmotEnableUi(0, "ENABLE VMOT GP (3s hold)");
    }

    const elapsed = Math.max(0, performance.now() - gpVmotHoldStartMs);
    const progress = Math.min(1, elapsed / VMOT_ENABLE_HOLD_MS);
    const remainSec = Math.max(0, Math.ceil((VMOT_ENABLE_HOLD_MS - elapsed) / 1000));
    vmotEnableUi(progress, `ENABLE VMOT GP (${remainSec}s)`);

    const sec = Math.floor(elapsed / 1000);
    if (sec > gpVmotLastBeepSec && sec > 0) {
        gpVmotLastBeepSec = sec;
        playUiBeep(740, 0.12, 0.06, true);
    }

    if (elapsed >= VMOT_ENABLE_HOLD_MS) {
        gpVmotHoldActive = false;
        gpVmotLastBeepSec = -1;
        vmotEnableUi(1, "ENABLE VMOT (sending...)");
        sendVmotMaster(1).finally(() => vmotEnableUi(0));
    }
}

function setupJoystickControls() {
    if (gpLoopStarted) return;
    gpLoopStarted = true;

    const loop = () => {
        try {
            const pads = listConnectedGamepads();
            syncGamepadDeviceControl(pads);
            const gp = pickConfiguredGamepad(pads);
            if (!gp) {
                gpPrevButtons = [];
                cancelGpVmotHold();
                const status = document.getElementById("setup_gp_status");
                const wanted = Number(uiPrefs.gamepadIndex);
                if (status) {
                    status.textContent = wanted >= 0
                        ? `Selected gamepad #${wanted} not connected.`
                        : "No gamepad connected.";
                }
                requestAnimationFrame(loop);
                return;
            }

            const buttons = (gp.buttons || []).map((b) => !!(b && b.pressed));
            const status = document.getElementById("setup_gp_status");
            if (status) {
                const mode = Number(uiPrefs.gamepadIndex) >= 0 ? "Selected" : "Auto";
                status.textContent = `${mode}: #${gp.index} ${gp.id} | buttons: ${buttons.length}`;
            }

            if (gamepadEdge(buttons, gpMap.tab_prev)) cycleMainTab(-1);
            if (gamepadEdge(buttons, gpMap.tab_next)) cycleMainTab(1);
            if (gamepadEdge(buttons, gpMap.light_ch_prev)) setGpLightChannel(gpLightCh - 1);
            if (gamepadEdge(buttons, gpMap.light_ch_next)) setGpLightChannel(gpLightCh + 1);
            if (gamepadEdge(buttons, gpMap.light_on)) gpSendLight("ON");
            if (gamepadEdge(buttons, gpMap.light_off)) gpSendLight("OFF");
            if (gamepadEdge(buttons, gpMap.vmot_disable)) {
                cancelGpVmotHold();
                cancelVmotHold();
                sendVmotMaster(0);
            }
            updateGpVmotHold(buttons);
            if (gamepadEdge(buttons, gpMap.add_mark)) gpAddMarkerEvent();
            if (gamepadEdge(buttons, gpMap.toggle_log)) gpToggleLogging();
            if (gamepadEdge(buttons, gpMap.video_stream_1)) video.selectVideoStream(0);
            if (gamepadEdge(buttons, gpMap.video_stream_2)) video.selectVideoStream(1);
            if (gamepadEdge(buttons, gpMap.video_stream_3)) video.selectVideoStream(2);
            if (gamepadEdge(buttons, gpMap.tab_cycle)) cycleMainTab(1);

            gpPrevButtons = buttons;
        } catch (e) {
            console.warn("gamepad loop error", e);
        }
        requestAnimationFrame(loop);
    };

    requestAnimationFrame(loop);
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
        setChevronState(btn, hidden);
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


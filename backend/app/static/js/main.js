import * as utils from './utils.js?v=16';
import { scadaSvg } from './power.js?v=17';
import * as lights from './lights.js?v=3';
import * as thrusters from './thrusters.js';
import * as video from './video.js?v=18';
import * as th3 from './three3d.js';
import * as logs from './logs.js';

let snapshot = null;
let missionRefreshTimer = null;
let diagnosticsRefreshTimer = null;
let missionTabWired = false;
let missionCurrentSid = null;
let missionMetaAppliedSid = null;
let gpLoopStarted = false;
let gpPrevButtons = [];
let ctrlPrevSignals = {};
let ctrlSignalsPrimed = false;
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
let shutdownHoldTimer = null;
let shutdownHoldActive = false;
let shutdownHoldStartMs = 0;
let shutdownLastBeepSec = -1;
let shutdownCmdBusy = false;
let stroboCmdBusy = false;
let gpVmotHoldActive = false;
let gpVmotHoldStartMs = 0;
let gpVmotLastBeepSec = -1;
let gpDeviceOptionsSignature = "";
let autologCfg = { enabled: true, depth_m: null, hyst_m: null };
let sonarCfg = null;

const INPUT_SOURCE_BROKER = "broker";
const INPUT_SOURCE_BROWSER = "browser_gamepad";
const VMOT_ENABLE_HOLD_MS = 3000;
const SHUTDOWN_HOLD_MS = 3000;
const VMOT_ACK_TIMEOUT_MS = 3000;
const VMOT_ACK_POLL_MS = 120;
const STROBO_ACK_TIMEOUT_MS = 3000;
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
const SONAR_RANGE_PRESETS = [5, 10, 15, 30, 60];
const SONAR_SCAN_PRESETS = [90, 130, 180, 360];
const SONAR_RESOLUTION_PRESETS = {
    low: { num_samples: 400, num_steps: 3, label: "LOW" },
    med: { num_samples: 800, num_steps: 2, label: "MED" },
    high: { num_samples: 1200, num_steps: 1, label: "HIGH" },
};
const SONAR_PALETTE_PRESETS = ["jet", "parula", "copper", "bw"];

const TAB_ORDER = ["vehicle", "mission", "video", "sonar", "diagnostics", "setup"];
const GP_ACTIONS = [
    { key: "tab_prev", label: "Tab precedente", def: 14 },
    { key: "tab_next", label: "Tab successivo", def: 15 },
    { key: "light_ch_prev", label: "Canale luce precedente", def: 12 },
    { key: "light_ch_next", label: "Canale luce successivo", def: 13 },
    { key: "light_on", label: "Luce ON (dim corrente)", def: 0 },
    { key: "light_off", label: "Luce OFF", def: 1 },
    { key: "strobo_toggle", label: "STROBO toggle master", def: -1 },
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

const DIAG_ALARM_CATALOG = [
    { key: "100", id: 100, label: "ALM_I2C_ERROR", description: "Errore comunicazione I2C locale." },
    { key: "110", id: 110, label: "ALM_PEER_LOST", description: "Nodo peer non raggiungibile." },
    { key: "120", id: 120, label: "ALM_CAN_BUS", description: "Anomalia bus CAN." },
    { key: "200", id: 200, label: "ALM_LEAK", description: "Leak sensor attivo." },
    { key: "210", id: 210, label: "ALM_OVERTEMP", description: "Temperatura oltre soglia." },
    { key: "300", id: 300, label: "ALM_VBUS_LOW", description: "VBUS sotto soglia." },
    { key: "310", id: 310, label: "ALM_DV_HIGH", description: "Delta tensione batterie troppo alto." },
    { key: "320", id: 320, label: "ALM_PWR_FAULT", description: "Fault logica power switch." },
    { key: "400", label: "ALM_VESC_LOST", description: "Telemetria persa su ESC specifico.", match: (a) => {
        const id = Number(a?.id);
        return (Number.isFinite(id) && id >= 401 && id <= 499) || /VESC_LOST|ESC/i.test(String(a?.text || ""));
    } },
    { key: "9001", id: 9001, label: "NODE_OFFLINE", description: "Nodo senza heartbeat oltre soglia." },
    { key: "BUSCONN", label: "BUSCONN_OFF", description: "POD online ma non collegato al bus.", match: (a) => /BUSCONN|BUS OFF|BUS OFFLINE/i.test(String(a?.text || "")) },
    { key: "VMOT", label: "VMOT_FAULT", description: "Fault o blocco sequenza VMOT.", match: (a) => /VMOT|MOTOR/i.test(String(a?.text || "")) },
    { key: "LGT0", label: "LGT_OPENLED", description: "Fault pin OPENLED attivo.", lightFault: "OPENLED" },
    { key: "LGT1", label: "LGT_OVERTEMP", description: "Temperatura hardware o LED oltre soglia.", lightFault: "OVERTEMP" },
    { key: "LGT2", label: "LGT_OVERCURR", description: "Corrente bus oltre soglia.", lightFault: "OVERCURR" },
    { key: "LGT3", label: "LGT_UNDERVOLT", description: "Tensione bus sotto soglia.", lightFault: "UNDERVOLT" },
    { key: "LGT4", label: "LGT_INA_ALERT", description: "Diagnostica INA238 in fault.", lightFault: "INA_ALERT" },
];

const LIGHT_FAULT_INFO = [
    { bit: 0, value: 0x00000001, name: "OPENLED", description: "Fault pin OPENLED attivo." },
    { bit: 1, value: 0x00000002, name: "OVERTEMP", description: "Temperatura hardware o LED oltre soglia." },
    { bit: 2, value: 0x00000004, name: "OVERCURR", description: "Corrente bus oltre soglia." },
    { bit: 3, value: 0x00000008, name: "UNDERVOLT", description: "Tensione bus sotto soglia." },
    { bit: 4, value: 0x00000010, name: "INA_ALERT", description: "Diagnostica INA238 in fault." },
];

const INA238_DIAG_BITS = [
    { bit: 9, value: 0x0200, name: "MATHOF", description: "Overflow matematico: corrente/potenza possono essere non validi." },
    { bit: 7, value: 0x0080, name: "TMPOL", description: "Temperatura oltre soglia TEMP_LIMIT." },
    { bit: 6, value: 0x0040, name: "SHNTOL", description: "Tensione shunt sopra soglia SOVL." },
    { bit: 5, value: 0x0020, name: "SHNTUL", description: "Tensione shunt sotto soglia SUVL." },
    { bit: 4, value: 0x0010, name: "BUSOL", description: "Tensione bus sopra soglia BOVL." },
    { bit: 3, value: 0x0008, name: "BUSUL", description: "Tensione bus sotto soglia BUVL." },
    { bit: 2, value: 0x0004, name: "POL", description: "Potenza oltre soglia PWR_LIMIT." },
    { bit: 1, value: 0x0002, name: "CNVRF", description: "Conversione completata; informativo.", info: true },
    { bit: 0, value: 0x0001, name: "MEMSTAT", description: "Memoria trim OK quando vale 1; errore checksum quando vale 0.", inverted: true },
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

function normalizeCtrlMap(raw) {
    const out = Object.fromEntries(GP_ACTIONS.map((x) => [x.key, ""]));
    const src = (raw && typeof raw === "object") ? raw : {};
    for (const it of GP_ACTIONS) {
        const v = typeof src[it.key] === "string" ? src[it.key].trim() : "";
        out[it.key] = v;
    }
    return out;
}

function loadCtrlMap() {
    try {
        const raw = JSON.parse(localStorage.getItem("calypso_ctrl_map") || "{}");
        return normalizeCtrlMap(raw);
    } catch {
        return normalizeCtrlMap({});
    }
}

function saveCtrlMap(map) {
    ctrlMap = normalizeCtrlMap(map);
    localStorage.setItem("calypso_ctrl_map", JSON.stringify(ctrlMap));
}

function gpSelectOptions(selected) {
    let html = `<option value="-1">Disabled</option>`;
    for (let i = 0; i <= 15; i++) {
        html += `<option value="${i}" ${Number(selected) === i ? "selected" : ""}>Button ${i}</option>`;
    }
    return html;
}

function currentInputSource() {
    return uiPrefs.inputSource === INPUT_SOURCE_BROWSER ? INPUT_SOURCE_BROWSER : INPUT_SOURCE_BROKER;
}

function controllerSignalIsActive(v) {
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return Number.isFinite(v) && v !== 0;
    if (typeof v === "string") {
        const tok = v.trim().toLowerCase();
        if (!tok || tok === "0" || tok === "false" || tok === "off" || tok === "no") return false;
        const n = Number(tok);
        if (Number.isFinite(n)) return n !== 0;
        return true;
    }
    return !!v;
}

function controllerSignalOptions(ctrl = null) {
    const source = ctrl || snapshot?.controller || {};
    const groups = [
        ["buttons", source.buttons || {}],
        ["switches", source.switches || {}],
        ["mapped", source.mapped || {}],
    ];
    const items = [];
    for (const [group, values] of groups) {
        const keys = Object.keys(values || {}).sort();
        for (const key of keys) {
            const value = values[key];
            const active = controllerSignalIsActive(value);
            const shown = typeof value === "boolean"
                ? (value ? "ON" : "OFF")
                : (typeof value === "number" ? fmtControllerValue(value, 2) : String(value));
            items.push({
                value: `${group}.${key}`,
                label: `${group}.${key} (${shown}${active ? ", active" : ""})`,
            });
        }
    }
    return items;
}

function controllerSelectOptions(selected, ctrl = null) {
    const selectedValue = typeof selected === "string" ? selected : "";
    const options = controllerSignalOptions(ctrl);
    let html = `<option value="">Disabled</option>`;
    let hasSelected = selectedValue === "";
    for (const opt of options) {
        const isSelected = opt.value === selectedValue;
        if (isSelected) hasSelected = true;
        html += `<option value="${escapeHtml(opt.value)}" ${isSelected ? "selected" : ""}>${escapeHtml(opt.label)}</option>`;
    }
    if (!hasSelected && selectedValue) {
        html += `<option value="${escapeHtml(selectedValue)}" selected>${escapeHtml(selectedValue)} (missing)</option>`;
    }
    return html;
}

let ctrlMap = loadCtrlMap();

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

function stroboAckText(state) {
    if (stroboCmdBusy) return "STROBO...";
    if (state?.pending) return "STROBO WAIT";
    if (state?.on === 1 || state?.on === "1") return "STROBO ON";
    if (state?.on === 0 || state?.on === "0") return "STROBO OFF";
    return "STROBO -";
}

function renderStroboButton(state) {
    const btn = document.getElementById("btn_strobo");
    if (!btn) return;

    const strobo = state?.strobo || {};
    const isOn = strobo.on === 1 || strobo.on === "1";
    const isPending = stroboCmdBusy || !!strobo.pending;
    btn.textContent = stroboAckText(strobo);
    btn.disabled = isPending;
    btn.classList.toggle("active", isOn);
    btn.classList.toggle("busy", isPending);

    const meta = [];
    if (strobo.last_ack?.text) meta.push(String(strobo.last_ack.text));
    if (strobo.last_error) meta.push(String(strobo.last_error));
    btn.title = meta.join(" | ") || `Master pod ${isOn ? "strobo attiva" : "strobo disattiva"}`;
}

function shutdownState() {
    return snapshot?.system?.shutdown || {};
}

function isShutdownInProgress() {
    return !!shutdownState()?.in_progress;
}

function shutdownHoldUi(progress, text = null) {
    const btn = document.getElementById("btn_shutdown_hold");
    const fill = document.getElementById("shutdown_hold_fill");
    const label = document.getElementById("shutdown_hold_text");
    if (!btn || !fill || !label) return;

    const p = Math.max(0, Math.min(1, Number(progress) || 0));
    fill.style.width = `${(p * 100).toFixed(1)}%`;
    btn.classList.toggle("holding", shutdownHoldActive);
    btn.classList.toggle("busy", shutdownCmdBusy || isShutdownInProgress());
    btn.disabled = shutdownCmdBusy || isShutdownInProgress();
    label.textContent = text || (isShutdownInProgress() ? "SHUTDOWN IN PROGRESS" : "SHUTDOWN ROV (hold 3s)");
}

function renderShutdownOverlay(state) {
    const overlay = document.getElementById("shutdown_overlay");
    const text = document.getElementById("shutdown_overlay_text");
    if (!overlay || !text) return;

    const shdn = state?.system?.shutdown || {};
    const active = !!shdn.in_progress;
    overlay.classList.toggle("hidden", !active);
    if (!active) {
        text.textContent = "Master pod received shutdown request. Waiting for Raspberry Pi power-down sequence.";
        shutdownHoldUi(0);
        return;
    }

    const parts = [
        "Master pod received shutdown request.",
        shdn.requested_by ? `source=${shdn.requested_by}` : "",
        shdn.cmd_id != null ? `CmdId=${shdn.cmd_id}` : "",
        shdn.host ? `host=${shdn.host}` : "",
        "Waiting for Raspberry Pi power-down sequence.",
    ].filter(Boolean);
    text.textContent = parts.join(" ");
    shutdownHoldUi(1, "SHUTDOWN IN PROGRESS");
}

function renderCommandLocks(state) {
    const locked = !!(state?.system?.shutdown?.in_progress);
    for (const id of [
        "btn_strobo",
        "vmot_enable_hold",
        "vmot_disable_now",
        "mission_log_start",
        "mission_log_stop",
        "mission_event_add",
        "mission_meta_save",
        "sonar_start",
        "sonar_stop",
        "sonar_clear",
        "sonar_cfg_save",
        "sonar_cfg_reload",
        "video_stop",
    ]) {
        const node = document.getElementById(id);
        if (!node) continue;
        if (id === "btn_shutdown_hold") continue;
        node.disabled = locked || !!node.disabled;
    }
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
    if (isShutdownInProgress()) return false;
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

async function sendStrobo(enable) {
    if (isShutdownInProgress()) return false;
    if (stroboCmdBusy) return false;
    stroboCmdBusy = true;
    renderStroboButton(snapshot);
    try {
        const on = Number(enable) === 1 ? 1 : 0;
        const r = await fetch("/api/cmd/strobo", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ on }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j?.ok) return false;

        const ack = await waitCmdAck(j.cmd_id, STROBO_ACK_TIMEOUT_MS).catch(() => null);
        if (!ack) return false;

        await refreshSnapshotOnce().catch(() => { });
        return Number(ack.ok) === 1;
    } catch {
        return false;
    } finally {
        await refreshSnapshotOnce().catch(() => { });
        stroboCmdBusy = false;
        renderStroboButton(snapshot);
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

function setupStroboControls() {
    const btn = document.getElementById("btn_strobo");
    if (!btn) return;
    if (!btn.dataset.wired) {
        btn.dataset.wired = "1";
        btn.addEventListener("click", async () => {
            const current = snapshot?.strobo?.on;
            const next = (current === 1 || current === "1") ? 0 : 1;
            await sendStrobo(next);
        });
    }
    renderStroboButton(snapshot);
}

function cancelShutdownHold() {
    if (!shutdownHoldActive) return;
    shutdownHoldActive = false;
    if (shutdownHoldTimer != null) {
        cancelAnimationFrame(shutdownHoldTimer);
        shutdownHoldTimer = null;
    }
    shutdownHoldUi(0);
}

async function requestVehicleShutdown() {
    if (shutdownCmdBusy || isShutdownInProgress()) return false;
    shutdownCmdBusy = true;
    shutdownHoldUi(1, "SHUTDOWN ROV (sending...)");

    try {
        if (snapshot?.logging?.enabled) {
            await logs.apiPost("/api/log/event", { type: "SHDN", text: "Vehicle shutdown requested from UI" }).catch(() => { });
        }
        await logs.refreshLogStatus().catch(() => { });
        await logs.refreshLogSessions().catch(() => { });

        await logs.apiPost("/api/sonar/ping360/stop", {}).catch(() => { });
        if (window.sonarPing360?.clear) window.sonarPing360.clear();
        video.unmountVideo();

        const j = await logs.apiPost("/api/cmd/shutdown", { requested_by: "ui" });
        snapshot = snapshot || {};
        snapshot.system = snapshot.system || {};
        snapshot.system.shutdown = j?.shutdown || {
            in_progress: true,
            cmd_id: j?.cmd_id ?? null,
            requested_by: "ui",
        };
        render(snapshot);
        return true;
    } catch (e) {
        shutdownHoldUi(0, e?.message || "SHUTDOWN ROV (error)");
        return false;
    } finally {
        shutdownCmdBusy = false;
        shutdownHoldUi(0);
    }
}

function shutdownHoldStep() {
    if (!shutdownHoldActive) return;
    const elapsed = Math.max(0, performance.now() - shutdownHoldStartMs);
    const progress = Math.min(1, elapsed / SHUTDOWN_HOLD_MS);
    const remainSec = Math.max(0, Math.ceil((SHUTDOWN_HOLD_MS - elapsed) / 1000));
    shutdownHoldUi(progress, `SHUTDOWN ROV (${remainSec}s)`);

    const sec = Math.floor(elapsed / 1000);
    if (sec > shutdownLastBeepSec && sec > 0) {
        shutdownLastBeepSec = sec;
        playUiBeep(620, 0.12, 0.07, true);
    }

    if (elapsed >= SHUTDOWN_HOLD_MS) {
        shutdownHoldActive = false;
        shutdownHoldTimer = null;
        shutdownHoldUi(1, "SHUTDOWN ROV (sending...)");
        requestVehicleShutdown();
        return;
    }

    shutdownHoldTimer = requestAnimationFrame(shutdownHoldStep);
}

function startShutdownHold(ev) {
    if (shutdownCmdBusy || shutdownHoldActive || isShutdownInProgress()) return;
    ensureAlarmAudioUnlock();
    shutdownHoldActive = true;
    shutdownHoldStartMs = performance.now();
    shutdownLastBeepSec = -1;
    shutdownHoldUi(0, "SHUTDOWN ROV (3s hold)");

    const btn = document.getElementById("btn_shutdown_hold");
    if (btn && ev && typeof ev.pointerId === "number" && btn.setPointerCapture) {
        try { btn.setPointerCapture(ev.pointerId); } catch { }
    }

    shutdownHoldTimer = requestAnimationFrame(shutdownHoldStep);
}

function setupShutdownControls() {
    const btn = document.getElementById("btn_shutdown_hold");
    if (!btn || btn.dataset.wired) {
        shutdownHoldUi(0);
        return;
    }

    btn.dataset.wired = "1";
    btn.addEventListener("pointerdown", (ev) => {
        ev.preventDefault();
        startShutdownHold(ev);
    });
    btn.addEventListener("pointerup", () => cancelShutdownHold());
    btn.addEventListener("pointercancel", () => cancelShutdownHold());
    btn.addEventListener("lostpointercapture", () => cancelShutdownHold());
    btn.addEventListener("contextmenu", (ev) => ev.preventDefault());
    shutdownHoldUi(0);
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

function faultInfoByName(name) {
    return LIGHT_FAULT_INFO.find((f) => f.name === name) || null;
}

function renderHelpLightFaults(state) {
    const box = document.getElementById("help_light_faults");
    if (!box) return;

    const active = Object.values(state?.lights?.faults_active || {});
    const history = Array.isArray(state?.lights?.faults_history) ? state.lights.faults_history : [];
    if (!active.length && !history.length) {
        box.innerHTML = "Nessun fault fari rilevato.";
        return;
    }

    const activeKeys = new Set(active.map((evt) => `${evt.light_id}:${evt.name}`));
    const latestByKey = new Map();
    for (const evt of history) {
        const key = `${evt.light_id}:${evt.name}`;
        const prev = latestByKey.get(key);
        if (!prev || Number(evt.ts_ms || 0) >= Number(prev.ts_ms || 0)) latestByKey.set(key, evt);
    }
    for (const evt of active) latestByKey.set(`${evt.light_id}:${evt.name}`, evt);

    const rows = Array.from(latestByKey.values())
        .sort((a, b) => Number(a.light_id || 0) - Number(b.light_id || 0) || String(a.name || "").localeCompare(String(b.name || "")))
        .map((evt) => {
            const key = `${evt.light_id}:${evt.name}`;
            const info = faultInfoByName(String(evt.name || ""));
            const status = activeKeys.has(key) ? "ATTIVO" : "RIENTRATO";
            const statusClass = activeKeys.has(key) ? "bad" : "warn";
            const value = info ? `0x${Number(info.value).toString(16).toUpperCase().padStart(8, "0")}` : `0x${Number(evt.value || 0).toString(16).toUpperCase().padStart(8, "0")}`;
            return `<div>
                <span class="diagStatusBadge ${statusClass}">${status}</span>
                <b>${escapeHtml(evt.src || `LGT${evt.light_id}`)}</b>
                ${escapeHtml(evt.name || "-")} ${escapeHtml(value)}
                <span style="opacity:.85;">${escapeHtml(info?.description || "")}</span>
            </div>`;
        });
    box.innerHTML = rows.join("<hr style=\"border:0;border-top:1px solid rgba(255,255,255,.08);margin:8px 0;\">");
}

function parseDiagMaskValue(value) {
    if (value == null || value === "") return null;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    const raw = String(value).trim();
    if (!raw) return null;
    const parsed = Number.parseInt(raw, raw.toLowerCase().startsWith("0x") ? 16 : 10);
    return Number.isFinite(parsed) ? parsed : null;
}

function extractInaMask(row) {
    if (!row || typeof row !== "object") return null;
    const keys = [
        "InaDiag", "INADiag", "INA_DIAG", "InaDiagAlrt", "INADiagAlrt",
        "DIAG_ALRT", "DiagAlrt", "DiagAlert", "InaFault", "INAFault",
        "InaFaultCode", "INAFaultCode", "InaAlert", "INAAlert",
    ];
    for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(row, key)) {
            const parsed = parseDiagMaskValue(row[key]);
            if (parsed != null) return parsed;
        }
    }
    return null;
}

function decodeInaMask(mask) {
    const out = [];
    for (const bit of INA238_DIAG_BITS) {
        const set = (mask & bit.value) !== 0;
        const active = bit.inverted ? !set : (set && !bit.info);
        const info = bit.info && set;
        if (active || info) out.push({ ...bit, active, info });
    }
    return out;
}

function renderHelpInaFaults(state) {
    const box = document.getElementById("help_ina_faults");
    if (!box) return;

    const rows = [];
    for (const [podName, pod] of Object.entries(state?.pods || {})) {
        const mask = extractInaMask(pod);
        if (mask == null) continue;
        const decoded = decodeInaMask(mask);
        if (!decoded.length) continue;
        rows.push({ source: podName, mask, decoded });
    }
    for (const [id, light] of Object.entries(state?.lights?.ids || {})) {
        const mask = extractInaMask(light);
        if (mask == null) continue;
        const decoded = decodeInaMask(mask);
        if (!decoded.length) continue;
        rows.push({ source: light.src || `LGT${id}`, mask, decoded });
    }

    if (!rows.length) {
        box.innerHTML = "Nessun codice INA rilevato in telemetria.";
        return;
    }

    box.innerHTML = rows.map((row) => {
        const flags = row.decoded.map((bit) => {
            const cls = bit.info ? "warn" : "bad";
            const label = bit.info ? "INFO" : "FAULT";
            return `<div>
                <span class="diagStatusBadge ${cls}">${label}</span>
                <b>${escapeHtml(bit.name)}</b> bit ${escapeHtml(bit.bit)}
                <span style="opacity:.85;">${escapeHtml(bit.description)}</span>
            </div>`;
        }).join("");
        return `<div><b>${escapeHtml(row.source)}</b> DIAG_ALRT=0x${Number(row.mask).toString(16).toUpperCase().padStart(4, "0")}</div>${flags}`;
    }).join("<hr style=\"border:0;border-top:1px solid rgba(255,255,255,.08);margin:8px 0;\">");
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

function fmtAgeMs(ms) {
    const v = Number(ms);
    if (!Number.isFinite(v)) return "-";
    if (v < 1000) return `${Math.round(v)} ms`;
    if (v < 60000) return `${(v / 1000).toFixed(1)} s`;
    return fmtDuration(v / 1000);
}

function diagLedHtml(kind, label) {
    return `<span class="diagLed ${kind}" aria-label="${escapeHtml(label)}"></span>`;
}

function diagKindFromRow(row) {
    if (row?.status_kind) return String(row.status_kind);
    const ok = !!row?.network_ok && row?.online !== false;
    return ok ? "ok" : "bad";
}

function diagStatusText(row) {
    if (row?.status_text) return String(row.status_text);
    const kind = diagKindFromRow(row);
    if (kind === "ok") return "ONLINE";
    if (kind === "warn") return "WAIT";
    if (kind === "muted") return "CONFIG";
    return "OFFLINE";
}

function parseDeviceUrl(url) {
    const raw = String(url || "").trim();
    if (!raw) return { href: "", host: "" };
    try {
        const u = new URL(raw, window.location.origin);
        return { href: raw, host: u.hostname || raw };
    } catch {
        return { href: raw, host: raw };
    }
}

function cameraDiagnosticRows() {
    const streams = Array.isArray(video.videoState?.streams) ? video.videoState.streams : [];
    const activeIndex = Number(video.videoState?.activeIndex ?? 0);
    const activeStatus = String(document.getElementById("video_status")?.textContent || "");
    return streams.map((stream, index) => {
        const label = `CAM_${index + 1}`;
        const url = String(stream?.url || "").trim();
        const kind = String(stream?.kind || "auto").toUpperCase();
        if (!url) {
            return {
                node: label,
                kind: "Camera",
                role: kind,
                status_kind: "muted",
                status_text: "NO URL",
                detail: "Stream non configurato.",
            };
        }

        let statusKind = "warn";
        let statusText = "CONFIG";
        if (index === activeIndex && !video.videoState?.isStopped) {
            if (/OK|LIVE/i.test(activeStatus)) {
                statusKind = "ok";
                statusText = "LIVE";
            } else if (/ERR|ERROR/i.test(activeStatus)) {
                statusKind = "bad";
                statusText = "ERROR";
            } else {
                statusText = "SELECTED";
            }
        }
        const parsed = parseDeviceUrl(url);
        return {
            node: label,
            kind: "Camera",
            role: kind,
            status_kind: statusKind,
            status_text: statusText,
            ip: parsed.host,
            url: parsed.href,
            detail: url,
        };
    });
}

function diagAlarmActive(a) {
    return Number(a?.active ?? 1) !== 0;
}

function diagAlarmMatches(def, alarm) {
    if (typeof def.match === "function") return !!def.match(alarm);
    if (def.id != null) return Number(alarm?.id) === Number(def.id);
    return false;
}

function latestEvent(events) {
    return events.reduce((best, evt) => {
        const bestTs = Number(best?.ts_ms ?? -Infinity);
        const evtTs = Number(evt?.ts_ms ?? -Infinity);
        return evtTs >= bestTs ? evt : best;
    }, null);
}

function uniqText(items) {
    return Array.from(new Set(items.filter(Boolean).map((x) => String(x)))).join(", ");
}

function diagCatalogStatus(def, state, active, history, nowTs) {
    if (def.lightFault) {
        const activeValues = Object.values(state?.lights?.faults_active || {});
        const faultHistory = Array.isArray(state?.lights?.faults_history) ? state.lights.faults_history : [];
        const activeHits = activeValues.filter((a) => String(a?.name) === def.lightFault && diagAlarmActive(a));
        const historyHits = faultHistory.filter((a) => String(a?.name) === def.lightFault);
        const ref = activeHits.length ? latestEvent(activeHits) : latestEvent(historyHits);
        const sources = activeHits.length
            ? uniqText(activeHits.map((a) => a.src || `LGT${a.light_id}`))
            : (ref?.src || "-");
        return {
            statusClass: activeHits.length ? "bad" : (ref ? "warn" : "ok"),
            statusText: activeHits.length ? "ATTIVO" : (ref ? "RIENTRATO" : "OK"),
            src: sources || "-",
            age: (ref?.ts_ms != null && Number.isFinite(nowTs))
                ? fmtAgeMs(Math.max(0, nowTs - Number(ref.ts_ms)))
                : "-",
        };
    }

    const activeHit = active.find((a) => diagAlarmMatches(def, a) && diagAlarmActive(a));
    const lastHit = [...history].reverse().find((a) => diagAlarmMatches(def, a));
    const ref = activeHit || lastHit || null;
    return {
        statusClass: activeHit ? "bad" : (lastHit ? "warn" : "ok"),
        statusText: activeHit ? "ATTIVO" : (lastHit ? "RIENTRATO" : "OK"),
        src: ref?.src || "-",
        age: (ref?.ts_ms != null && Number.isFinite(nowTs))
            ? fmtAgeMs(Math.max(0, nowTs - Number(ref.ts_ms)))
            : "-",
    };
}

function renderDiagnosticsDevices(state) {
    const devices = [
        ...(Array.isArray(state?.diagnostics?.devices) ? state.diagnostics.devices : []),
        ...cameraDiagnosticRows(),
    ];
    const renderDeviceRow = (d, level = 0) => {
        const kind = diagKindFromRow(d);
        const statusText = diagStatusText(d);
        const led = diagLedHtml(kind, statusText);
        const ip = String(d.ip || "");
        const url = String(d.url || "");
        const link = ip && url
            ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(ip)}</a>`
            : ip
                ? escapeHtml(ip)
                : url
                    ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(url)}</a>`
            : "-";
        const rx = d.rx_ip ? `rx ${d.rx_ip}${d.udp_port == null ? "" : `:${d.udp_port}`}` : "";
        const port = !d.rx_ip && d.udp_port != null ? `:${escapeHtml(d.udp_port)}` : "";
        const detail = d.detail ? `<div class="diagSub">${escapeHtml(d.detail)}</div>` : "";
        const childClass = level > 0 ? " diagChildRow" : "";
        const nodeClass = level > 0 ? "diagTreeChild" : "";
        return `<tr class="diagDeviceRow${childClass}">
            <td>${led}</td>
            <td><span class="${nodeClass}"><b>${escapeHtml(d.node || "-")}</b></span></td>
            <td>${escapeHtml(d.kind || "-")}</td>
            <td>${escapeHtml(d.role || "-")}</td>
            <td class="mono">${link}${port}${rx ? `<div class="diagSub">${escapeHtml(rx)}</div>` : ""}</td>
            <td class="mono">${escapeHtml(fmtAgeMs(d.last_rx_age_ms))}</td>
            <td><span class="diagStatusBadge ${kind}">${escapeHtml(statusText)}</span>${detail}</td>
        </tr>`;
    };
    const rows = devices.flatMap((d) => {
        const children = Array.isArray(d.children) ? d.children : [];
        return [renderDeviceRow(d, 0), ...children.map((child) => renderDeviceRow(child, 1))];
    }).join("");

    utils.setHTML("diag_devices", `<table class="diagTable">
        <thead><tr><th></th><th>Dispositivo</th><th>Tipo</th><th>Ruolo</th><th>Indirizzo</th><th>Ultimo msg valido</th><th>Stato</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="7">Nessun dispositivo rilevato.</td></tr>`}</tbody>
    </table>`);

    const online = devices.filter((d) => diagKindFromRow(d) === "ok").length;
    utils.setText("diag_summary", `${online}/${devices.length} online`);
}

function renderDiagnosticsAlarms(state) {
    const active = Array.isArray(state?.alarms_active) ? state.alarms_active : [];
    const history = Array.isArray(state?.alarms_history) ? state.alarms_history : [];
    const nowTs = Number(state?.last_update_ms);
    const rows = DIAG_ALARM_CATALOG.map((def) => {
        const status = diagCatalogStatus(def, state, active, history, nowTs);
        return `<tr>
            <td><span class="diagStatusBadge ${status.statusClass}">${status.statusText}</span></td>
            <td class="mono">${escapeHtml(def.key)}</td>
            <td><b>${escapeHtml(def.label)}</b></td>
            <td>${escapeHtml(def.description)}</td>
            <td class="mono">${escapeHtml(status.src)}</td>
            <td class="mono">${escapeHtml(status.age)}</td>
        </tr>`;
    }).join("");

    utils.setHTML("diag_alarms", `<table class="diagTable">
        <thead><tr><th>Stato</th><th>ID</th><th>Allarme</th><th>Significato</th><th>Ultima sorgente</th><th>Ultimo evento</th></tr></thead>
        <tbody>${rows}</tbody>
    </table>`);
}

function renderDiagnostics(state) {
    renderDiagnosticsDevices(state);
    renderDiagnosticsAlarms(state);
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
    const shdn = isShutdownInProgress();
    try {
        const s = await fetch("/api/log/status").then((r) => r.json());
        const sid = String(s?.sid || "").trim();
        if (pill) pill.textContent = s?.enabled ? `LOG ON ${sid}` : (sid ? `LOG OFF ${sid}` : "LOG OFF");
        if (bStart) bStart.disabled = shdn || !!s?.enabled;
        if (bStop) bStop.disabled = shdn || !s?.enabled;
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
    renderHelpLightFaults(state);
    renderHelpInaFaults(state);
    renderHelpAlarmLinks(state);
    handleAlarmBeep(state);

    const ms = document.getElementById("main_scada");

    if (ms) ms.innerHTML = scadaSvg(state);
    renderVmotState(state);
    renderVmotCockpitWarning(state);
    renderStroboButton(state);
    renderShutdownOverlay(state);
    renderCommandLocks(state);

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
    const activeId = document.activeElement?.id || "";
    if (setupWired && uiPrefs.mainTab === "setup" && !activeId.startsWith("setup_gp_") && activeId !== "setup_input_source") {
        syncInputMappingControls();
    }
    renderDiagnostics(state);
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
    setupStroboControls();
    setupShutdownControls();
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
    const syncLightsIdsBtn = document.getElementById("lgt_ids_sync");
    if (syncLightsIdsBtn)
        syncLightsIdsBtn.onclick = lights.sendLightsIds;
    setupLightsConfigToggle();
    setupJoystickControls();

    logs.setupLogs();
    await logs.refreshLogStatus().catch(() => { });
    await logs.refreshLogSessions().catch(() => { });
    await refreshMissionTab().catch(() => { });
    render(snapshot);
    if (!diagnosticsRefreshTimer) {
        diagnosticsRefreshTimer = setInterval(() => {
            if (uiPrefs.mainTab === "diagnostics") refreshSnapshotOnce().catch(() => { });
        }, 1000);
    }

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

            if (msg.type === "shutdown") {
                snapshot = snapshot || {};
                snapshot.system = snapshot.system || {};
                if (msg.shutdown) snapshot.system.shutdown = msg.shutdown;
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
uiPrefs.inputSource ??= INPUT_SOURCE_BROKER;
uiPrefs.gamepadIndex ??= -1;
uiPrefs.sonarHeadingLock ??= false;
uiPrefs.sonarPalette ??= "jet";
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

function sonarSectorConfig(deg) {
    const sector = Number(deg);
    if (!Number.isFinite(sector) || sector >= 360) {
        return { start_angle_grad: 0, stop_angle_grad: 399 };
    }
    const halfGrad = Math.round((sector / 0.9) / 2);
    return {
        start_angle_grad: ((400 - halfGrad) % 400),
        stop_angle_grad: halfGrad % 400,
    };
}

function sonarSectorPresetValue(cfg) {
    const start = Number(cfg?.start_angle_grad);
    const stop = Number(cfg?.stop_angle_grad);
    if (!Number.isFinite(start) || !Number.isFinite(stop)) return null;
    for (const deg of SONAR_SCAN_PRESETS) {
        const sector = sonarSectorConfig(deg);
        if (sector.start_angle_grad === start && sector.stop_angle_grad === stop) return deg;
    }
    return null;
}

function sonarResolutionPresetValue(cfg) {
    const samples = Number(cfg?.num_samples);
    const steps = Number(cfg?.num_steps);
    for (const [key, preset] of Object.entries(SONAR_RESOLUTION_PRESETS)) {
        if (samples === preset.num_samples && steps === preset.num_steps) return key;
    }
    return null;
}

function sonarPalettePresetValue(value) {
    const palette = String(value || "").toLowerCase();
    return SONAR_PALETTE_PRESETS.includes(palette) ? palette : "jet";
}

function setActivePreset(containerId, attrName, activeValue) {
    const root = document.getElementById(containerId);
    if (!root) return;
    const activeText = activeValue == null ? "" : String(activeValue);
    for (const btn of root.querySelectorAll("button")) {
        btn.classList.toggle("active", String(btn.dataset[attrName] || "") === activeText);
    }
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
    const range = Number(sonarCfg.range_m);
    setActivePreset("sonar_range_presets", "rangeM", Number.isFinite(range) ? Math.round(range) : null);
    setActivePreset("sonar_scan_presets", "sectorDeg", sonarSectorPresetValue(sonarCfg));
    setActivePreset("sonar_resolution_presets", "resolution", sonarResolutionPresetValue(sonarCfg));
    setActivePreset("sonar_palette_presets", "palette", sonarPalettePresetValue(uiPrefs.sonarPalette));
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
        host: String(sonarField("host")?.value || current.host || "192.168.2.11").trim(),
        fallback_ip: String(sonarField("fallback_ip")?.value || current.fallback_ip || "192.168.2.11").trim(),
        port: numberFieldValue("port", current.port ?? 12345),
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
        const payload = { ...(sonarCfg || readSonarSetupConfig()) };
        const j = await logs.apiPost("/api/sonar/ping360/start", payload);
        writeSonarSetupConfig(j?.config || payload);
        clearSonarDisplay();
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
        clearSonarDisplay();
        await refreshSnapshotOnce().catch(() => { });
    } catch (e) {
        setSonarSetupAck(e?.message || "Errore stop Ping360.");
    }
}

async function applySonarConfigPatch(patch, successText, pendingText = "Updating Ping360...") {
    try {
        setSonarSetupAck(pendingText);
        const payload = { ...(sonarCfg || readSonarSetupConfig()), ...(patch || {}) };
        const j = await logs.apiPost("/api/sonar/ping360/config", payload);
        writeSonarSetupConfig(j?.config || payload);
        clearSonarDisplay();
        setSonarSetupAck(successText);
        await refreshSnapshotOnce().catch(() => { });
    } catch (e) {
        setSonarSetupAck(e?.message || "Errore configurazione Ping360.");
    }
}

async function applySonarRangePreset(rangeM) {
    await applySonarConfigPatch({ range_m: Number(rangeM) }, `Ping360 range ${rangeM} m saved. Runtime restarted.`, `Setting Ping360 range ${rangeM} m...`);
}

async function applySonarSectorPreset(sectorDeg) {
    const sector = sonarSectorConfig(sectorDeg);
    await applySonarConfigPatch(sector, `Ping360 scan sector ${sectorDeg} deg saved. Runtime restarted.`, `Setting Ping360 scan sector ${sectorDeg} deg...`);
}

async function applySonarResolutionPreset(key) {
    const preset = SONAR_RESOLUTION_PRESETS[key];
    if (!preset) return;
    await applySonarConfigPatch(
        { num_samples: preset.num_samples, num_steps: preset.num_steps },
        `Ping360 resolution ${preset.label} saved. Runtime restarted.`,
        `Setting Ping360 resolution ${preset.label}...`
    );
}

function clearSonarDisplay() {
    if (window.sonarPing360?.clear) window.sonarPing360.clear();
}

function applySonarPalettePreset(palette) {
    uiPrefs.sonarPalette = sonarPalettePresetValue(palette);
    saveUiPrefs(uiPrefs);
    setActivePreset("sonar_palette_presets", "palette", uiPrefs.sonarPalette);
    syncSonarRuntimeStatus();
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
        const bind = rt.bind_port ? ` bind=${rt.bind_port}` : "";
        const peer = rt.last_peer ? ` peer=${rt.last_peer}` : "";
        const msg = rt.last_msg_id ? ` msg=${rt.last_msg_id}` : "";
        const ver = rt.protocol_version ? ` proto=${rt.protocol_version}` : "";
        const fw = rt.firmware_version ? ` fw=${rt.firmware_version}` : "";
        const scanMode = rt.scan_mode ? ` mode=${rt.scan_mode}` : "";
        const manualCmd = Number.isFinite(Number(rt.manual_command_mode)) ? ` manual_cmd=${rt.manual_command_mode}` : "";
        cfgStatus.textContent = `host=${rt.host || "-"}:${rt.port || "-"} rx=${rx} tx=${rt.tx_total || 0}${scanMode}${manualCmd}${bind}${peer}${msg}${ver}${fw}${err}`;
    }

    const range = Number(rt.range_m ?? sonarCfg?.range_m);
    const rangeLabel = document.getElementById("sonar_range_label");
    if (rangeLabel) rangeLabel.textContent = Number.isFinite(range) ? `range: ${range.toFixed(0)} m` : "range: -";
    setActivePreset("sonar_range_presets", "rangeM", Number.isFinite(range) ? Math.round(range) : null);
    setActivePreset("sonar_scan_presets", "sectorDeg", sonarSectorPresetValue(sonarCfg));
    setActivePreset("sonar_resolution_presets", "resolution", sonarResolutionPresetValue(sonarCfg));
    setActivePreset("sonar_palette_presets", "palette", sonarPalettePresetValue(uiPrefs.sonarPalette));

    const headingLock = document.getElementById("sonar_heading_lock");
    if (headingLock) headingLock.checked = !!uiPrefs.sonarHeadingLock;
    const heading = Number(snapshot?.nav?.heading_deg);
    if (window.sonarPing360) {
        window.sonarPing360.setOptions({
            headingLock: !!uiPrefs.sonarHeadingLock,
            headingDeg: Number.isFinite(heading) ? heading : 0,
            rangeM: Number.isFinite(range) ? range : Number(sonarCfg?.range_m || 60),
            palette: sonarPalettePresetValue(uiPrefs.sonarPalette),
            sectorStartGrad: Number(sonarCfg?.start_angle_grad ?? 0),
            sectorStopGrad: Number(sonarCfg?.stop_angle_grad ?? 399),
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
    const dw = utils.el('diagnosticsWrap');
    const suw = utils.el('setupWrap');
    if (mw)
        mw.classList.toggle('hidden', tab !== 'vehicle');
    if (tw)
        tw.classList.toggle('hidden', tab !== 'mission');
    if (vw)
        vw.classList.toggle('hidden', tab !== 'video');
    if (sw)
        sw.classList.toggle('hidden', tab !== 'sonar');
    if (dw)
        dw.classList.toggle('hidden', tab !== 'diagnostics');
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
    if (tab === 'diagnostics') {
        if (snapshot) renderDiagnostics(snapshot);
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
    document.querySelectorAll('.tab[data-tab]').forEach(t => {
        t.addEventListener('click', () => {
            document.querySelectorAll('.tab[data-tab]').forEach(x => x.classList.remove('active'));
            t.classList.add('active');
            uiPrefs.mainTab = t.dataset.tab; saveUiPrefs(uiPrefs);
            renderMainSlot(uiPrefs.mainTab);
        });
    });
    const cur = uiPrefs.mainTab || 'vehicle';
    document.querySelectorAll('.tab[data-tab]').forEach(x => x.classList.toggle('active', x.dataset.tab === cur));
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
            <select id="setup_gp_${a.key}"></select>
          </div>
        `).join("");
    }

    const inputSourceSel = document.getElementById("setup_input_source");
    if (inputSourceSel) {
        inputSourceSel.addEventListener("change", () => {
            uiPrefs.inputSource = inputSourceSel.value === INPUT_SOURCE_BROWSER ? INPUT_SOURCE_BROWSER : INPUT_SOURCE_BROKER;
            ctrlPrevSignals = {};
            ctrlSignalsPrimed = false;
            saveUiPrefs(uiPrefs);
            syncInputMappingControls();
        });
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
            const source = currentInputSource();
            if (source === INPUT_SOURCE_BROWSER) {
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
            } else {
                const map = {};
                for (const a of GP_ACTIONS) {
                    const sel = document.getElementById(`setup_gp_${a.key}`);
                    map[a.key] = String(sel?.value || "").trim();
                }
                saveCtrlMap(map);
                ctrlPrevSignals = {};
                ctrlSignalsPrimed = false;
            }
            saveUiPrefs(uiPrefs);
            syncSetupTab();
            const ack = document.getElementById("setup_gp_ack");
            if (ack) ack.textContent = source === INPUT_SOURCE_BROWSER
                ? "Joystick browser mapping saved."
                : "Controller broker UDP mapping saved.";
        };
    }

    const resetGpBtn = document.getElementById("setup_gp_reset");
    if (resetGpBtn) {
        resetGpBtn.onclick = () => {
            const source = currentInputSource();
            if (source === INPUT_SOURCE_BROWSER) {
                saveGpMap({ ...GP_DEFAULT_MAP });
                uiPrefs.gamepadIndex = -1;
            } else {
                saveCtrlMap({});
                ctrlPrevSignals = {};
                ctrlSignalsPrimed = false;
                cancelGpVmotHold();
            }
            saveUiPrefs(uiPrefs);
            syncSetupTab();
            const ack = document.getElementById("setup_gp_ack");
            if (ack) ack.textContent = source === INPUT_SOURCE_BROWSER
                ? "Joystick browser mapping reset."
                : "Controller broker UDP mapping reset.";
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

    const sonarClearBtn = document.getElementById("sonar_clear");
    if (sonarClearBtn) {
        sonarClearBtn.onclick = () => clearSonarDisplay();
    }

    for (const btn of document.querySelectorAll("#sonar_range_presets button[data-range-m]")) {
        btn.onclick = () => applySonarRangePreset(Number(btn.dataset.rangeM || 0));
    }

    for (const btn of document.querySelectorAll("#sonar_scan_presets button[data-sector-deg]")) {
        btn.onclick = () => applySonarSectorPreset(Number(btn.dataset.sectorDeg || 0));
    }

    for (const btn of document.querySelectorAll("#sonar_resolution_presets button[data-resolution]")) {
        btn.onclick = () => applySonarResolutionPreset(String(btn.dataset.resolution || ""));
    }

    for (const btn of document.querySelectorAll("#sonar_palette_presets button[data-palette]")) {
        btn.onclick = () => applySonarPalettePreset(String(btn.dataset.palette || ""));
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

    syncInputMappingControls();
    syncSonarRuntimeStatus();
}

function syncInputMappingControls() {
    const source = currentInputSource();
    const inputSourceSel = document.getElementById("setup_input_source");
    if (inputSourceSel) inputSourceSel.value = source;

    const deviceLabel = document.getElementById("setup_gp_device_label");
    if (deviceLabel) deviceLabel.textContent = source === INPUT_SOURCE_BROWSER ? "Joystick device" : "Broker status";

    for (const a of GP_ACTIONS) {
        const sel = document.getElementById(`setup_gp_${a.key}`);
        if (!sel) continue;
        if (source === INPUT_SOURCE_BROWSER) {
            sel.innerHTML = gpSelectOptions(gpMap[a.key]);
            sel.value = String(gpMap[a.key]);
        } else {
            sel.innerHTML = controllerSelectOptions(ctrlMap[a.key]);
            sel.value = String(ctrlMap[a.key] || "");
        }
    }

    syncGamepadDeviceControl();
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
    if (currentInputSource() !== INPUT_SOURCE_BROWSER) {
        gpDeviceOptionsSignature = "__broker__";
        sel.innerHTML = `<option value="-1">Controller broker UDP</option>`;
        sel.value = "-1";
        sel.disabled = true;
        return;
    }
    sel.disabled = false;
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

function controllerSignalValue(path, ctrl = null) {
    const token = String(path || "").trim();
    if (!token.includes(".")) return undefined;
    const [group, key] = token.split(".", 2);
    const source = ctrl || snapshot?.controller || {};
    return source?.[group]?.[key];
}

function controllerSignalActive(path, ctrl = null) {
    return controllerSignalIsActive(controllerSignalValue(path, ctrl));
}

function controllerSignalEdge(path, ctrl = null) {
    const token = String(path || "").trim();
    if (!token) return false;
    const active = controllerSignalActive(token, ctrl);
    return active && !ctrlPrevSignals[token];
}

function rememberControllerSignals(ctrl = null) {
    const next = {};
    const source = ctrl || snapshot?.controller || {};
    for (const a of GP_ACTIONS) {
        const token = String(ctrlMap[a.key] || "").trim();
        if (!token) continue;
        next[token] = controllerSignalActive(token, source);
    }
    ctrlPrevSignals = next;
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

function updateMappedVmotHold(active, label = "GP") {
    if (vmotCmdBusy || vmotHoldActive) {
        cancelGpVmotHold();
        return;
    }

    if (!active) {
        cancelGpVmotHold();
        return;
    }

    ensureAlarmAudioUnlock();
    if (!gpVmotHoldActive) {
        gpVmotHoldActive = true;
        gpVmotHoldStartMs = performance.now();
        gpVmotLastBeepSec = -1;
        vmotEnableUi(0, `ENABLE VMOT ${label} (3s hold)`);
    }

    const elapsed = Math.max(0, performance.now() - gpVmotHoldStartMs);
    const progress = Math.min(1, elapsed / VMOT_ENABLE_HOLD_MS);
    const remainSec = Math.max(0, Math.ceil((VMOT_ENABLE_HOLD_MS - elapsed) / 1000));
    vmotEnableUi(progress, `ENABLE VMOT ${label} (${remainSec}s)`);

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

function updateGpVmotHold(buttons) {
    const idx = Number(gpMap.vmot_enable_hold);
    const pressed = Number.isInteger(idx) && idx >= 0 ? gamepadButtonPressed(buttons, idx) : false;
    updateMappedVmotHold(pressed, "GP");
}

function setupJoystickControls() {
    if (gpLoopStarted) return;
    gpLoopStarted = true;

    const loop = () => {
        try {
            const status = document.getElementById("setup_gp_status");
            if (isShutdownInProgress()) {
                gpPrevButtons = [];
                ctrlPrevSignals = {};
                ctrlSignalsPrimed = false;
                cancelGpVmotHold();
                cancelVmotHold();
                if (status) status.textContent = "Input locked: shutdown in progress.";
                requestAnimationFrame(loop);
                return;
            }
            const source = currentInputSource();
            if (source === INPUT_SOURCE_BROKER) {
                gpPrevButtons = [];
                const ctrl = snapshot?.controller || {};
                const online = controllerBool(ctrl.online) && !controllerBool(ctrl?.health?.link_stale);
                if (!online) {
                    ctrlPrevSignals = {};
                    ctrlSignalsPrimed = false;
                    cancelGpVmotHold();
                    if (status) {
                        const udpOk = !!snapshot?.controller_udp?.listener_ok;
                        status.textContent = udpOk ? "Controller broker UDP: waiting link." : "Controller broker UDP: listener off.";
                    }
                    requestAnimationFrame(loop);
                    return;
                }

                if (status) {
                    const activeLink = String(ctrl.active_link || "no_link").toUpperCase();
                    const fields = controllerSignalOptions(ctrl).length;
                    status.textContent = `Broker UDP ${activeLink}: seq ${ctrl.seq ?? "-"} | fields: ${fields}`;
                }

                if (!ctrlSignalsPrimed) {
                    rememberControllerSignals(ctrl);
                    ctrlSignalsPrimed = true;
                    requestAnimationFrame(loop);
                    return;
                }

                if (controllerSignalEdge(ctrlMap.tab_prev, ctrl)) cycleMainTab(-1);
                if (controllerSignalEdge(ctrlMap.tab_next, ctrl)) cycleMainTab(1);
                if (controllerSignalEdge(ctrlMap.light_ch_prev, ctrl)) setGpLightChannel(gpLightCh - 1);
                if (controllerSignalEdge(ctrlMap.light_ch_next, ctrl)) setGpLightChannel(gpLightCh + 1);
                if (controllerSignalEdge(ctrlMap.light_on, ctrl)) gpSendLight("ON");
                if (controllerSignalEdge(ctrlMap.light_off, ctrl)) gpSendLight("OFF");
                if (controllerSignalEdge(ctrlMap.strobo_toggle, ctrl)) {
                    const current = snapshot?.strobo?.on;
                    const next = (current === 1 || current === "1") ? 0 : 1;
                    sendStrobo(next);
                }
                if (controllerSignalEdge(ctrlMap.vmot_disable, ctrl)) {
                    cancelGpVmotHold();
                    cancelVmotHold();
                    sendVmotMaster(0);
                }
                updateMappedVmotHold(controllerSignalActive(ctrlMap.vmot_enable_hold, ctrl), "UDP");
                if (controllerSignalEdge(ctrlMap.add_mark, ctrl)) gpAddMarkerEvent();
                if (controllerSignalEdge(ctrlMap.toggle_log, ctrl)) gpToggleLogging();
                if (controllerSignalEdge(ctrlMap.video_stream_1, ctrl)) video.selectVideoStream(0);
                if (controllerSignalEdge(ctrlMap.video_stream_2, ctrl)) video.selectVideoStream(1);
                if (controllerSignalEdge(ctrlMap.video_stream_3, ctrl)) video.selectVideoStream(2);
                if (controllerSignalEdge(ctrlMap.tab_cycle, ctrl)) cycleMainTab(1);

                rememberControllerSignals(ctrl);
                requestAnimationFrame(loop);
                return;
            }

            ctrlPrevSignals = {};
            ctrlSignalsPrimed = false;
            const pads = listConnectedGamepads();
            syncGamepadDeviceControl(pads);
            const gp = pickConfiguredGamepad(pads);
            if (!gp) {
                gpPrevButtons = [];
                cancelGpVmotHold();
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
            if (gamepadEdge(buttons, gpMap.strobo_toggle)) {
                const current = snapshot?.strobo?.on;
                const next = (current === 1 || current === "1") ? 0 : 1;
                sendStrobo(next);
            }
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


// Utility helpers extracted from original app.js
export const el = (id) => {
  const n = document.getElementById(id);
  if(!n) console.warn("[DOM] missing element id:", id);
  return n;
};

export const exists = (id) => !!el(id);

export const fmtV = (mv) => (mv == null ? "-" : (mv / 1000).toFixed(2) + " V");
export const fmtA = (ma) => (ma == null ? "-" : (ma / 1000).toFixed(2) + " A");
export const fmtC = (dC) => (dC == null ? "-" : (dC / 10).toFixed(1) + " °C");

export function setText(id, txt){
  const e = document.getElementById(id);
  if(!e) return;
  e.textContent = txt ?? "";
}
export function setHTML(id, html){
  const e = document.getElementById(id);
  if(!e) return;
  e.innerHTML = html ?? "";
}

export function sevLabel(sev) {
  if (sev == 4) return "CRIT";
  if (sev == 3) return "ERROR";
  if (sev == 2) return "WARN";
  return "INFO";
}

export function sevClass(sev) {
  const s = Number(sev);
  if (s >= 3) return "bad";
  if (s === 2) return "warn";
  return "ok";
}

export function pill(on, label) {
  const bg = on ? "rgba(34,197,94,.18)" : "rgba(239,68,68,.18)";
  const bd = on ? "rgba(34,197,94,.55)" : "rgba(239,68,68,.55)";
  const fg = on ? "#bff7d3" : "#ffd1d1";
  return `<span style="
    display:inline-block;padding:3px 8px;border-radius:999px;
    border:1px solid ${bd};background:${bg};color:${fg};
    margin-right:6px;font-size:12px;font-weight:800">
    ${label}:${on ? "ON" : "OFF"}
  </span>`;
}

export function vmotRow(d, keys) {
  return keys.map(k => pill(d[k] === 1 || d[k] === "1", k.replace("On", ""))).join("");
}

export function parStateLabel(x) {
  const m = {
    0: "OFF",
    1: "BOOT",
    2: "WAIT_PEER",
    3: "ISOLATED_SELF",
    4: "ISOLATED_PEER",
    5: "PARALLEL_ON",
    6: "FAULT",
    7: "HANDOFF"
  };
  return m[x] || `PAR_${x ?? "?"}`;
}

const POWER_REASON_MAP = {
  0: { label: "Normal / parallel allowed", meaning: "Normale: parallelo consentito." },
  5: { label: "Manual override", meaning: "Override manuale attivo." },
  10: { label: "Bootstrap wait peer", meaning: "Bootstrap: attesa del peer." },
  20: { label: "BAT1 self primary, dV high", meaning: "BAT1 primaria isolata: delta tensione alto." },
  21: { label: "BAT2 self primary, dV high", meaning: "BAT2 primaria isolata: delta tensione alto." },
  22: { label: "CPU1 primary, CPU2 isolated", meaning: "CPU1 primaria, CPU2 isolata." },
  30: { label: "Handoff wait peer bus", meaning: "Handoff in attesa del bus del peer." },
  31: { label: "Peer primary active", meaning: "Peer primario attivo." },
  40: { label: "VBUS low fallback", meaning: "Fallback attivato per VBUS basso." },
  50: { label: "Hold minimum ON dwell", meaning: "Tempo minimo di permanenza ON ancora attivo." },
  51: { label: "Hold minimum OFF dwell", meaning: "Tempo minimo di permanenza OFF ancora attivo." },
  900: { label: "Fault active (PowerSM forced OFF)", meaning: "Fault attivo: PowerSM forza OFF." },
};

const VMOT_REASON_MAP = {
  0: { label: "VMOT_REASON_OK", meaning: "Sequenza VMOT completata senza errori." },
  1: { label: "VMOT_REASON_IO_NOT_READY", meaning: "I/O non pronto all'avvio sequenza VMOT." },
  2: { label: "VMOT_REASON_DRIVER_FAULT_PRECHECK", meaning: "Driver VMOT in fault prima dell'abilitazione canali." },
  101: { label: "VMOT_REASON_CH1_RDY_FAIL", meaning: "CH1 acceso ma VMotRdy non valido." },
  102: { label: "VMOT_REASON_CH2_RDY_FAIL", meaning: "CH2 acceso ma VMotRdy non valido." },
  103: { label: "VMOT_REASON_CH3_RDY_FAIL", meaning: "CH3 acceso ma VMotRdy non valido." },
  201: { label: "VMOT_REASON_CH1_RDY_UNCOMMANDED", meaning: "CH1 segnala RDY mentre il comando INP e OFF." },
  202: { label: "VMOT_REASON_CH2_RDY_UNCOMMANDED", meaning: "CH2 segnala RDY mentre il comando INP e OFF." },
  203: { label: "VMOT_REASON_CH3_RDY_UNCOMMANDED", meaning: "CH3 segnala RDY mentre il comando INP e OFF." },
};

export function powerReasonInfo(v) {
  const key = Number(v);
  return POWER_REASON_MAP[key] || {
    label: `PWR_REASON_${v ?? "?"}`,
    meaning: "Codice Reason non documentato.",
  };
}

export function powerReasonLabel(v) {
  return powerReasonInfo(v).label;
}

export function vmotReasonInfo(v) {
  const key = Number(v);
  return VMOT_REASON_MAP[key] || {
    label: `VMOT_REASON_${v ?? "?"}`,
    meaning: "Codice VMOT Reason non documentato.",
  };
}

export function vmotReasonLabel(v) {
  return vmotReasonInfo(v).label;
}

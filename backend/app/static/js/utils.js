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

export function vmotReasonLabel(v) {
  const m = {
    0: "VMOT_REASON_OK",
    1: "VMOT_REASON_IO_NOT_READY",
    101: "VMOT_REASON_CH1_RDY_FAIL",
    102: "VMOT_REASON_CH2_RDY_FAIL",
    103: "VMOT_REASON_CH3_RDY_FAIL",
    201: "VMOT_REASON_CH1_FAULT",
    202: "VMOT_REASON_CH2_FAULT",
    203: "VMOT_REASON_CH3_FAULT",
  };
  return m[v] || `VMOT_REASON_${v ?? "?"}`;
}

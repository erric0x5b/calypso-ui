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
  if (sev == 3) return "CRIT";
  if (sev == 2) return "ERR";
  if (sev == 1) return "WARN";
  return "INFO";
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

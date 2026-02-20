import { setHTML } from './utils.js';

export const THRUSTERS = [
  { side:"L", slot:1, escId:1, name:"L1" },
  { side:"L", slot:2, escId:2, name:"L2" },
  { side:"L", slot:3, escId:3, name:"L3" },
  { side:"R", slot:1, escId:4, name:"R1" },
  { side:"R", slot:2, escId:5, name:"R2" },
  { side:"R", slot:3, escId:6, name:"R3" },
];

export function ringSvg(pct, status){
  const r = 34;
  const c = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(100, pct || 0));
  const dash = (p/100) * c;
  const col =
    status === "BAD" ? "var(--bad)" :
    status === "OFF" ? "rgba(255,255,255,.25)" :
    "var(--ok)";

  return `
  <svg viewBox="0 0 84 84" width="84" height="84">
    <circle cx="42" cy="42" r="${r}" fill="none" stroke="rgba(255,255,255,.10)" stroke-width="8"/>
    <circle cx="42" cy="42" r="${r}" fill="none"
      stroke="${col}" stroke-width="8"
      stroke-linecap="round"
      stroke-dasharray="${dash} ${c-dash}"
      transform="rotate(-90 42 42)"/>
  </svg>`;
}

export function thrusterFromState(state, t){
  const esc = state.esc?.[String(t.escId)] || state.esc?.[t.escId] || {};
  const rpm = esc.RPM ?? 0;
  const rpmMax = 4000;
  const pct = Math.max(0, Math.min(100, Math.round((Math.abs(rpm)/rpmMax)*100)));
  const dir = (rpm < 0) ? "REV" : "FWD";
  const on = pct > 1;
  const bad = false;
  return { name: t.name, escId: t.escId, pct, dir, rpm, status: bad ? "BAD" : (on ? "ON" : "OFF") };
}

export function renderThrusterRing(th){
  const badgeClass =
    th.status === "BAD" ? "badge bad" :
    th.status === "OFF" ? "badge muted" :
    "badge ok";

  return `
  <div class="ringCard">
    <div class="ring">
      ${ringSvg(th.pct, th.status)}
      <div class="ringInner">
        <div class="ringPct">${th.pct}%</div>
        <div class="ringDir">${th.dir}</div>
      </div>
    </div>

    <div class="ringMeta">
      <div class="ringTitle">${th.name} <span class="pill mono">ESC ${th.escId}</span></div>
      <div class="ringRow">
        <span class="${badgeClass}">${th.status}</span>
        <span class="mono">RPM ${th.rpm ?? "-"}</span>
      </div>
    </div>
  </div>`;
}

export function renderMotorsRings(state){
  const leftEl = document.getElementById("motors_left");
  const rightEl = document.getElementById("motors_right");
  if(!leftEl || !rightEl) return;
  const ths = THRUSTERS.map(t => thrusterFromState(state, t));
  const left = ths.filter(x => x.name.startsWith("L"));
  const right = ths.filter(x => x.name.startsWith("R"));
  leftEl.innerHTML = left.map(renderThrusterRing).join("");
  rightEl.innerHTML = right.map(renderThrusterRing).join("");
}

// advanced ring renderer (mission panel)
export function thrusterRingSvg(label, cmdPct, rpm){
  const r = 44; const cx = 60, cy = 60; const C = 2 * Math.PI * r;
  let pct = (cmdPct == null) ? 0 : Math.max(0, Math.min(100, Math.abs(cmdPct)));
  const dash = (pct/100) * C;
  const col = (cmdPct == null) ? "#6b7280" : (cmdPct > 2 ? "#22c55e" : (cmdPct < -2 ? "#ef4444" : "#6b7280"));
  const cmdTxt = (cmdPct == null) ? "—" : `${Math.round(cmdPct)}%`;
  const rpmTxt = (rpm == null) ? "rpm —" : `rpm ${rpm}`;
  return `
  <svg class="thRing" viewBox="0 0 120 120">
    <defs>
      <filter id="ringGlow" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="3" result="b"/>
        <feMerge>
          <feMergeNode in="b"/>
          <feMergeNode in="SourceGraphic"/>
        </feMerge>
      </filter>
    </defs>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="rgba(255,255,255,0.02)" stroke="rgba(255,255,255,0.10)" stroke-width="10"/>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${col}" stroke-width="10" stroke-linecap="round" stroke-dasharray="${dash} ${C - dash}" transform="rotate(-90 ${cx} ${cy})" filter="url(#ringGlow)"/>
    <text x="${cx}" y="46" text-anchor="middle" class="thLabel">${label}</text>
    <text x="${cx}" y="72" text-anchor="middle" class="thValue">${cmdTxt}</text>
    <text x="${cx}" y="92" text-anchor="middle" class="thSub">${rpmTxt}</text>
  </svg>`;
}

export const THR_MAP = [
  { th:"TH1", esc:1 }, { th:"TH2", esc:2 }, { th:"TH3", esc:3 },
  { th:"TH4", esc:4 }, { th:"TH5", esc:5 }, { th:"TH6", esc:6 },
];

export function renderMotorsRingsAdvanced(state){
  const thr = state.thr || {};
  const getCmd = (th) => (thr[th]?.CmdPct ?? null);
  const getRpm = (escId, th) => (thr[th]?.RPM ?? state.esc?.[escId]?.RPM ?? null);
  const left = THR_MAP.slice(0,3).map(x => thrusterRingSvg(x.th, getCmd(x.th), getRpm(x.esc, x.th))).join("");
  const right = THR_MAP.slice(3,6).map(x => thrusterRingSvg(x.th, getCmd(x.th), getRpm(x.esc, x.th))).join("");
  setHTML("motors_left", left);
  setHTML("motors_right", right);
}

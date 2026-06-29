import { setHTML } from './utils.js?v=16';

export const THR_MAP = [
  { name:"TH2", th:"TH2", escId:2, label:"2", pos:"FL", side:"L", order:1 },
  { name:"TH6", th:"TH6", escId:6, label:"6", pos:"VL", side:"L", order:2 },
  { name:"TH4", th:"TH4", escId:4, label:"4", pos:"RL", side:"L", order:3 },

  { name:"TH1", th:"TH1", escId:1, label:"1", pos:"FR", side:"R", order:1 },
  { name:"TH5", th:"TH5", escId:5, label:"5", pos:"VR", side:"R", order:2 },
  { name:"TH3", th:"TH3", escId:3, label:"3", pos:"RR", side:"R", order:3 },
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
  return { name: t.name, escId: t.escId, pct, dir, rpm, side: t.side, status: bad ? "BAD" : (on ? "ON" : "OFF") };
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

  if(!leftEl || !rightEl) 
    return;

  const ths = THR_MAP.map(t => thrusterFromState(state, t));

  const left = ths.filter(x => x.side === "L");
  const right = ths.filter(x => x.side === "R");

  leftEl.innerHTML = left.map(renderThrusterRing).join("");
  rightEl.innerHTML = right.map(renderThrusterRing).join("");
}

export function thrusterRingSvg(label, cmdPct, rpm){
  const r = 44, cx = 60, cy = 60;
  const C = 2 * Math.PI * r;
  const halfC = C / 2;

  const pct = (cmdPct == null) ? 0 : Math.max(0, Math.min(100, Math.abs(cmdPct)));
  const dir =
    (cmdPct == null) ? "hold" :
    (cmdPct > 2 ? "fwd" : (cmdPct < -2 ? "rev" : "hold"));
  const dash = (pct / 100) * halfC;
  const col = dir === "fwd" ? "#22c55e" : (dir === "rev" ? "#32c7f5" : "#6b7280");
  const cmdTxt = (cmdPct == null) ? "-" : `${Math.round(cmdPct)}%`;
  const rpmTxt = (rpm == null) ? "rpm -" : `rpm ${rpm}`;
  const activeRot = dir === "rev" ? 90 : -90;

  // ID unico (solo caratteri sicuri)
  const uid = String(label).replace(/[^a-zA-Z0-9_-]/g, "_");
  const glowId = `ringGlow_${uid}`;

  return `
  <svg class="thRing" viewBox="0 0 120 120" preserveAspectRatio="xMidYMid meet">
    <defs>
      <filter id="${glowId}" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="3" result="b"/>
        <feMerge>
          <feMergeNode in="b"/>
          <feMergeNode in="SourceGraphic"/>
        </feMerge>
      </filter>
    </defs>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="rgba(255,255,255,0.02)" stroke="rgba(255,255,255,0.08)" stroke-width="10"/>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="rgba(255,255,255,0.09)" stroke-width="10"
      stroke-linecap="round" stroke-dasharray="${halfC} ${C - halfC}" transform="rotate(-90 ${cx} ${cy})"/>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="rgba(255,255,255,0.05)" stroke-width="10"
      stroke-linecap="round" stroke-dasharray="${halfC} ${C - halfC}" transform="rotate(90 ${cx} ${cy})"/>
    ${dir === "hold" ? "" : `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${col}" stroke-width="10" stroke-linecap="round"
      stroke-dasharray="${dash} ${C - dash}" transform="rotate(${activeRot} ${cx} ${cy})" filter="url(#${glowId})"/>`}
    <text x="${cx}" y="46" text-anchor="middle" class="thLabel">${label}</text>
    <text x="${cx}" y="72" text-anchor="middle" class="thValue">${cmdTxt}</text>
    <text x="${cx}" y="92" text-anchor="middle" class="thSub">${rpmTxt}</text>
  </svg>`;
}
export function renderMotorsRingsAdvanced(state){
  const thr = state.thr || {};
  const getCmd = (th) => (thr[th]?.CmdPct ?? null);
  const getRpm = (escId, th) => (thr[th]?.RPM ?? state.esc?.[escId]?.RPM ?? null);

  const left = THR_MAP
    .filter(x => x.side === "L")
    .sort((a,b)=>a.order-b.order)
    .map(x => thrusterRingSvg(`${x.label} ${x.pos}`, getCmd(x.th), getRpm(x.escId, x.th)))
    .join("");

  const right = THR_MAP
    .filter(x => x.side === "R")
    .sort((a,b)=>a.order-b.order)
    .map(x => thrusterRingSvg(`${x.label} ${x.pos}`, getCmd(x.th), getRpm(x.escId, x.th)))
    .join("");

  setHTML("motors_left", left);
  setHTML("motors_right", right);
}


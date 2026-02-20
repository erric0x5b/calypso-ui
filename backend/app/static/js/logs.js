import { el, setText } from './utils.js';

export async function apiPost(url, body){
  const r = await fetch(url, { method: "POST", headers: {"Content-Type":"application/json"}, body: body ? JSON.stringify(body) : "{}" });
  const j = await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j?.err || j?.detail || ("HTTP "+r.status));
  return j;
}

export async function refreshLogStatus(){
  const s = await fetch("/api/log/status").then(r=>r.json());
  const pill = el("log_status"); if(pill) pill.textContent = s.enabled ? `ON ${s.sid}` : "OFF";
  const zip = el("log_zip"); if(zip){ if(s.enabled && s.sid){ zip.href = `/api/log/zip?sid=${encodeURIComponent(s.sid)}`; zip.style.pointerEvents = ""; zip.style.opacity = "1"; }else{ zip.href = "#"; zip.style.pointerEvents = "none"; zip.style.opacity = ".5"; } }
}

export async function refreshLogSessions(){
  const j = await fetch("/api/log/sessions").then(r=>r.json());
  const box = el("log_sessions"); if(!box) return; const arr = j.sessions || []; if(!arr.length){ box.textContent = "—"; return; }
  box.innerHTML = arr.sort((a,b)=> (b.sid||"").localeCompare(a.sid||"")).map(x => `• ${x.sid}  <a class="btn" href="/api/log/zip?sid=${encodeURIComponent(x.sid)}">ZIP</a>`).join("<br>");
}

export function setupLogs(){
  const bStart = el("log_start"); const bStop = el("log_stop");
  if(bStart){ bStart.onclick = async () => { try{ await apiPost("/api/log/start"); await refreshLogStatus(); await refreshLogSessions(); }catch(e){ console.error("log start failed", e); } }; }
  if(bStop){ bStop.onclick = async () => { try{ await apiPost("/api/log/stop"); await refreshLogStatus(); await refreshLogSessions(); }catch(e){ console.error("log stop failed", e); } }; }
  const note = el("log_note"); const add = el("log_note_add"); if(add){ add.onclick = async () => { try{ const text = (note?.value||"").trim(); if(!text) return; await apiPost("/api/log/event", {type:"NOTE", text}); note.value = ""; const ml = el("mission_log"); if(ml) ml.textContent = "NOTE saved"; }catch(e){ console.error("log event failed", e); } }; }
}

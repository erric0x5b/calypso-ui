import { el, setText } from './utils.js';

export async function apiPost(url, body){
  const r = await fetch(url, { method: "POST", headers: {"Content-Type":"application/json"}, body: body ? JSON.stringify(body) : "{}" });
  const j = await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j?.err || j?.detail || ("HTTP "+r.status));
  return j;
}

export async function refreshLogStatus(){
  const s = await fetch("/api/log/status").then(r=>r.json());
  const sid = String(s?.sid || "").trim();
  const hasSid = !!sid;
  const pill = el("log_status");
  if(pill) pill.textContent = s.enabled ? `ON ${sid}` : (hasSid ? `OFF ${sid}` : "OFF");

  const zip = el("log_zip");
  if(zip){
    if(hasSid){
      zip.href = `/api/log/zip?sid=${encodeURIComponent(sid)}`;
      zip.style.pointerEvents = "";
      zip.style.opacity = "1";
    }else{
      zip.href = "#";
      zip.style.pointerEvents = "none";
      zip.style.opacity = ".5";
    }
  }

  const del = el("log_delete");
  if(del){
    del.dataset.sid = sid;
    del.dataset.enabled = s.enabled ? "1" : "0";
    if(hasSid){
      del.disabled = false;
      del.style.pointerEvents = "";
      del.style.opacity = "1";
    }else{
      del.disabled = true;
      del.style.pointerEvents = "none";
      del.style.opacity = ".5";
    }
  }
}

export async function refreshLogSessions(){
  const j = await fetch("/api/log/sessions").then(r=>r.json());
  const box = el("log_sessions");
  if(!box) return;

  const arr = (j.sessions || []).sort((a,b)=> (b.sid||"").localeCompare(a.sid||""));
  if(!arr.length){
    box.textContent = "Nessuna sessione salvata.";
    return;
  }

  box.innerHTML = arr.map(x => `
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px;">
      <span>${x.sid}</span>
      <button class="btn log_dl_btn" data-sid="${x.sid}">DOWNLOAD</button>
      <button class="btn log_del_btn" data-sid="${x.sid}">DELETE</button>
    </div>
  `).join("");

  box.querySelectorAll(".log_dl_btn").forEach(btn => {
    btn.onclick = () => {
      const sid = btn.dataset.sid;
      if(!sid) return;
      window.location.href = `/api/log/zip?sid=${encodeURIComponent(sid)}`;
    };
  });

  box.querySelectorAll(".log_del_btn").forEach(btn => {
    btn.onclick = async () => {
      const sid = btn.dataset.sid;
      if(!sid) return;
      if(!window.confirm(`Delete log session ${sid}?`)) return;

      try{
        await apiPost("/api/log/delete", { sid });
        await refreshLogStatus();
        await refreshLogSessions();
      }catch(e){
        console.error("log delete failed", e);
        window.alert(e?.message || "Failed to delete log session");
      }
    };
  });
}

export function setupLogs(){
  const bStart = el("log_start");
  const bStop = el("log_stop");
  const bDelete = el("log_delete");

  if(bStart){
    bStart.onclick = async () => {
      try{
        await apiPost("/api/log/start");
        await refreshLogStatus();
        await refreshLogSessions();
      }catch(e){
        console.error("log start failed", e);
      }
    };
  }

  if(bStop){
    bStop.onclick = async () => {
      try{
        await apiPost("/api/log/stop");
        await refreshLogStatus();
        await refreshLogSessions();
      }catch(e){
        console.error("log stop failed", e);
      }
    };
  }

  if(bDelete){
    bDelete.onclick = async () => {
      try{
        const sid = String(bDelete.dataset.sid || "").trim();
        if(!sid) return;
        const isEnabled = bDelete.dataset.enabled === "1";
        if(isEnabled){
          window.alert("Stop logging before deleting current session");
          return;
        }
        if(!window.confirm(`Delete log session ${sid}?`)) return;
        await apiPost("/api/log/delete", { sid });
        await refreshLogStatus();
        await refreshLogSessions();
      }catch(e){
        console.error("log delete failed", e);
        window.alert(e?.message || "Failed to delete log session");
      }
    };
  }

  const note = el("log_note");
  const add = el("log_note_add");
  if(add){
    add.onclick = async () => {
      try{
        const text = (note?.value||"").trim();
        if(!text) return;
        await apiPost("/api/log/event", {type:"NOTE", text});
        note.value = "";
        const ml = el("mission_log");
        if(ml) ml.textContent = "NOTE saved";
      }catch(e){
        console.error("log event failed", e);
      }
    };
  }
}

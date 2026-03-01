import { el } from "./utils.js";

let selectedSids = new Set();
let logStatus = { enabled: false, sid: "" };

function selectedList() {
  return Array.from(selectedSids).sort((a, b) => b.localeCompare(a));
}

function setActionEnabled(node, enabled) {
  if (!node) return;
  node.style.pointerEvents = enabled ? "" : "none";
  node.style.opacity = enabled ? "1" : ".5";
  if ("disabled" in node) node.disabled = !enabled;
}

function parseFilenameFromDisposition(disposition, fallbackName) {
  if (!disposition) return fallbackName;
  const m = /filename="?([^";]+)"?/i.exec(disposition);
  return (m && m[1]) ? m[1] : fallbackName;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

function updateBulkActions(totalRows = null) {
  const count = selectedSids.size;
  const hasSelection = count > 0;

  const zip = el("log_zip");
  if (zip) {
    zip.textContent = hasSelection ? `DOWNLOAD (${count})` : "DOWNLOAD";
    zip.href = "#";
    setActionEnabled(zip, hasSelection);
  }

  const del = el("log_delete");
  if (del) {
    del.textContent = hasSelection ? `DELETE (${count})` : "DELETE";
    setActionEnabled(del, hasSelection);
  }

  const info = el("log_sel_info");
  if (info) {
    if (typeof totalRows === "number") {
      info.textContent = `${count}/${totalRows} selezionati`;
    } else {
      info.textContent = `${count} selezionati`;
    }
  }
}

export async function apiPost(url, body) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : "{}",
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.err || j?.detail || ("HTTP " + r.status));
  return j;
}

export async function refreshLogStatus() {
  const s = await fetch("/api/log/status").then((r) => r.json());
  const sid = String(s?.sid || "").trim();
  logStatus = { enabled: !!s?.enabled, sid };

  const pill = el("log_status");
  if (pill) pill.textContent = logStatus.enabled ? `ON ${sid}` : (sid ? `OFF ${sid}` : "OFF");
}

export async function refreshLogSessions() {
  const j = await fetch("/api/log/sessions").then((r) => r.json());
  const box = el("log_sessions");
  if (!box) return;

  const arr = (j.sessions || []).sort((a, b) => (b.sid || "").localeCompare(a.sid || ""));
  const available = new Set(arr.map((x) => x.sid));
  selectedSids = new Set(Array.from(selectedSids).filter((sid) => available.has(sid)));

  if (!arr.length) {
    selectedSids.clear();
    box.textContent = "Nessuna sessione salvata.";
    updateBulkActions(0);
    return;
  }

  const allChecked = arr.every((x) => selectedSids.has(x.sid));
  box.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;">
      <label style="display:inline-flex;align-items:center;gap:6px;">
        <input id="log_sel_all" type="checkbox" ${allChecked ? "checked" : ""}>
        <span>Seleziona tutti</span>
      </label>
      <span class="pill mono" id="log_sel_info">${selectedSids.size}/${arr.length} selezionati</span>
    </div>
    ${arr
      .map((x) => {
        const files = [];
        if (x.telemetry) files.push("telemetry");
        if (x.alarms) files.push("alarms");
        if (x.events) files.push("events");
        const checked = selectedSids.has(x.sid) ? "checked" : "";
        return `
          <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:6px;padding:6px 8px;border:1px solid rgba(255,255,255,.08);border-radius:8px;background:rgba(255,255,255,.03);">
            <label style="display:inline-flex;align-items:center;gap:8px;cursor:pointer;">
              <input class="log_sel_ck" type="checkbox" data-sid="${x.sid}" ${checked}>
              <span>${x.sid}</span>
            </label>
            <span class="pill mono">${files.length ? files.join(" | ") : "empty"}</span>
          </div>
        `;
      })
      .join("")}
  `;

  const allNode = el("log_sel_all");
  if (allNode) {
    allNode.onchange = () => {
      if (allNode.checked) {
        arr.forEach((x) => selectedSids.add(x.sid));
      } else {
        arr.forEach((x) => selectedSids.delete(x.sid));
      }
      box.querySelectorAll(".log_sel_ck").forEach((ck) => {
        ck.checked = allNode.checked;
      });
      updateBulkActions(arr.length);
    };
  }

  box.querySelectorAll(".log_sel_ck").forEach((ck) => {
    ck.onchange = () => {
      const sid = String(ck.dataset.sid || "").trim();
      if (!sid) return;
      if (ck.checked) selectedSids.add(sid);
      else selectedSids.delete(sid);

      const allSelected = arr.every((x) => selectedSids.has(x.sid));
      const allToggle = el("log_sel_all");
      if (allToggle) allToggle.checked = allSelected;
      updateBulkActions(arr.length);
    };
  });

  updateBulkActions(arr.length);
}

async function downloadSelected() {
  const sids = selectedList();
  if (!sids.length) return;

  if (sids.length === 1) {
    window.location.href = `/api/log/zip?sid=${encodeURIComponent(sids[0])}`;
    return;
  }

  const r = await fetch("/api/log/zip_many", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sids }),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j?.err || j?.detail || ("HTTP " + r.status));
  }

  const blob = await r.blob();
  const filename = parseFilenameFromDisposition(
    r.headers.get("Content-Disposition"),
    "deepex_logs_multi.zip"
  );
  downloadBlob(blob, filename);
}

async function deleteSelected() {
  const sids = selectedList();
  if (!sids.length) return;

  if (logStatus.enabled && logStatus.sid && sids.includes(logStatus.sid)) {
    window.alert("Stop logging before deleting current session");
    return;
  }

  if (!window.confirm(`Delete ${sids.length} selected session(s)?`)) return;

  await apiPost("/api/log/delete_many", { sids });
  selectedSids.clear();
  await refreshLogStatus();
  await refreshLogSessions();
}

export function setupLogs() {
  const bStart = el("log_start");
  const bStop = el("log_stop");
  const bDelete = el("log_delete");
  const bZip = el("log_zip");

  if (bStart) {
    bStart.onclick = async () => {
      try {
        await apiPost("/api/log/start");
        await refreshLogStatus();
        await refreshLogSessions();
      } catch (e) {
        console.error("log start failed", e);
      }
    };
  }

  if (bStop) {
    bStop.onclick = async () => {
      try {
        await apiPost("/api/log/stop");
        await refreshLogStatus();
        await refreshLogSessions();
      } catch (e) {
        console.error("log stop failed", e);
      }
    };
  }

  if (bZip) {
    bZip.onclick = async (ev) => {
      ev.preventDefault();
      try {
        await downloadSelected();
      } catch (e) {
        console.error("log download failed", e);
        window.alert(e?.message || "Failed to download selected sessions");
      }
    };
  }

  if (bDelete) {
    bDelete.onclick = async () => {
      try {
        await deleteSelected();
      } catch (e) {
        console.error("log delete failed", e);
        window.alert(e?.message || "Failed to delete selected sessions");
      }
    };
  }

  const note = el("log_note");
  const add = el("log_note_add");
  if (add) {
    add.onclick = async () => {
      try {
        const text = (note?.value || "").trim();
        if (!text) return;
        await apiPost("/api/log/event", { type: "NOTE", text });
        note.value = "";
        const ml = el("mission_log");
        if (ml) ml.textContent = "NOTE saved";
      } catch (e) {
        console.error("log event failed", e);
      }
    };
  }

  updateBulkActions(0);
}

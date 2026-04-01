import { el } from "./utils.js?v=16";

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
  return m?.[1] || fallbackName;
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

  const downloadBtn = el("log_download");
  if (downloadBtn) {
    downloadBtn.textContent = hasSelection ? `DOWNLOAD (${count})` : "DOWNLOAD";
    setActionEnabled(downloadBtn, hasSelection);
  }

  const deleteBtn = el("log_delete");
  if (deleteBtn) {
    deleteBtn.textContent = hasSelection ? `DELETE (${count})` : "DELETE";
    setActionEnabled(deleteBtn, hasSelection);
  }

  const info = el("log_sel_info");
  if (info) {
    info.textContent = typeof totalRows === "number"
      ? `${count}/${totalRows} selezionati`
      : `${count} selezionati`;
  }
}

function syncSessionListUI(box, arr) {
  const allSelected = arr.length > 0 && arr.every((x) => selectedSids.has(x.sid));

  const allBtn = el("log_sel_all_btn");
  if (allBtn) {
    allBtn.textContent = allSelected ? "DESELEZIONA TUTTI" : "SELEZIONA TUTTI";
  }

  box.querySelectorAll(".logRow").forEach((row) => {
    const sid = String(row.dataset.sid || "").trim();
    const isSelected = selectedSids.has(sid);
    row.classList.toggle("selected", isSelected);

    const btn = row.querySelector(".logSelBtn");
    if (btn) {
      btn.classList.toggle("on", isSelected);
      btn.textContent = isSelected ? "✓" : "";
      btn.setAttribute("aria-pressed", isSelected ? "true" : "false");
      btn.title = isSelected ? "Selezionato" : "Seleziona";
    }
  });

  updateBulkActions(arr.length);
}

function toggleSid(sid) {
  if (!sid) return;
  if (selectedSids.has(sid)) selectedSids.delete(sid);
  else selectedSids.add(sid);
}

export async function apiPost(url, body) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : "{}",
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.err || j?.detail || (`HTTP ${r.status}`));
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
    box.innerHTML = `<div class="mono">Nessuna sessione salvata.</div>`;
    updateBulkActions(0);
    return;
  }

  box.innerHTML = `
    <div class="logSelHead">
      <button type="button" id="log_sel_all_btn" class="logActionBtn small">SELEZIONA TUTTI</button>
      <span class="pill mono" id="log_sel_info">${selectedSids.size}/${arr.length} selezionati</span>
    </div>
    <div class="logRows">
      ${arr.map((x) => {
        const files = [];
        if (x.telemetry) files.push("telemetry");
        if (x.alarms) files.push("alarms");
        if (x.events) files.push("events");
        return `
          <div class="logRow" data-sid="${x.sid}">
            <button type="button" class="logSelBtn" data-sid="${x.sid}" aria-pressed="false"></button>
            <span class="logSid">${x.sid}</span>
            <span class="pill mono logKinds">${files.length ? files.join(" | ") : "empty"}</span>
          </div>
        `;
      }).join("")}
    </div>
  `;

  const allBtn = el("log_sel_all_btn");
  if (allBtn) {
    allBtn.onclick = () => {
      const allSelected = arr.length > 0 && arr.every((x) => selectedSids.has(x.sid));
      if (allSelected) {
        arr.forEach((x) => selectedSids.delete(x.sid));
      } else {
        arr.forEach((x) => selectedSids.add(x.sid));
      }
      syncSessionListUI(box, arr);
    };
  }

  box.querySelectorAll(".logSelBtn").forEach((btn) => {
    btn.onclick = (ev) => {
      ev.stopPropagation();
      const sid = String(btn.dataset.sid || "").trim();
      toggleSid(sid);
      syncSessionListUI(box, arr);
    };
  });

  box.querySelectorAll(".logRow").forEach((row) => {
    row.onclick = () => {
      const sid = String(row.dataset.sid || "").trim();
      toggleSid(sid);
      syncSessionListUI(box, arr);
    };
  });

  syncSessionListUI(box, arr);
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
    throw new Error(j?.err || j?.detail || (`HTTP ${r.status}`));
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
  const bDownload = el("log_download");

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

  if (bDownload) {
    bDownload.onclick = async () => {
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

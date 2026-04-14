import { el, setText } from './utils.js?v=16';

const VIDEO_STREAM_COUNT = 3;
const VIDEO_STORAGE_KEY = "calypso_video";
const VIDEO_KINDS = new Set(["auto", "rtsp", "mjpeg", "video"]);
const DEFAULT_STREAM = Object.freeze({ kind: "auto", url: "" });

export let videoState = loadVideoPrefs();

function cloneDefaultStream() {
  return { ...DEFAULT_STREAM };
}

function clampStreamIndex(value) {
  const idx = Number(value);
  if (!Number.isInteger(idx) || idx < 0) return 0;
  return Math.min(VIDEO_STREAM_COUNT - 1, idx);
}

function normalizeStream(raw) {
  const src = (raw && typeof raw === "object") ? raw : {};
  const kind = VIDEO_KINDS.has(src.kind) ? src.kind : "auto";
  const url = typeof src.url === "string" ? src.url.trim() : "";
  return { kind, url };
}

function normalizeVideoPrefs(raw) {
  const base = {
    activeIndex: 0,
    isStopped: false,
    streams: Array.from({ length: VIDEO_STREAM_COUNT }, () => cloneDefaultStream()),
  };

  const src = (raw && typeof raw === "object") ? raw : {};
  if (Array.isArray(src.streams)) {
    for (let i = 0; i < VIDEO_STREAM_COUNT; i += 1) {
      base.streams[i] = normalizeStream(src.streams[i]);
    }
  } else if ("kind" in src || "url" in src) {
    base.streams[0] = normalizeStream(src);
  }

  base.activeIndex = clampStreamIndex(src.activeIndex);
  base.isStopped = !!src.isStopped;
  return base;
}

function streamLabel(index) {
  return `Stream ${clampStreamIndex(index) + 1}`;
}

function currentStream() {
  return videoState.streams[videoState.activeIndex] || cloneDefaultStream();
}

export function loadVideoPrefs() {
  try {
    return normalizeVideoPrefs(JSON.parse(localStorage.getItem(VIDEO_STORAGE_KEY) || "{}"));
  } catch (e) {
    return normalizeVideoPrefs();
  }
}

export function saveVideoPrefs() {
  localStorage.setItem(VIDEO_STORAGE_KEY, JSON.stringify(videoState));
}

function syncVideoInputs() {
  for (let i = 0; i < VIDEO_STREAM_COUNT; i += 1) {
    const stream = videoState.streams[i] || cloneDefaultStream();
    const src = el(`video_source_${i + 1}`);
    const url = el(`video_url_${i + 1}`);
    if (src) src.value = stream.kind;
    if (url) url.value = stream.url;
  }
}

function renderVideoPresetUi() {
  for (let i = 0; i < VIDEO_STREAM_COUNT; i += 1) {
    const active = i === videoState.activeIndex;
    const btn = el(`video_select_${i + 1}`);
    const card = el(`video_preset_card_${i + 1}`);
    const pill = el(`video_stream_state_${i + 1}`);
    const stream = videoState.streams[i] || cloneDefaultStream();
    if (btn) btn.classList.toggle("active", active);
    if (card) card.classList.toggle("active", active);
    if (pill) {
      let status = stream.url ? stream.kind.toUpperCase() : "NO URL";
      if (active && videoState.isStopped) status = "STOPPED";
      else if (active && stream.url) status = `${status} LIVE`;
      pill.textContent = status;
    }
  }
}

function updateStream(index, patch, remount = false) {
  const idx = clampStreamIndex(index);
  videoState.streams[idx] = {
    ...(videoState.streams[idx] || cloneDefaultStream()),
    ...patch,
  };
  saveVideoPrefs();
  renderVideoPresetUi();
  if (remount && idx === videoState.activeIndex) {
    videoState.isStopped = false;
    saveVideoPrefs();
    mountActiveVideo();
  }
}

function bindStreamControls(index) {
  const idx = clampStreamIndex(index);
  const src = el(`video_source_${idx + 1}`);
  const url = el(`video_url_${idx + 1}`);
  const selectBtn = el(`video_select_${idx + 1}`);
  const commitUrl = () => {
    updateStream(idx, { url: String(url?.value || "").trim() }, idx === videoState.activeIndex);
  };

  if (src) {
    src.onchange = () => {
      const kind = VIDEO_KINDS.has(src.value) ? src.value : "auto";
      updateStream(idx, { kind }, idx === videoState.activeIndex);
    };
  }

  if (url) {
    url.addEventListener("change", commitUrl);
    url.addEventListener("blur", commitUrl);
    url.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      commitUrl();
    });
  }

  if (selectBtn) {
    selectBtn.onclick = () => selectVideoStream(idx);
  }
}

export function setupVideo() {
  const stop = el("video_stop");
  if (!stop) return;

  syncVideoInputs();
  for (let i = 0; i < VIDEO_STREAM_COUNT; i += 1) {
    bindStreamControls(i);
  }
  renderVideoPresetUi();

  stop.onclick = () => {
    videoState.isStopped = true;
    saveVideoPrefs();
    unmountVideo();
    renderVideoPresetUi();
    setText("video_status", `${streamLabel(videoState.activeIndex)} stopped`);
  };
}

export function selectVideoStream(index) {
  videoState.activeIndex = clampStreamIndex(index);
  videoState.isStopped = false;
  saveVideoPrefs();
  renderVideoPresetUi();
  mountActiveVideo();
}

export function unmountVideo() {
  const slot = el("video_slot");
  if (!slot) return;
  const media = slot.querySelectorAll("video,img");
  for (const node of media) {
    if (node.tagName === "VIDEO") {
      node.pause?.();
      node.removeAttribute("src");
      node.load?.();
    } else {
      node.removeAttribute("src");
    }
  }
  slot.innerHTML = "";
}

export function guessKind(url) {
  const u = (url || "").toLowerCase();
  if (u.startsWith('rtsp://') || u.startsWith('rtsps://')) return 'rtsp';
  if (u.includes('.mjpg') || u.includes('mjpeg') || u.includes('axis-cgi') || u.includes('cgi')) return 'mjpeg';
  return 'video';
}

export function resolveVideoSource(kind, url) {
  const finalKind = (kind === "auto") ? guessKind(url) : kind;
  if (finalKind === "rtsp") {
    const proxy = new URL('/api/video/rtsp-proxy', window.location.origin);
    proxy.searchParams.set('url', url);
    proxy.searchParams.set('_', String(Date.now()));
    return { kind: 'mjpeg', url: proxy.toString(), statusOk: 'RTSP proxy OK', statusErr: 'RTSP proxy error' };
  }
  if (finalKind === "mjpeg") {
    return { kind: 'mjpeg', url, statusOk: 'MJPEG OK', statusErr: 'MJPEG error' };
  }
  return { kind: 'video', url, statusOk: 'video OK', statusErr: 'video error' };
}

export function mountVideo(kind, url, label = "Stream") {
  const slot = el("video_slot");
  if (!slot) return;

  unmountVideo();
  if (!url) {
    setText("video_status", `${label} missing url`);
    slot.innerHTML = `<div class="mono" style="margin:12px;">Configura ${label.toLowerCase()} e selezionalo per iniziare la visualizzazione.</div>`;
    return;
  }

  const resolved = resolveVideoSource(kind, url);
  if (kind === "rtsp" || resolved.statusOk === "RTSP proxy OK") setText("video_status", `${label} RTSP connecting`);
  else setText("video_status", `${label} connecting`);

  if (resolved.kind === "mjpeg") {
    const img = document.createElement("img");
    img.src = resolved.url;
    img.onload = () => setText("video_status", `${label} ${resolved.statusOk}`);
    img.onerror = () => setText("video_status", `${label} ${resolved.statusErr}`);
    slot.appendChild(img);
    return;
  }

  const v = document.createElement("video");
  v.autoplay = true;
  v.muted = true;
  v.playsInline = true;
  v.controls = true;
  v.src = resolved.url;
  v.oncanplay = () => setText("video_status", `${label} ${resolved.statusOk}`);
  v.onerror = () => setText("video_status", `${label} ${resolved.statusErr}`);
  slot.appendChild(v);
  v.play().catch(() => { });
}

export function mountActiveVideo() {
  renderVideoPresetUi();
  if (videoState.isStopped) {
    unmountVideo();
    setText("video_status", `${streamLabel(videoState.activeIndex)} stopped`);
    return;
  }
  const stream = currentStream();
  mountVideo(stream.kind, stream.url, streamLabel(videoState.activeIndex));
}

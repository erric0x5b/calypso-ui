import { el, setText } from './utils.js?v=16';

const VIDEO_STREAM_COUNT = 3;
const VIDEO_STORAGE_KEY = "calypso_video";
const VIDEO_PREFS_VERSION = 3;
const VIDEO_KINDS = new Set(["auto", "rtsp", "webrtc", "mjpeg", "video"]);
const DEFAULT_STREAM = Object.freeze({ kind: "auto", url: "" });
const DEFAULT_STREAMS = Object.freeze([
  Object.freeze({ kind: "rtsp", url: "rtsp://admin:123456@192.168.2.15:554/mpeg4" }),
  DEFAULT_STREAM,
  DEFAULT_STREAM,
]);

export let videoState = loadVideoPrefs();
let activeWebRtc = null;

function cloneDefaultStream() {
  return { ...DEFAULT_STREAM };
}

function cloneDefaultStreamAt(index) {
  return { ...(DEFAULT_STREAMS[index] || DEFAULT_STREAM) };
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
    version: VIDEO_PREFS_VERSION,
    activeIndex: 0,
    isStopped: false,
    streams: Array.from({ length: VIDEO_STREAM_COUNT }, (_, i) => cloneDefaultStreamAt(i)),
  };

  const src = (raw && typeof raw === "object") ? raw : {};
  if (Array.isArray(src.streams)) {
    for (let i = 0; i < VIDEO_STREAM_COUNT; i += 1) {
      base.streams[i] = normalizeStream(src.streams[i]);
    }
    if (src.version !== VIDEO_PREFS_VERSION && !base.streams[0].url) {
      base.streams[0] = cloneDefaultStreamAt(0);
    }
  } else if ("kind" in src || "url" in src) {
    base.streams[0] = normalizeStream(src);
    if (!base.streams[0].url) {
      base.streams[0] = cloneDefaultStreamAt(0);
    }
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
  const snapshot = el("video_snapshot");
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

  if (snapshot) {
    snapshot.onclick = async () => {
      snapshot.disabled = true;
      try {
        const saved = await captureActiveSnapshotToLog();
        setText("video_status", `${streamLabel(videoState.activeIndex)} snapshot saved: ${saved.file}`);
      } catch (e) {
        setText("video_status", e?.message || "snapshot failed");
      } finally {
        snapshot.disabled = false;
      }
    };
  }
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
  closeActiveWebRtc();
  const media = slot.querySelectorAll("video,img");
  for (const node of media) {
    if (node.tagName === "VIDEO") {
      node.srcObject = null;
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
  if (u.startsWith('whep://') || u.includes('/whep')) return 'webrtc';
  if (u.includes('.mjpg') || u.includes('mjpeg') || u.includes('axis-cgi') || u.includes('cgi')) return 'mjpeg';
  return 'video';
}

export function resolveVideoSource(kind, url) {
  const finalKind = (kind === "auto") ? guessKind(url) : kind;
  if (finalKind === "webrtc") {
    return { kind: 'webrtc', url, statusOk: 'WebRTC OK', statusErr: 'WebRTC error' };
  }
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

function closeActiveWebRtc() {
  const session = activeWebRtc;
  activeWebRtc = null;
  if (!session) return;
  try { session.abort?.abort(); } catch { }
  try {
    for (const sender of session.pc?.getSenders?.() || []) sender.track?.stop?.();
    for (const receiver of session.pc?.getReceivers?.() || []) receiver.track?.stop?.();
    session.pc?.close?.();
  } catch { }
  if (session.resourceUrl) {
    fetch(session.resourceUrl, { method: "DELETE", keepalive: true }).catch(() => { });
  }
}

function resolveWhepUrl(url) {
  const raw = String(url || "").trim();
  if (raw.toLowerCase().startsWith("whep://")) {
    return `http://${raw.slice("whep://".length)}`;
  }
  return raw;
}

function waitForIceGatheringComplete(pc, timeoutMs = 1500) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange", onState);
      resolve();
    };
    const onState = () => {
      if (pc.iceGatheringState === "complete") finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    pc.addEventListener("icegatheringstatechange", onState);
  });
}

function locationToAbsoluteUrl(location, baseUrl) {
  if (!location) return null;
  try {
    return new URL(location, baseUrl).toString();
  } catch {
    return null;
  }
}

async function mountWebRtcVideo(url, label, resolved) {
  const slot = el("video_slot");
  if (!slot) return;

  if (!window.RTCPeerConnection) {
    setText("video_status", `${label} WebRTC not supported`);
    return;
  }

  const whepUrl = resolveWhepUrl(url);
  const abort = new AbortController();
  const pc = new RTCPeerConnection({
    iceServers: [],
    bundlePolicy: "max-bundle",
    rtcpMuxPolicy: "require",
  });
  activeWebRtc = { pc, abort, resourceUrl: null };

  const video = document.createElement("video");
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  video.controls = false;
  video.srcObject = new MediaStream();
  slot.appendChild(video);

  pc.addTransceiver("video", { direction: "recvonly" });
  pc.ontrack = (event) => {
    const stream = event.streams?.[0] || video.srcObject;
    if (stream && video.srcObject !== stream) video.srcObject = stream;
    if (!event.streams?.length && event.track) video.srcObject.addTrack(event.track);
    video.play().catch(() => { });
  };
  pc.onconnectionstatechange = () => {
    const state = pc.connectionState || pc.iceConnectionState;
    if (state === "connected") setText("video_status", `${label} ${resolved.statusOk}`);
    else if (state === "failed" || state === "disconnected") setText("video_status", `${label} ${resolved.statusErr}`);
  };

  try {
    setText("video_status", `${label} WebRTC connecting`);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceGatheringComplete(pc);

    const response = await fetch(whepUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/sdp",
        "Accept": "application/sdp",
      },
      body: pc.localDescription.sdp,
      signal: abort.signal,
    });
    if (!response.ok) throw new Error(`WHEP HTTP ${response.status}`);

    const session = activeWebRtc;
    if (session?.pc === pc) {
      session.resourceUrl = locationToAbsoluteUrl(response.headers.get("Location"), whepUrl);
    }
    const answer = await response.text();
    await pc.setRemoteDescription({ type: "answer", sdp: answer });
  } catch (e) {
    if (activeWebRtc?.pc === pc) closeActiveWebRtc();
    setText("video_status", `${label} ${e?.message || resolved.statusErr}`);
  }
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
  if (resolved.kind === "webrtc") {
    mountWebRtcVideo(resolved.url, label, resolved);
    return;
  }
  if (kind === "rtsp" || resolved.statusOk === "RTSP proxy OK") setText("video_status", `${label} RTSP connecting`);
  else setText("video_status", `${label} connecting`);

  if (resolved.kind === "mjpeg") {
    const img = document.createElement("img");
    img.crossOrigin = "anonymous";
    img.src = resolved.url;
    img.onload = () => setText("video_status", `${label} ${resolved.statusOk}`);
    img.onerror = () => setText("video_status", `${label} ${resolved.statusErr}`);
    slot.appendChild(img);
    return;
  }

  const v = document.createElement("video");
  v.autoplay = true;
  v.crossOrigin = "anonymous";
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

function activeMediaElement() {
  const slot = el("video_slot");
  if (!slot || videoState.isStopped) return null;
  return slot.querySelector("video,img");
}

function mediaDimensions(node) {
  if (!node) return { width: 0, height: 0 };
  if (node.tagName === "VIDEO") {
    return {
      width: Number(node.videoWidth || 0),
      height: Number(node.videoHeight || 0),
    };
  }
  return {
    width: Number(node.naturalWidth || node.clientWidth || 0),
    height: Number(node.naturalHeight || node.clientHeight || 0),
  };
}

function drawMediaSnapshot(node) {
  const dims = mediaDimensions(node);
  if (!dims.width || !dims.height) {
    throw new Error("snapshot non disponibile: stream non pronto");
  }

  const canvas = document.createElement("canvas");
  canvas.width = dims.width;
  canvas.height = dims.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("snapshot non disponibile: canvas non supportato");
  ctx.drawImage(node, 0, 0, dims.width, dims.height);
  return canvas.toDataURL("image/png");
}

export async function captureActiveSnapshotToLog() {
  const node = activeMediaElement();
  if (!node) throw new Error("snapshot non disponibile: nessun video attivo");

  let image;
  try {
    image = drawMediaSnapshot(node);
  } catch (e) {
    const msg = e?.name === "SecurityError"
      ? "snapshot non disponibile: sorgente video senza CORS, usa RTSP proxy o stream same-origin"
      : (e?.message || "snapshot non disponibile");
    throw new Error(msg);
  }

  const stream = currentStream();
  const r = await fetch("/api/log/snapshot", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      image,
      text: `${streamLabel(videoState.activeIndex)} snapshot`,
      stream: {
        index: videoState.activeIndex + 1,
        kind: stream.kind,
        url: stream.url,
      },
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j?.ok) {
    throw new Error(j?.err || j?.detail || (`HTTP ${r.status}`));
  }
  return j;
}

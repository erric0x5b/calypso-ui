import { el, setText } from './utils.js?v=16';

export let videoState = { kind: "auto", url: "" };

export function loadVideoPrefs(){
  try{
    const j = JSON.parse(localStorage.getItem("calypso_video") || "{}");
    return { kind: j.kind || "auto", url: j.url || "" };
  }catch(e){ return { kind:"auto", url:"" }; }
}
export function saveVideoPrefs(){ localStorage.setItem("calypso_video", JSON.stringify(videoState)); }

export function setupVideo(){
  // TODO(spec TODO-IMPL-VIDEO-SOURCES): load real camera/sonar endpoints from centralized config when available.
  const src = el("video_source");
  const url = el("video_url");
  const apply = el("video_apply");
  const stop = el("video_stop");
  if(!src || !url || !apply || !stop) return;
  src.value = videoState.kind;
  url.value = videoState.url;
  apply.onclick = () => { videoState.kind = src.value; videoState.url = (url.value||"").trim(); saveVideoPrefs(); mountVideo(videoState.kind, videoState.url); };
  stop.onclick = () => { unmountVideo(); setText("video_status", "stopped"); };
}

export function unmountVideo(){
  const slot = el("video_slot");
  if(!slot) return;
  const media = slot.querySelectorAll("video,img");
  for(const node of media){
    if(node.tagName === "VIDEO"){
      node.pause?.();
      node.removeAttribute("src");
      node.load?.();
    }else{
      node.removeAttribute("src");
    }
  }
  slot.innerHTML = "";
}

export function guessKind(url){
  const u = (url||"").toLowerCase();
  if(u.startsWith('rtsp://') || u.startsWith('rtsps://')) return 'rtsp';
  if(u.includes('.mjpg')||u.includes('mjpeg')||u.includes('axis-cgi')||u.includes('cgi')) return 'mjpeg';
  return 'video';
}

export function resolveVideoSource(kind, url){
  const finalKind = (kind === "auto") ? guessKind(url) : kind;
  if(finalKind === "rtsp"){
    const proxy = new URL('/api/video/rtsp-proxy', window.location.origin);
    proxy.searchParams.set('url', url);
    proxy.searchParams.set('_', String(Date.now()));
    return { kind: 'mjpeg', url: proxy.toString(), statusOk: 'RTSP proxy OK', statusErr: 'RTSP proxy error' };
  }
  if(finalKind === "mjpeg"){
    return { kind: 'mjpeg', url, statusOk: 'MJPEG OK', statusErr: 'MJPEG error' };
  }
  return { kind: 'video', url, statusOk: 'video OK', statusErr: 'video error' };
}

export function mountVideo(kind, url){
  const slot = el("video_slot"); if(!slot) return; unmountVideo(); if(!url){ setText("video_status","missing url"); slot.innerHTML = `<div class="mono" style="margin:12px;">Inserisci un URL stream e premi APPLY.</div>`; return; }
  const resolved = resolveVideoSource(kind, url);
  if(kind === "rtsp" || resolved.statusOk === "RTSP proxy OK") setText("video_status", "RTSP connecting");
  else setText("video_status", "connecting");
  if(resolved.kind === "mjpeg"){ const img = document.createElement("img"); img.src = resolved.url; img.onload = () => setText("video_status", resolved.statusOk); img.onerror = () => setText("video_status", resolved.statusErr); slot.appendChild(img); return; }
  const v = document.createElement("video"); v.autoplay=true; v.muted=true; v.playsInline=true; v.controls=true; v.src=resolved.url; v.oncanplay = () => setText("video_status", resolved.statusOk); v.onerror = () => setText("video_status", resolved.statusErr); slot.appendChild(v); v.play().catch(()=>{});
}

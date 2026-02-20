import { el, setText } from './utils.js';

export let videoState = { kind: "mjpeg", url: "" };

export function loadVideoPrefs(){
  try{
    const j = JSON.parse(localStorage.getItem("calypso_video") || "{}");
    return { kind: j.kind || "auto", url: j.url || "" };
  }catch(e){ return { kind:"auto", url:"" }; }
}
export function saveVideoPrefs(){ localStorage.setItem("calypso_video", JSON.stringify(videoState)); }

export function setupVideo(){
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

export function unmountVideo(){ const slot = el("video_slot"); if(slot) slot.innerHTML = ""; }

export function guessKind(url){ const u = (url||"").toLowerCase(); if(u.includes('.mjpg')||u.includes('mjpeg')||u.includes('axis-cgi')||u.includes('cgi')) return 'mjpeg'; return 'video'; }

export function mountVideo(kind, url){
  const slot = el("video_slot"); if(!slot) return; unmountVideo(); if(!url){ setText("video_status","missing url"); slot.innerHTML = `<div class="mono" style="margin:12px;">Inserisci un URL stream e premi APPLY.</div>`; return; }
  const finalKind = (kind === "auto") ? guessKind(url) : kind;
  if(finalKind === "mjpeg"){ const img = document.createElement("img"); img.src = url; img.onload = () => setText("video_status","MJPEG OK"); img.onerror = () => setText("video_status","MJPEG error"); slot.appendChild(img); return; }
  const v = document.createElement("video"); v.autoplay=true; v.muted=true; v.playsInline=true; v.controls=true; v.src=url; v.oncanplay = () => setText("video_status","video OK"); v.onerror = () => setText("video_status","video error"); slot.appendChild(v); v.play().catch(()=>{});
}

// sonar_ping360.js
window.sonarPing360 = (function(){
  let canvas, ctx;
  let W=0,H=0, cx=0, cy=0, R=0;

  function init(){
    canvas = document.getElementById("sonarCanvas");
    if(!canvas) return false;
    ctx = canvas.getContext("2d");
    resize();
    clear();
    window.addEventListener("resize", resize);
    return true;
  }

  function resize(){
    if(!canvas) return;
    const r = canvas.getBoundingClientRect();
    canvas.width = Math.max(300, Math.floor(r.width*devicePixelRatio));
    canvas.height = Math.max(300, Math.floor(r.height*devicePixelRatio));
    W = canvas.width; H = canvas.height;
    cx = W*0.5; cy = H*0.55;
    R = Math.min(W,H)*0.45;
  }

  function clear(){
    if(!ctx) return;
    ctx.clearRect(0,0,W,H);
  }

  function apply(msg){
    // msg: {type:"sonar", kind:"ping360", angle_deg, samples:[...], ...}
    // fallback supported: kind "ping360_auto_device_data" with payload{angle_grad,data}
    if(!ctx && !init()) return;
    if(msg.kind !== "ping360" && msg.kind !== "ping360_auto_device_data") return;

    const fromPayload = msg.kind === "ping360_auto_device_data";
    const angleGrad = fromPayload ? (msg?.payload?.angle_grad || 0) : (msg.angle_deg || 0);
    const samples = fromPayload ? (msg?.payload?.data || []) : (msg.samples || []);
    const ang = Number(angleGrad) * Math.PI / 200; // 0..399 grad -> 2π
    const n = samples.length || 1;

    // disegna una “riga” radiale
    for(let i=0;i<n;i++){
      const t = i/(n-1);
      const r = t*R;
      const x = cx + Math.cos(ang)*r;
      const y = cy - Math.sin(ang)*r;

      const v = samples[i] || 0;          // 0..255 o 0..1023 dipende
      const a = Math.min(1, Math.max(0, v/255)); // normalizza semplice

      ctx.fillStyle = `rgba(45,107,255,${a})`;
      ctx.fillRect(x, y, 2, 2);
    }
  }

  return { init, apply, clear };
})();

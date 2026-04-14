// sonar_ping360.js
window.sonarPing360 = (function(){
  let canvas, ctx;
  let W = 0, H = 0, cx = 0, cy = 0, R = 0;
  const beams = new Map();
  let options = {
    headingLock: false,
    headingDeg: 0,
    rangeM: 60,
  };

  function init(){
    canvas = document.getElementById("sonarCanvas");
    if(!canvas) return false;
    ctx = canvas.getContext("2d");
    resize();
    window.removeEventListener("resize", resize);
    window.addEventListener("resize", resize);
    render();
    return true;
  }

  function resize(){
    if(!canvas) return;
    const r = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(320, Math.floor(r.width * dpr));
    canvas.height = Math.max(320, Math.floor(r.height * dpr));
    W = canvas.width;
    H = canvas.height;
    cx = W * 0.5;
    cy = H * 0.52;
    R = Math.min(W, H) * 0.43;
    render();
  }

  function clear(){
    beams.clear();
    render();
  }

  function normGrad(value){
    const n = Number(value);
    if(!Number.isFinite(n)) return 0;
    return ((Math.round(n) % 400) + 400) % 400;
  }

  function polar(grad, radius){
    const a = grad * Math.PI / 200;
    return {
      x: cx + Math.sin(a) * radius,
      y: cy - Math.cos(a) * radius
    };
  }

  function compassDisplayGrad(deg){
    const headingGrad = options.headingLock ? (Number(options.headingDeg || 0) / 0.9) : 0;
    return normGrad((Number(deg || 0) / 0.9) - headingGrad);
  }

  function rangeLabel(i){
    const range = Number(options.rangeM);
    if(!Number.isFinite(range) || range <= 0) return "";
    return `${Math.round(range * i / 4)}m`;
  }

  function drawGrid(){
    if(!ctx) return;
    ctx.save();
    ctx.lineWidth = Math.max(1, W / 900);
    ctx.strokeStyle = "rgba(170,182,214,.18)";
    ctx.fillStyle = "rgba(234,240,255,.78)";
    ctx.font = `${Math.max(11, Math.floor(W / 80))}px ui-monospace, Menlo, monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    for(let i = 1; i <= 4; i++){
      ctx.beginPath();
      ctx.arc(cx, cy, R * i / 4, 0, Math.PI * 2);
      ctx.stroke();
      const label = rangeLabel(i);
      if(label){
        ctx.fillText(label, cx + 22, cy - (R * i / 4));
      }
    }

    for(let deg = 0; deg < 360; deg += 30){
      const grad = compassDisplayGrad(deg);
      const p = polar(grad, R);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(p.x, p.y);
      ctx.strokeStyle = deg % 90 === 0 ? "rgba(170,182,214,.32)" : "rgba(170,182,214,.13)";
      ctx.stroke();
    }

    const labels = [
      [0, "0"],
      [30, "30"],
      [60, "60"],
      [90, "90"],
      [120, "120"],
      [150, "150"],
      [180, "180"],
      [210, "210"],
      [240, "240"],
      [270, "270"],
      [300, "300"],
      [330, "330"],
    ];
    for(const [deg, text] of labels){
      const p = polar(compassDisplayGrad(deg), R + 18);
      ctx.fillText(text, p.x, p.y);
    }

    if(options.headingLock){
      ctx.fillStyle = "rgba(34,197,94,.90)";
      ctx.fillText(`HDG ${Math.round(Number(options.headingDeg || 0))}`, cx, cy + R + 28);
    }

    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(45,107,255,.45)";
    ctx.lineWidth = Math.max(1.5, W / 700);
    ctx.stroke();

    ctx.fillStyle = "rgba(45,107,255,.85)";
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(3, W / 180), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawBeam(grad, samples){
    if(!ctx || !samples || !samples.length) return;
    const a = normGrad(grad) * Math.PI / 200;
    const sx = Math.sin(a);
    const cyv = Math.cos(a);
    const step = R / Math.max(1, samples.length - 1);
    const dot = Math.max(1, Math.floor(W / 500));

    for(let i = 0; i < samples.length; i++){
      const v = Number(samples[i]) || 0;
      const alpha = Math.min(1, Math.max(0, v / 255));
      if(alpha <= 0.02) continue;
      const r = i * step;
      const x = cx + sx * r;
      const y = cy - cyv * r;
      ctx.fillStyle = `rgba(45,180,255,${alpha})`;
      ctx.fillRect(x - dot * 0.5, y - dot * 0.5, dot, dot);
    }
  }

  function render(){
    if(!ctx) return;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#050914";
    ctx.fillRect(0, 0, W, H);
    drawGrid();
    for(const [grad, samples] of beams.entries()){
      drawBeam(Number(grad), samples);
    }
  }

  function updateStatus(angleGrad, samples){
    const angle = document.getElementById("sonar_last_angle");
    if(angle) angle.textContent = `angle: ${(angleGrad * 0.9).toFixed(1)} deg`;
    const count = document.getElementById("sonar_last_samples");
    if(count) count.textContent = `samples: ${samples.length}`;
  }

  function setOptions(next){
    options = { ...options, ...(next || {}) };
    render();
  }

  function apply(msg){
    if(!ctx && !init()) return;
    if(msg.kind !== "ping360" && msg.kind !== "ping360_auto_device_data") return;

    const fromPayload = msg.kind === "ping360_auto_device_data";
    const payload = msg.payload || {};
    const grad = normGrad(fromPayload ? payload.angle_grad : (msg.angle_grad ?? ((msg.angle_deg || 0) / 0.9)));
    const samples = fromPayload ? (payload.data || []) : (msg.samples || []);
    beams.set(grad, Array.from(samples));
    if(beams.size > 400){
      const first = beams.keys().next().value;
      beams.delete(first);
    }
    if(Number.isFinite(Number(msg.range_m))) options.rangeM = Number(msg.range_m);
    updateStatus(grad, samples);
    render();
  }

  return { init, apply, clear, setOptions };
})();

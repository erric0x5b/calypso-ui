// sonar_ping360.js
window.sonarPing360 = (function(){
  let canvas, ctx;
  let W = 0, H = 0, cx = 0, cy = 0, R = 0;
  const beams = new Map();
  let options = {
    headingLock: false,
    headingDeg: 0,
    rangeM: 60,
    palette: "jet",
    sectorStartGrad: 0,
    sectorStopGrad: 399,
  };

  const PALETTES = {
    jet: [
      [0.00, [0, 0, 128]],
      [0.20, [0, 96, 255]],
      [0.40, [0, 220, 255]],
      [0.60, [255, 240, 0]],
      [0.80, [255, 96, 0]],
      [1.00, [128, 0, 0]],
    ],
    parula: [
      [0.00, [53, 42, 135]],
      [0.20, [15, 92, 221]],
      [0.40, [18, 125, 216]],
      [0.60, [7, 156, 207]],
      [0.78, [72, 188, 148]],
      [0.90, [165, 190, 107]],
      [1.00, [249, 251, 14]],
    ],
    copper: [
      [0.00, [0, 0, 0]],
      [0.35, [78, 49, 31]],
      [0.65, [145, 90, 58]],
      [1.00, [255, 199, 127]],
    ],
    bw: [
      [0.00, [0, 0, 0]],
      [1.00, [255, 255, 255]],
    ],
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

  function lerp(a, b, t){
    return a + ((b - a) * t);
  }

  function clamp01(value){
    if(!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(1, value));
  }

  function sectorInfo(){
    const start = normGrad(options.sectorStartGrad);
    const stop = normGrad(options.sectorStopGrad);
    const rawSpan = (stop - start + 400) % 400;
    const full = rawSpan === 0 || rawSpan >= 399;
    return {
      start,
      stop,
      span: full ? 400 : rawSpan,
      full,
    };
  }

  function sectorContainsGrad(grad){
    const info = sectorInfo();
    if(info.full) return true;
    const rel = (normGrad(grad) - info.start + 400) % 400;
    return rel >= 0 && rel <= info.span;
  }

  function sectorGradAt(t){
    const info = sectorInfo();
    if(info.full) return normGrad(t * 400);
    return normGrad(info.start + (info.span * clamp01(t)));
  }

  function updateGeometry(){
    const margin = Math.max(20, Math.min(W, H) * 0.06);
    const info = sectorInfo();
    if(info.full){
      cx = W * 0.5;
      cy = H * 0.52;
      R = Math.min(W, H) * 0.43;
      return;
    }

    const points = [{ x: 0, y: 0 }];
    const steps = Math.max(24, Math.ceil(info.span / 4));
    for(let i = 0; i <= steps; i++){
      const grad = sectorGradAt(i / steps);
      const a = grad * Math.PI / 200;
      points.push({
        x: Math.sin(a),
        y: -Math.cos(a),
      });
    }

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for(const p of points){
      if(p.x < minX) minX = p.x;
      if(p.x > maxX) maxX = p.x;
      if(p.y < minY) minY = p.y;
      if(p.y > maxY) maxY = p.y;
    }

    const spanX = Math.max(1e-6, maxX - minX);
    const spanY = Math.max(1e-6, maxY - minY);
    R = Math.min((W - (margin * 2)) / spanX, (H - (margin * 2)) / spanY);
    cx = margin - (minX * R);
    cy = margin - (minY * R);
  }

  function paletteColor(value){
    const paletteName = Object.prototype.hasOwnProperty.call(PALETTES, options.palette) ? options.palette : "jet";
    const stops = PALETTES[paletteName];
    const v = clamp01(value);
    let prev = stops[0];
    for(let i = 1; i < stops.length; i++){
      const next = stops[i];
      if(v <= next[0]){
        const span = Math.max(1e-6, next[0] - prev[0]);
        const t = (v - prev[0]) / span;
        return [
          Math.round(lerp(prev[1][0], next[1][0], t)),
          Math.round(lerp(prev[1][1], next[1][1], t)),
          Math.round(lerp(prev[1][2], next[1][2], t)),
        ];
      }
      prev = next;
    }
    return prev[1].slice();
  }

  function drawSectorArc(radius, color, width){
    const info = sectorInfo();
    const steps = info.full ? 96 : Math.max(24, Math.ceil(info.span / 3));
    ctx.beginPath();
    for(let i = 0; i <= steps; i++){
      const p = polar(sectorGradAt(i / steps), radius);
      if(i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  }

  function drawGrid(){
    if(!ctx) return;
    const info = sectorInfo();
    ctx.save();
    ctx.lineWidth = Math.max(1, W / 900);
    ctx.strokeStyle = "rgba(170,182,214,.18)";
    ctx.fillStyle = "rgba(234,240,255,.78)";
    ctx.font = `${Math.max(11, Math.floor(W / 80))}px ui-monospace, Menlo, monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    for(let i = 1; i <= 4; i++){
      drawSectorArc(R * i / 4, "rgba(170,182,214,.18)", Math.max(1, W / 900));
    }

    for(let deg = 0; deg < 360; deg += 30){
      const grad = compassDisplayGrad(deg);
      if(!sectorContainsGrad(grad)) continue;
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
      const grad = compassDisplayGrad(deg);
      if(!sectorContainsGrad(grad)) continue;
      const p = polar(grad, R + 18);
      ctx.fillText(text, p.x, p.y);
    }

    if(options.headingLock){
      ctx.fillStyle = "rgba(34,197,94,.90)";
      ctx.fillText(`HDG ${Math.round(Number(options.headingDeg || 0))}`, cx, cy + R + 28);
    }

    drawSectorArc(R, "rgba(45,107,255,.45)", Math.max(1.5, W / 700));

    if(!info.full){
      const p0 = polar(info.start, R);
      const p1 = polar(info.stop, R);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(p0.x, p0.y);
      ctx.moveTo(cx, cy);
      ctx.lineTo(p1.x, p1.y);
      ctx.strokeStyle = "rgba(45,107,255,.45)";
      ctx.lineWidth = Math.max(1.2, W / 800);
      ctx.stroke();
    }

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
    const dot = Math.max(1.5, W / 420);
    let maxSample = 0;
    for(let i = 0; i < samples.length; i++){
      const v = Number(samples[i]) || 0;
      if(v > maxSample) maxSample = v;
    }
    const scale = maxSample > 0 ? maxSample : 1;

    for(let i = 0; i < samples.length; i++){
      const v = Number(samples[i]) || 0;
      const alpha = Math.pow(Math.min(1, Math.max(0, v / scale)), 0.65);
      if(alpha <= 0.04) continue;
      const r = i * step;
      const x = cx + sx * r;
      const y = cy - cyv * r;
      const glow = Math.min(1, 0.12 + (alpha * 0.88));
      const [cr, cg, cb] = paletteColor(alpha);
      ctx.fillStyle = `rgba(${cr},${cg},${cb},${glow})`;
      ctx.fillRect(x - dot * 0.5, y - dot * 0.5, dot, dot);
    }
  }

  function render(){
    if(!ctx) return;
    updateGeometry();
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#050914";
    ctx.fillRect(0, 0, W, H);
    drawGrid();
    for(const [grad, samples] of beams.entries()){
      if(!sectorContainsGrad(Number(grad))) continue;
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

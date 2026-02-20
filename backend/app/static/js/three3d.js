import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

export const rov3d = { inited:false, scene:null, camera:null, renderer:null, model:null, anim:null };

export function init3DOnce(){
  if(rov3d.inited) return;
  const host = document.getElementById("rov3d");
  if(!host){ console.warn("[3D] missing #rov3d"); return; }
  const w0 = host.clientWidth || 0; const h0 = host.clientHeight || 0;
  if (w0 < 10 || h0 < 10) { setTimeout(init3DOnce, 120); return; }
  const renderer = new THREE.WebGLRenderer({ antialias:true, alpha:false, powerPreference:"low-power" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(w0, h0, false);
  renderer.setClearColor(0x0b1220, 1);
  host.innerHTML = ""; host.appendChild(renderer.domElement);
  renderer.domElement.style.width = "100%"; renderer.domElement.style.height = "100%"; renderer.domElement.style.display = "block";
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, w0 / h0, 0.05, 100);
  camera.position.set(0.8, 0.35, 1.2); camera.lookAt(0,0,0);
  scene.add(new THREE.AmbientLight(0xffffff, 0.8));
  const dir = new THREE.DirectionalLight(0xffffff, 1.2); dir.position.set(2,2,2); scene.add(dir);
  const tick = () => { renderer.render(scene, camera); rov3d.anim = requestAnimationFrame(tick); };
  tick();
  const ro = new ResizeObserver(() => {
    const w = host.clientWidth || 0; const h = host.clientHeight || 0; if (w < 10 || h < 10) return; camera.aspect = w / h; camera.updateProjectionMatrix(); renderer.setSize(w, h, false);
  });
  ro.observe(host);
  rov3d.inited=true; rov3d.scene=scene; rov3d.camera=camera; rov3d.renderer=renderer;
  const loader = new GLTFLoader();
  loader.load("/static/models/rov.glb", (gltf)=>{
    const model = gltf.scene; const box = new THREE.Box3().setFromObject(model); const size = new THREE.Vector3(); const center = new THREE.Vector3(); box.getSize(size); box.getCenter(center); model.position.sub(center); const maxDim = Math.max(size.x,size.y,size.z)||1; const s = 1.0 / maxDim; model.scale.setScalar(s); scene.add(model); rov3d.model = model; const fov = camera.fov * (Math.PI/180); let camZ = Math.abs(1/(2*Math.tan(fov/2))); camZ*=1.8; camera.position.set(0,0.4,camZ); camera.lookAt(0,0,0); camera.updateProjectionMatrix();
  }, undefined, (err)=>console.error('[3D] load error', err));
}

export function setRovAttitudeRad(roll, pitch, yaw){ if(!rov3d.model) return; rov3d.model.rotation.set(pitch||0, yaw||0, roll||0); }
export function ensure3D(){ const host = document.getElementById("rov3d"); if(!host){ setTimeout(ensure3D, 100); return; } init3DOnce(); }
export function degToRad(d){ return (d || 0) * Math.PI / 180; }

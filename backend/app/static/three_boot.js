import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

window.THREE = THREE;
window.GLTFLoader = GLTFLoader;

console.log("[three_boot] THREE ok:", !!window.THREE, "GLTFLoader ok:", !!window.GLTFLoader);

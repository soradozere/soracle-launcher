import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

// The rotating JK2 emblem with a lightsaber blade running behind it, ported
// from Soracle's masthead-logo-3d.tsx (React Three Fiber) to plain Three.js,
// since this project has no bundler/React. Same model, same materials, same
// calibrated constants - just driven by a manual render loop instead of R3F.

const RING_BAND_CENTER_Y = -3.25;
const VERTICAL_NUDGE = 0.25;
// Extra downward shift so the emblem's top doesn't run past the canvas edge
// in this narrow vertical strip (the ported constants above were calibrated
// for a wider banner layout on the site).
const MASTHEAD_DROP = 1.7;

const BEAM_Z = -1.5;
const BEAM_HEIGHT = 30;
const HALO_WIDTH = 3.4;
const GLOW_WIDTH = 1.5;
const CORE_WIDTH = 0.45;
const HALO_OPACITY = 0.22;
const GLOW_OPACITY = 0.6;

const EMBLEM_SCALE = 0.88;
const FOV = 32;

const ASSET_BASE = "/assets/masthead";

function themePrimaryColor() {
  const value = getComputedStyle(document.documentElement).getPropertyValue("--primary").trim();
  return value || "#66fcf1";
}

async function init() {
  const container = document.getElementById("masthead");
  const canvas = document.getElementById("masthead-canvas");
  if (!container || !canvas) return;

  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 100);

  // Real reflections instead of the old flat matcap: a procedural studio
  // environment (soft box lighting from a few directions) gives the emblem
  // an actual chrome-like reflection that shifts correctly as it spins,
  // rather than a static screen-space fake.
  const pmremGenerator = new THREE.PMREMGenerator(renderer);
  const envRenderTarget = pmremGenerator.fromScene(new RoomEnvironment(), 0.04);
  scene.environment = envRenderTarget.texture;
  pmremGenerator.dispose();

  // A moving specular highlight needs an actual light, not just IBL - a dim
  // point riding near the camera keeps a bright hotspot sweeping across the
  // metal as the emblem rotates.
  const keyLight = new THREE.PointLight(0xffffff, 35, 0, 2);
  keyLight.position.set(2, 2, 4);
  scene.add(keyLight);

  // Measure the canvas itself, not the (narrower) masthead div - the canvas
  // is deliberately sized wider via CSS so the emblem can bleed out past the
  // masthead strip instead of being cropped at its border.
  function resize() {
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.position.z = w / 5.39 / (2 * Math.tan(THREE.MathUtils.degToRad(FOV / 2)));
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(canvas);
  resize();

  const textureLoader = new THREE.TextureLoader();
  const [coreMap, glowMap, diffuseMap] = await Promise.all([
    textureLoader.loadAsync(`${ASSET_BASE}/saber-core.jpg`),
    textureLoader.loadAsync(`${ASSET_BASE}/saber-glow.jpg`),
    textureLoader.loadAsync(`${ASSET_BASE}/logo-diffuse.jpg`),
  ]);

  // Half-blade profiles: mirror them about the centre so both sides fall off
  // identically instead of shoving a half blade to one side.
  for (const map of [coreMap, glowMap]) {
    map.wrapS = THREE.MirroredRepeatWrapping;
    map.wrapT = THREE.ClampToEdgeWrapping;
    map.repeat.set(2, 1);
    map.offset.set(-1, 0);
    map.needsUpdate = true;
  }
  diffuseMap.colorSpace = THREE.SRGBColorSpace;
  diffuseMap.needsUpdate = true;

  // --- saber beam: outside the rotating group so it never orbits ---
  const blade = new THREE.Group();
  blade.position.set(0, 0, BEAM_Z);

  const haloMaterial = new THREE.MeshBasicMaterial({
    map: glowMap,
    transparent: true,
    opacity: HALO_OPACITY,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const glowMaterial = new THREE.MeshBasicMaterial({
    map: glowMap,
    transparent: true,
    opacity: GLOW_OPACITY,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const coreMaterial = new THREE.MeshBasicMaterial({
    map: coreMap,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });

  function applyThemeColor() {
    const c = themePrimaryColor();
    haloMaterial.color.set(c);
    glowMaterial.color.set(c);
  }
  applyThemeColor();
  new MutationObserver(applyThemeColor).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["style"],
  });

  const haloMesh = new THREE.Mesh(new THREE.PlaneGeometry(HALO_WIDTH, BEAM_HEIGHT), haloMaterial);
  blade.add(haloMesh);

  const glowMesh = new THREE.Mesh(new THREE.PlaneGeometry(GLOW_WIDTH, BEAM_HEIGHT), glowMaterial);
  glowMesh.position.z = 0.005;
  blade.add(glowMesh);

  const coreMesh = new THREE.Mesh(new THREE.PlaneGeometry(CORE_WIDTH, BEAM_HEIGHT), coreMaterial);
  coreMesh.position.z = 0.01;
  blade.add(coreMesh);

  scene.add(blade);

  // --- spinning emblem: real metal now instead of a flat unlit diffuse +
  // matcap standing in for reflections - metalness/roughness respond to the
  // room environment above (and keyLight) for reflections that actually
  // move correctly as the emblem rotates, not a static screen-space fake ---
  const baseMaterial = new THREE.MeshPhysicalMaterial({
    map: diffuseMap,
    metalness: 0.9,
    roughness: 0.18,
    envMapIntensity: 1.7,
    clearcoat: 0.5,
    clearcoatRoughness: 0.15,
  });

  const gltf = await new GLTFLoader().loadAsync(`${ASSET_BASE}/jk2logo.glb`);
  const meshes = [];
  gltf.scene.traverse((child) => {
    if (child.isMesh) meshes.push(child);
  });
  for (const mesh of meshes) {
    mesh.material = baseMaterial;
  }

  const group = new THREE.Group();
  group.position.set(0, -RING_BAND_CENTER_Y - VERTICAL_NUDGE - MASTHEAD_DROP, 0);
  group.scale.setScalar(EMBLEM_SCALE);
  group.add(gltf.scene);
  scene.add(group);

  // --- animate: spin, plus the blade's live-flame width jitter ---
  const clock = new THREE.Clock();
  function animate() {
    requestAnimationFrame(animate);
    const delta = clock.getDelta();
    group.rotation.y += delta * 0.7;
    blade.scale.x = 1 + (Math.random() - 0.5) * 0.06;
    renderer.render(scene, camera);
  }
  animate();
}

init();

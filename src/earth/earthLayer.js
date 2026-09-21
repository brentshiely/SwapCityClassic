import * as THREE from 'three';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { TilesRenderer } from '3d-tiles-renderer/three';
import { RoadOverlay, OVERHEAD_FROM, BRIDGE_OVER_WATER } from './roadOverlay.js';
import { GoogleCloudAuthPlugin, GLTFExtensionsPlugin } from '3d-tiles-renderer/plugins';

// Google Earth mode: Google's Photorealistic 3D Tiles drawn LIVE under the game, from a camera straight above the car.
//
// Rules this file keeps (Google Map Tiles API policies, https://developers.google.com/maps/documentation/tile/policies):
//  - live streaming only: nothing is saved, and nothing (heights, outlines, measurements) is read or derived from the tiles;
//  - Google's logo and copyright text are shown whenever its tiles are showing (see attributions());
//  - only the tiles the camera can see are requested, at the detail its height needs (streaming, not a city download).
//
// The scene uses the game's own frame: x = screen right, z = screen down, y = height above the ground, so this camera and
// the game camera look at exactly the same place, with the same height (perspective.js) and the same 30 degree turn.

const GOOGLE_LOGO = 'https://www.gstatic.com/images/branding/googlelogo/svg/googlelogo_clr_74x24px.svg';
const DRACO_DECODERS = 'https://www.gstatic.com/draco/v1/decoders/';
const A = 6378137, F = 1 / 298.257223563, E2 = F * (2 - F); // WGS84

function ecef(latDeg, lonDeg, h) {
  const p = (latDeg * Math.PI) / 180, l = (lonDeg * Math.PI) / 180, s = Math.sin(p), N = A / Math.sqrt(1 - E2 * s * s);
  return new THREE.Vector3((N + h) * Math.cos(p) * Math.cos(l), (N + h) * Math.cos(p) * Math.sin(l), (N * (1 - E2) + h) * s);
}

/** ECEF -> game scene: the local east/north/up frame at the origin, turned by the map rotation, centred on the box */
function ecefToScene({ origin, rotationDegrees, boxCentreLocal, groundEllipsoidHeightM }) {
  const p = (origin.lat * Math.PI) / 180, l = (origin.lon * Math.PI) / 180, th = (rotationDegrees * Math.PI) / 180;
  const east = new THREE.Vector3(-Math.sin(l), Math.cos(l), 0);
  const north = new THREE.Vector3(-Math.sin(p) * Math.cos(l), -Math.sin(p) * Math.sin(l), Math.cos(p));
  const up = new THREE.Vector3(Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p));
  const rx = east.clone().multiplyScalar(Math.cos(th)).addScaledVector(north, -Math.sin(th)); // scene x
  const rz = east.clone().multiplyScalar(-Math.sin(th)).addScaledVector(north, -Math.cos(th)); // scene z
  const p0 = ecef(origin.lat, origin.lon, groundEllipsoidHeightM);
  const m = new THREE.Matrix4().set(
    rx.x, rx.y, rx.z, -rx.dot(p0) - boxCentreLocal.x,
    up.x, up.y, up.z, -up.dot(p0),
    rz.x, rz.y, rz.z, -rz.dot(p0) + boxCentreLocal.y,
    0, 0, 0, 1,
  );
  return m;
}

export class EarthLayer {
  /**
   * @param canvas the <canvas> this draws into (sits under the game's canvas)
   * @param topCanvas a 2D <canvas> above the game's canvas: it gets a copy of only the overhead parts of the picture
   * @param apiKey Google Maps Platform key with the Map Tiles API enabled
   * @param align the contents of data/earth_align.json
   * @param world the World (its roads, parks and sidewalks are drawn over Google's picture, tile by tile)
   * @param onState (state, detail) => void   state: 'loading' | 'ready' | 'failed'
   */
  constructor({ canvas, topCanvas, apiKey, align, world, onState }) {
    this.onState = onState;
    this.state = 'loading';
    this.canvas = canvas;
    this.topCanvas = topCanvas;
    this.topCtx = topCanvas.getContext('2d');
    this.terrain = world.terrain; // ground height under the camera and everywhere (null: flat)
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(1);
    this.renderer.setClearColor(0x14181a, 1);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(10, 1, 5, 4000);
    this.camera.up.set(0, 0, -1); // screen up is -z (the game's y is down)

    const draco = new DRACOLoader();
    draco.setDecoderPath(DRACO_DECODERS);
    const tiles = this.tiles = new TilesRenderer();
    tiles.registerPlugin(new GoogleCloudAuthPlugin({ apiToken: apiKey, autoRefreshToken: true, logoUrl: GOOGLE_LOGO }));
    tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader: draco }));
    tiles.group.matrixAutoUpdate = false;
    tiles.group.matrix.copy(ecefToScene(align));
    tiles.group.matrixWorldNeedsUpdate = true;
    tiles.setCamera(this.camera);
    this.scene.add(tiles.group);
    // our streets over Google's (covers the photographed cars; see roadOverlay.js)
    this.overlay = new RoadOverlay(world);
    this.patchGoogleMaterials(world);
    const lift = Number(new URLSearchParams(location.search).get('roadlift'));
    if (lift > 0) this.overlay.setLift(lift);
    this.scene.add(this.overlay.group);

    this.overhead = true;
    this.errors = 0;
    tiles.addEventListener('load-error', (e) => {
      this.errors++;
      // if the very first requests fail (no internet, bad key, over quota) give up and let the game use its offline look
      if (this.state === 'loading') this.fail(e?.error?.message ?? e?.message ?? 'tiles could not be loaded');
    });
    this.timeout = setTimeout(() => { if (this.state === 'loading') this.fail('no tiles arrived in 45 s'); }, 45000);
    this.onOffline = () => this.fail('the internet went away');
    addEventListener('offline', this.onOffline);
  }

  fail(reason) {
    if (this.state === 'failed') return;
    this.state = 'failed';
    console.warn('Google Earth mode unavailable, using the offline look:', reason);
    this.onState?.('failed', reason);
  }

  setOverheadFrom(y) { this.uniforms.uMinAbove.value = y; this.overheadFrom = y; }

  /**
   * Google's materials get a small shader addition, all in game/scene coordinates (x, z = game x, y; y = height above the ground at the origin):
   *  - uMinAbove: fragments less than that far above the LOCAL ground (the terrain model) are dropped. Pass 1 (what goes over the cars) sets it
   *    to a bit more than a truck's height; pass 2 sets it far below, so nothing is dropped.
   *  - the bridge mask: fragments more than a metre above the local ground inside the footprint of a bridge (OpenStreetMap's bridges are drawn
   *    by us, so Google's deck, rails and piers there are dropped).
   */
  patchGoogleMaterials(world) {
    const THREE_ = THREE, t = this.terrain;
    this.terrainTex = t ? t.texture(THREE_) : null;
    this.maskTex = new THREE.CanvasTexture(this.buildBridgeMask(world));
    this.maskTex.minFilter = this.maskTex.magFilter = THREE.LinearFilter;
    this.maskTex.flipY = false; // row 0 of the picture is the smallest game y, as in the shader's lookup
    const M = this.maskInfo;
    this.uniforms = {
      uMinAbove: { value: -1e6 },
      uTerrain: { value: this.terrainTex }, uTerrainOn: { value: t ? 1 : 0 },
      uTerrainOrigin: { value: new THREE.Vector2(t?.minX ?? 0, t?.minY ?? 0) },
      uTerrainInv: { value: new THREE.Vector2(t ? 1 / (t.w * t.cell) : 1, t ? 1 / (t.h * t.cell) : 1) },
      uTerrainCell: { value: new THREE.Vector2(t ? t.cell : 1, t ? t.cell : 1) },
      uMask: { value: this.maskTex }, uMaskOrigin: { value: new THREE.Vector2(M.x0, M.y0) }, uMaskInv: { value: new THREE.Vector2(1 / M.size, 1 / M.size) },
      uMaskAbove: { value: 1.0 },
    };
    const U = this.uniforms, dims = t ? new THREE.Vector2(t.w, t.h) : new THREE.Vector2(1, 1);
    const patch = (mat) => {
      if (!mat || mat.userData.gpatched) return;
      mat.userData.gpatched = true;
      const prev = mat.onBeforeCompile;
      mat.onBeforeCompile = (shader, renderer) => {
        prev?.call(mat, shader, renderer);
        Object.assign(shader.uniforms, U);
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nvarying vec3 vGWorld;')
          .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', `#include <common>
varying vec3 vGWorld;
uniform float uMinAbove; uniform sampler2D uTerrain; uniform float uTerrainOn; uniform vec2 uTerrainOrigin; uniform vec2 uTerrainInv; uniform vec2 uTerrainCell;
uniform sampler2D uMask; uniform vec2 uMaskOrigin; uniform vec2 uMaskInv; uniform float uMaskAbove;`)
          .replace('void main() {', `void main() {
  {
    vec2 tuv = (vGWorld.xz - uTerrainOrigin) * uTerrainInv + 0.5 * uTerrainCell * uTerrainInv;
    float ground = uTerrainOn > 0.5 ? texture2D(uTerrain, tuv).r : 0.0;
    float above = vGWorld.y - ground;
    if (above < uMinAbove) discard;
    vec2 muv = (vGWorld.xz - uMaskOrigin) * uMaskInv;
    if (muv.x >= 0.0 && muv.x <= 1.0 && muv.y >= 0.0 && muv.y <= 1.0 && above > uMaskAbove && texture2D(uMask, muv).r > 0.5) discard;
  }`);
      };
      mat.needsUpdate = true;
    };
    this.tiles.addEventListener('load-model', ({ scene }) => scene.traverse((o) => { if (o.isMesh) patch(o.material); }));
  }

  /** a black-and-white picture of where bridges are (a bit wider than the deck), over the area Google mode covers: 2.5 m per pixel */
  buildBridgeMask(world) {
    const size = 3900, px = 2.5, n = Math.ceil(size / px), c = document.createElement('canvas');
    c.width = c.height = n;
    const g = c.getContext('2d'), x0 = -size / 2, y0 = -size / 2;
    this.maskInfo = { x0, y0, size };
    g.fillStyle = '#000'; g.fillRect(0, 0, n, n);
    g.strokeStyle = '#fff'; g.lineCap = 'butt'; g.lineJoin = 'round';
    g.setTransform(1 / px, 0, 0, 1 / px, -x0 / px, -y0 / px);
    for (const r of world.roads) {
      if (r.layer < 1 || r.layer > 3 || Math.abs(r.points[0][0]) > size / 2 || Math.abs(r.points[0][1]) > size / 2) continue;
      // over water the whole bridge goes (it carries sidewalks and other lanes we do not draw); on land only a little wider than the road,
      // so buildings and trees beside a bridge's ends stay
      for (let i = 0; i < r.points.length - 1; i++) {
        const a = r.points[i], b = r.points[i + 1], len = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.ceil(len / 3));
        for (let k = 0; k < n; k++) {
          const t0 = k / n, t1 = (k + 1) / n, mx = a[0] + (b[0] - a[0]) * (t0 + t1) / 2, my = a[1] + (b[1] - a[1]) * (t0 + t1) / 2;
          g.lineWidth = r.width + (world.inWater(mx, my) ? BRIDGE_OVER_WATER : 4.5);
          g.beginPath(); g.moveTo(a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0); g.lineTo(a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1); g.stroke();
        }
      }
    }
    return c;
  }
  setStreetsOver(on) { this.overlay.group.visible = on; }
  /** draw the overhead parts of the picture above the cars (on), or leave everything under them (off) */
  setOverhead(on) { this.overhead = on; if (!on) this.topCtx.clearRect(0, 0, this.w ?? 0, this.h ?? 0); }

  resize(w, h) {
    if (this.w === w && this.h === h) return;
    this.w = w; this.h = h;
    this.renderer.setSize(w, h, false);
    this.topCanvas.width = w; this.topCanvas.height = h;
    this.camera.aspect = w / h;
  }

  /**
   * Call every frame with the game camera. camX/camY: where it looks (game metres); H: camera height above the ground (m);
   * zoom: game pixels per metre at the ground. The field of view follows so the picture matches the game's scale.
   */
  update(camX, camY, H, zoom, w, h) {
    if (this.state === 'failed') return;
    this.resize(w, h);
    const cam = this.camera;
    cam.fov = (2 * Math.atan(h / (2 * H * zoom)) * 180) / Math.PI; // pixels per metre at the ground = h / (2 H tan(fov/2))
    cam.near = Math.max(2, H * 0.05); cam.far = H * 3 + 1500;
    // the ground under the middle of the screen may be well below the game origin's ground (the river valley): the camera is H above THAT
    const t0 = this.terrain ? this.terrain.height(camX, camY) : 0;
    cam.position.set(camX, H + t0, camY);
    cam.lookAt(camX, t0, camY);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    this.overlay.sync();
    this.overlay.update(camX, camY, H);
    this.tiles.setResolutionFromRenderer(cam, this.renderer);
    this.tiles.update();
    const r = this.renderer, overlayShown = this.overlay.group.visible;
    if (this.overhead) {
      // pass 1: only what is higher than a truck, on a see-through background, copied to the canvas above the game
      this.overlay.group.visible = false;
      this.uniforms.uMinAbove.value = this.overheadFrom ?? OVERHEAD_FROM;
      r.setClearColor(0x000000, 0);
      r.render(this.scene, cam);
      this.topCtx.clearRect(0, 0, w, h);
      this.topCtx.drawImage(r.domElement, 0, 0, w, h);
      this.uniforms.uMinAbove.value = -1e6;
      r.setClearColor(0x14181a, 1);
      this.overlay.group.visible = overlayShown;
    }
    // pass 2: the whole picture with our ground over it, under the game
    r.render(this.scene, cam);
    if (this.state === 'loading' && this.tiles.visibleTiles.size > 0) {
      this.state = 'ready';
      clearTimeout(this.timeout);
      this.onState?.('ready');
    }
  }

  /** Google's logo and copyright text, to show while its tiles are on screen: [{ type: 'image' | 'string', value }] */
  attributions() {
    const out = [];
    try { this.tiles.getAttributions(out); } catch { /* none yet */ }
    return out;
  }

  dispose() {
    clearTimeout(this.timeout);
    removeEventListener('offline', this.onOffline);
    this.tiles.dispose();
    this.renderer.dispose();
  }
}

import * as THREE from 'three';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { TilesRenderer } from '3d-tiles-renderer/three';
import { buildRoadOverlay } from './roadOverlay.js';
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
   * @param apiKey Google Maps Platform key with the Map Tiles API enabled
   * @param align the contents of data/earth_align.json
   * @param map the game's map (its streets are drawn over Google's picture)
   * @param onState (state, detail) => void   state: 'loading' | 'ready' | 'failed'
   */
  constructor({ canvas, apiKey, align, map, onState }) {
    this.onState = onState;
    this.state = 'loading';
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance' });
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
    this.overlay = buildRoadOverlay(map);
    const lift = Number(new URLSearchParams(location.search).get('roadlift'));
    if (lift > 0) this.overlay.setLift(lift);
    this.scene.add(this.overlay.group);

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

  setStreetsOver(on) { this.overlay.group.visible = on; }

  resize(w, h) {
    if (this.w === w && this.h === h) return;
    this.w = w; this.h = h;
    this.renderer.setSize(w, h, false);
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
    cam.position.set(camX, H, camY);
    cam.lookAt(camX, 0, camY);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    this.overlay.update(camX, camY, H);
    this.tiles.setResolutionFromRenderer(cam, this.renderer);
    this.tiles.update();
    this.renderer.render(this.scene, cam);
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

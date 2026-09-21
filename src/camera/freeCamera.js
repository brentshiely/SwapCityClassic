import Phaser from 'phaser';

// Mac-trackpad camera for looking around the map: two-finger scroll pans, pinch zooms
// (a pinch arrives as a wheel event with ctrlKey set), + / - zoom, 0 refits, arrows pan,
// click-drag pans. `onKey(ev)` runs first for scene-specific keys.
export function attachFreeCamera(scene, { fitZoom, minZoom = fitZoom * 0.6, maxZoom = 40, home = [0, 0], onKey } = {}) {
  const cam = scene.cameras.main;

  const zoomAt = (px, py, factor) => {
    const w = cam.width, h = cam.height, z1 = cam.zoom;
    const z2 = Phaser.Math.Clamp(z1 * factor, minZoom, maxZoom);
    // keep the world point under (px, py) fixed on screen
    const wx = cam.scrollX + w / 2 - w / (2 * z1) + px / z1;
    const wy = cam.scrollY + h / 2 - h / (2 * z1) + py / z1;
    cam.setZoom(z2);
    cam.scrollX = wx - px / z2 - w / 2 + w / (2 * z2);
    cam.scrollY = wy - py / z2 - h / 2 + h / (2 * z2);
  };

  scene.input.on('wheel', (p, _o, dx, dy) => {
    if (p.event.ctrlKey) zoomAt(p.x, p.y, Math.exp(-dy * 0.01));
    else { cam.scrollX += dx / cam.zoom; cam.scrollY += dy / cam.zoom; }
  });
  scene.input.on('pointermove', (p) => {
    if (!p.isDown) return;
    cam.scrollX -= (p.x - p.prevPosition.x) / cam.zoom;
    cam.scrollY -= (p.y - p.prevPosition.y) / cam.zoom;
  });
  scene.input.keyboard.on('keydown', (ev) => {
    if (onKey?.(ev)) return;
    const cx = cam.width / 2, cy = cam.height / 2, step = 40 / cam.zoom;
    if (ev.key === '=' || ev.key === '+') zoomAt(cx, cy, 1.25);
    else if (ev.key === '-' || ev.key === '_') zoomAt(cx, cy, 0.8);
    else if (ev.key === '0') { cam.setZoom(fitZoom); cam.centerOn(home[0], home[1]); }
    else if (ev.key === 'ArrowLeft') cam.scrollX -= step;
    else if (ev.key === 'ArrowRight') cam.scrollX += step;
    else if (ev.key === 'ArrowUp') cam.scrollY -= step;
    else if (ev.key === 'ArrowDown') cam.scrollY += step;
  });
  return { zoomAt };
}

/** Parse #x=..&y=..&z=.. so a test can open the game at a chosen spot. */
export const startFromHash = () => Object.fromEntries(new URLSearchParams(location.hash.slice(1)));

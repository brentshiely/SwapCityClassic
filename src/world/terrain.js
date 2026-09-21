// The height of the ground above the ground at the game origin (metres), from the LiDAR ground model (tools/bake_terrain.py). Google's picture
// is on real terrain: the Mississippi valley is ~35 m below downtown's plateau, so Google mode needs to know it (where the camera is really
// above the ground, how high a bridge deck is, what counts as "above street level"). Outside the grid the ground is taken as height 0.
export class Terrain {
  constructor(t) {
    this.minX = t.minX; this.minY = t.minY; this.cell = t.cell; this.w = t.w; this.h = t.h;
    this.dm = Int16Array.from(t.dm);
  }

  /** is there data at (x, y)? */
  has(x, y) {
    const i = Math.round((x - this.minX) / this.cell), j = Math.round((y - this.minY) / this.cell);
    return i >= 0 && j >= 0 && i < this.w && j < this.h && this.dm[j * this.w + i] !== -32768;
  }

  height(x, y) {
    const fx = (x - this.minX) / this.cell, fy = (y - this.minY) / this.cell;
    const i = Math.floor(fx), j = Math.floor(fy);
    if (i < 0 || j < 0 || i >= this.w - 1 || j >= this.h - 1) return 0;
    const a = this.dm[j * this.w + i], b = this.dm[j * this.w + i + 1], c = this.dm[(j + 1) * this.w + i], d = this.dm[(j + 1) * this.w + i + 1];
    if (a === -32768 || b === -32768 || c === -32768 || d === -32768) return 0;
    const u = fx - i, v = fy - j;
    return ((a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v) / 10;
  }

  /** the grid as a float texture for shaders: R = height in metres (no data = 0) */
  texture(THREE) {
    const data = new Float32Array(this.w * this.h);
    for (let k = 0; k < data.length; k++) data[k] = this.dm[k] === -32768 ? 0 : this.dm[k] / 10;
    const t = new THREE.DataTexture(data, this.w, this.h, THREE.RedFormat, THREE.FloatType);
    t.minFilter = t.magFilter = THREE.LinearFilter;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.needsUpdate = true;
    return t;
  }
}

import align from '../../data/earth_align.json';

// Decides which look the game shows: Google Earth (live 3D tiles, see earthLayer.js) or the offline look (our painted
// streets and LiDAR-height buildings). Auto uses Google whenever the internet is up. Anything going wrong drops back to the
// offline look. The offline look is never removed, only hidden, so the fall back is instant.
//
// Cost guard: Google bills per SESSION (one root request covers at least 3 hours of tiles), not per tile or per area. No mode
// (Auto, the G key, ?look=google, a retry) opens more than LIMIT_PER_DAY sessions in a day in this browser, so reload loops
// cannot eat the allowance; a session that runs past SESSION_MINUTES is counted again because the token is renewed then.
// This matches the 40/day quota set on the key in Google Cloud, which is the real limit.
// Switching looks with G does not open a new session: the Google layer is kept and only paused.

const KEY = typeof __GOOGLE_KEY__ === 'string' ? __GOOGLE_KEY__ : '';
const LIMIT_PER_DAY = 40;
// Google's picture is only lined up with our map (ground height, the flat ground the overlay and the overhead pass assume) near downtown.
// Farther out the ground is higher or lower and the earth curves away, so past this distance the offline look is used.
const GOOGLE_RADIUS = 1800;
const SESSION_MINUTES = 170; // Google's session token lasts at least 3 hours; the layer renews it, which is a new billed session
const RETRY_MS = 45000; // after a failed launch, try again this often while the internet looks up...
const MAX_RETRIES = 6; // ...this many times (the internet coming back, the 'online' event, starts the count again)
const COUNT_KEY = 'swapcityclassic.google.sessions.v1';

const sessionsToday = () => {
  try { const o = JSON.parse(localStorage.getItem(COUNT_KEY) ?? 'null'); return o?.day === new Date().toDateString() ? o.n : 0; } catch { return 0; }
};
const countSession = () => {
  try { localStorage.setItem(COUNT_KEY, JSON.stringify({ day: new Date().toDateString(), n: sessionsToday() + 1 })); } catch { /* not remembered: fine */ }
};

export class LookController {
  /**
   * @param scene the Phaser scene (its camera background is made see-through when Google is showing)
   * @param images the ground streamer (hidden while Google shows)
   * @param buildingLayer the buildings' Graphics object (hidden while Google shows)
   * @param getLook () => 'auto' | 'google' | 'offline' (the saved setting)
   * @param getOverhead () => 'on' | 'off': Google's overhead parts drawn above the cars
   * @param getStreets () => 'on' | 'off': our streets over Google's picture
   * @param map the game map
   * @param hideInGoogle extra Graphics layers hidden while Google shows
   * @param urlLook 'auto' | 'google' | 'offline' | null (the address bar wins)
   * @param setLook (value) => void, used by the G key
   */
  constructor({ scene, images, buildingLayer, getLook, getStreets, getOverhead, map, world, hideInGoogle = [], urlLook, setLook }) {
    Object.assign(this, { scene, images, buildingLayer, world, getLook, getStreets, getOverhead, map, hideInGoogle, urlLook, setLook });
    this.canvas = document.getElementById('earth');
    this.topCanvas = document.getElementById('earth-top');
    this.attrib = document.getElementById('earth-attrib');
    this.lastSetting = getLook(); // when the setting changes (T panel or the G key), that beats the address bar
    this.earth = null; this.loading = false; this.failed = ''; this.failedAt = 0; this.retries = 0; this.shown = false; this.reason = ''; this.frame = 0;
    // the internet coming back is the moment to try Google again
    addEventListener('online', () => { this.retries = 0; this.failedAt = -Infinity; });
    addEventListener('keydown', (e) => {
      if (e.code !== 'KeyG' || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      this.urlLook = null; // pressing G always beats the address bar
      this.setLook(this.shown ? 'offline' : 'google');
    });
    this.setShown(false);
  }

  preference() {
    const now = this.getLook();
    if (now !== this.lastSetting) { this.lastSetting = now; this.urlLook = null; }
    return ['auto', 'google', 'offline'].includes(this.urlLook) ? this.urlLook : now;
  }

  /** should Google be running right now? (also records why not, for the on-screen label) */
  wanted() {
    if (!KEY) { this.reason = ''; return false; } // this build has no Google mode at all: same as picking "Offline" for good, not a failure worth naming
    if (this.far) { this.reason = 'Google Earth is only lined up over downtown'; return false; }
    if (this.failed) {
      // a failed launch is not forever: flight wifi comes and goes. Try again later (Auto and Google, never when Offline is chosen).
      const retry = this.preference() !== 'offline' && navigator.onLine && this.retries < MAX_RETRIES && performance.now() - this.failedAt >= RETRY_MS
        && sessionsToday() < LIMIT_PER_DAY;
      if (!retry) { this.reason = this.failed; return false; }
      this.retries++; this.failed = ''; this.loading = false;
    }
    const p = this.preference();
    if (p === 'offline') { this.reason = ''; return false; }
    if (!this.earth && sessionsToday() >= LIMIT_PER_DAY) { this.reason = `${LIMIT_PER_DAY} Google launches today`; return false; }
    if (p === 'google') { this.reason = ''; return true; }
    if (!navigator.onLine) { this.reason = 'no internet'; return false; }
    this.reason = '';
    return true;
  }

  start() {
    if (this.earth || this.loading) return;
    if (sessionsToday() >= LIMIT_PER_DAY) return; // the last line of defence: nothing opens a 41st session
    this.loading = true;
    this.startedAt = performance.now();
    countSession();
    import('./earthLayer.js').then(({ EarthLayer }) => {
      this.earth = new EarthLayer({ canvas: this.canvas, topCanvas: this.topCanvas, apiKey: KEY, align, world: this.world, onState: (state, detail) => { if (state === 'failed') this.fail(detail); } });
    }).catch((err) => this.fail(err?.message ?? 'could not start'));
  }

  fail(reason) {
    this.failed = String(reason).slice(0, 60);
    this.failedAt = performance.now();
    this.loading = false;
    try { this.earth?.dispose(); } catch { /* already gone */ }
    this.earth = null;
    this.setShown(false);
  }

  /** call every frame with the game's camera: where it looks (game metres), camera height (m), pixels per metre, screen size */
  update(camX, camY, H, zoom, w, h, playerZ = 0) {
    // Google mode only where the ground height is known (the LiDAR terrain grid covers downtown) or, without it, near downtown
    const t = this.world?.terrain;
    this.far = t ? !t.has(camX, camY) : Math.hypot(camX, camY) > GOOGLE_RADIUS * (this.far ? 0.92 : 1);
    const want = this.wanted();
    if (want) this.start();
    if (this.earth && performance.now() - this.startedAt > SESSION_MINUTES * 60000) { this.startedAt = performance.now(); countSession(); } // token renewal
    const overhead = this.getOverhead() !== 'off';
    if (want && this.earth) { this.earth.setStreetsOver(this.getStreets() !== 'off'); this.earth.setOverhead(overhead); this.earth.setOverheadFrom(3.7 + playerZ); } // on a bridge the deck itself is under the car: only what is above the deck goes over it
    if (want && this.earth) this.earth.update(camX, camY, H, zoom, w, h);
    const show = !!(want && this.earth && this.earth.state === 'ready');
    if (show !== this.shown) this.setShown(show);
    // in Google's picture the real skyway is drawn above the cars, so our own skyway blocks step aside (unless overhead is off)
    for (const l of this.hideInGoogle) l.setVisible(!(show && overhead));
    if (show && ++this.frame % 30 === 0) this.refreshAttribution();
  }

  setShown(show) {
    this.shown = show;
    this.images.setVisible(!show); // the ground streamer
    this.buildingLayer.setVisible(!show);
    this.canvas.style.display = show ? 'block' : 'none';
    this.topCanvas.style.display = show ? 'block' : 'none';
    this.attrib.style.display = show ? 'flex' : 'none';
    this.scene.cameras.main.setBackgroundColor(show ? 'rgba(0,0,0,0)' : 0x14181a); // see the Google canvas through the game's
    if (show) this.refreshAttribution();
  }

  /** Google's logo and copyright text, exactly as the tiles report them */
  refreshAttribution() {
    const items = this.earth ? this.earth.attributions() : [];
    const key = JSON.stringify(items.map((a) => [a.type, a.value]));
    if (key === this.lastAttr) return;
    this.lastAttr = key;
    this.attrib.textContent = '';
    for (const a of items) {
      if (a.type === 'image') { const i = document.createElement('img'); i.src = a.value; i.alt = 'Google'; this.attrib.appendChild(i); }
      else if (a.value) { const s = document.createElement('span'); s.textContent = String(a.value).replace(/<[^>]*>/g, '').slice(0, 220); this.attrib.appendChild(s); }
    }
  }

  get label() {
    if (this.shown) return `look: Google Earth (${sessionsToday()}/${LIMIT_PER_DAY} today)`;
    return this.reason ? `look: offline (${this.reason})` : this.loading && !this.failed && this.preference() !== 'offline' ? 'look: offline (loading Google Earth...)' : 'look: offline';
  }
}

import { SPEC, DEFAULTS, CAMERA_PRESETS } from '../settings.js';

// A small live-settings panel: press T to show or hide it. Sliders change the game immediately.
export class TuningPanel {
  constructor(settings, onChange) {
    this.settings = settings;
    this.onChange = onChange;
    this.rows = {};
    const root = this.root = document.createElement('div');
    root.id = 'tune';
    root.hidden = true;
    root.innerHTML = `<h3>Settings <small>T to close</small></h3>`;
    // Live performance/scene stats: kept here (out of the way) rather than always on screen, where they used to run into
    // the OSM attribution in the corner and read as an error message ("look: offline") to a non-technical player.
    this.debugEl = document.createElement('pre');
    this.debugEl.id = 'tune-debug';
    this.debugEl.style.cssText = 'margin: 0 0 10px; white-space: pre-wrap; color: #8a959c; font-size: 11px; line-height: 1.4;';
    root.appendChild(this.debugEl);
    for (const g of SPEC) {
      const h = document.createElement('h4'); h.textContent = g.group; root.appendChild(h);
      if (g.group === 'Camera') root.appendChild(this.presetRow());
      for (const it of g.items) root.appendChild(this.row(it));
    }
    const foot = document.createElement('div'); foot.className = 'foot';
    const reset = document.createElement('button'); reset.textContent = 'Reset all'; reset.onclick = () => this.set({ ...DEFAULTS });
    const copy = document.createElement('button'); copy.textContent = 'Copy settings';
    this.box = document.createElement('textarea'); this.box.readOnly = true; this.box.rows = 3;
    copy.onclick = () => { this.box.select(); try { navigator.clipboard?.writeText(this.box.value); } catch { /* the text is selected, copy by hand */ } };
    foot.append(reset, copy);
    root.append(foot, this.box);
    document.body.appendChild(root);
    this.refresh();
    // T toggles the panel (not while typing in a field)
    window.addEventListener('keydown', (e) => { if (e.code === 'KeyT' && !(e.target instanceof HTMLTextAreaElement)) this.toggle(); });
  }

  presetRow() {
    const d = document.createElement('div'); d.className = 'presets';
    for (const [name, values] of Object.entries(CAMERA_PRESETS)) {
      const b = document.createElement('button'); b.textContent = name; b.onclick = () => this.set({ ...this.settings, ...values });
      d.appendChild(b);
    }
    return d;
  }

  choiceRow(it) {
    const d = document.createElement('label'); d.className = 'row';
    const name = document.createElement('span'); name.textContent = it.label;
    const sel = document.createElement('select'); sel.id = `tune-${it.key}`;
    for (const [v, text] of it.options) { const o = document.createElement('option'); o.value = v; o.textContent = text; sel.appendChild(o); }
    sel.onchange = () => { this.settings[it.key] = sel.value; this.changed(); sel.blur(); };
    const hint = document.createElement('small'); hint.textContent = it.hint;
    d.append(name, sel, hint);
    this.rows[it.key] = { input: sel, val: null, it };
    return d;
  }

  row(it) {
    if (it.type === 'choice') return this.choiceRow(it);
    const d = document.createElement('label'); d.className = 'row';
    const top = document.createElement('span'); top.className = 'top';
    const name = document.createElement('span'); name.textContent = it.label;
    const val = document.createElement('b');
    top.append(name, val);
    const input = document.createElement('input');
    input.type = 'range'; input.min = it.min; input.max = it.max; input.step = it.step; input.id = `tune-${it.key}`;
    input.oninput = () => { this.settings[it.key] = Number(input.value); this.changed(); };
    input.onchange = () => input.blur(); // keep the arrow keys for driving
    const hint = document.createElement('small'); hint.textContent = it.hint;
    d.append(top, input, hint);
    this.rows[it.key] = { input, val, it };
    return d;
  }

  set(values) { Object.assign(this.settings, values); this.changed(); }
  changed() { this.refresh(); this.onChange(this.settings); }

  refresh() {
    for (const { input, val, it } of Object.values(this.rows)) {
      input.value = this.settings[it.key];
      if (!val) continue;
      const dp = it.step < 0.01 ? 4 : it.step < 1 ? 2 : 0;
      val.textContent = `${Number(this.settings[it.key]).toFixed(dp)} ${it.unit}`.trim();
    }
    this.box.value = JSON.stringify(this.settings);
  }

  toggle() { this.root.hidden = !this.root.hidden; }
  show() { this.root.hidden = false; }
  setDebug(text) { if (!this.root.hidden) this.debugEl.textContent = text; }
}

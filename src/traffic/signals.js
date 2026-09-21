import { headingsMod } from './signalAxis.js';

// Timed traffic lights at the junctions OpenStreetMap marks as signalized. Each junction alternates
// between two axes (streets running one way, then the ones crossing them):
// green, yellow, then a short all-red before the other axis goes. Junctions are offset from each
// other so the whole map is not in step.
export const CYCLE = { green: 9, yellow: 2, allRed: 1.5 };
const PHASE = CYCLE.green + CYCLE.yellow + CYCLE.allRed;

export class Signals {
  constructor(net) {
    this.byNode = new Map();
    for (const n of net.nodes) {
      if (!n.signal || n.degree < 3) continue;
      const incoming = net.directed.filter((de) => de.to === n.id);
      if (!incoming.length) continue;
      const ref = net.headingAtEnd(incoming[0]);
      for (const de of incoming) {
        const d = headingsMod(net.headingAtEnd(de), ref);
        de.signal = { node: n.id, axis: d < Math.PI / 4 ? 0 : 1 };
      }
      this.byNode.set(n.id, { node: n, offset: (n.id * 7.3) % (PHASE * 2), approaches: incoming });
    }
  }

  /** seconds into this approach's window of the cycle: green from 0, yellow next, then red until it wraps at 25 */
  local(de, t) {
    const s = this.byNode.get(de.signal.node);
    const total = PHASE * 2;
    return ((((t + s.offset) - de.signal.axis * PHASE) % total) + total) % total;
  }

  /** 'green' | 'yellow' | 'red' for a directed segment that ends at a signalized junction */
  state(de, t) {
    const local = this.local(de, t);
    return local < CYCLE.green ? 'green' : local < CYCLE.green + CYCLE.yellow ? 'yellow' : 'red';
  }
}

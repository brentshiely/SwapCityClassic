import { headingsMod } from './signalAxis.js';

// Timed traffic lights at the junctions OpenStreetMap marks as signalized. Each junction alternates
// between two axes (streets running one way, then the ones crossing them):
// green, yellow, then a short all-red before the other axis goes. Junctions are offset from each
// other so the whole map is not in step. Pedestrians read the same clock (see peds/).
export const CYCLE = { green: 9, yellow: 2, allRed: 1.5 };
export const PHASE = CYCLE.green + CYCLE.yellow + CYCLE.allRed;
const TOTAL = PHASE * 2;

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
      this.byNode.set(n.id, { node: n, ref, offset: (n.id * 7.3) % TOTAL, approaches: incoming });
    }
  }

  /** which of the junction's two axes a street with this heading belongs to */
  axisOfHeading(nodeId, heading) {
    return headingsMod(heading, this.byNode.get(nodeId).ref) < Math.PI / 4 ? 0 : 1;
  }

  /** seconds into an axis's window of the cycle: green from 0, yellow next, then red until it wraps at 25 */
  localAxis(nodeId, axis, t) {
    const s = this.byNode.get(nodeId);
    return ((((t + s.offset) - axis * PHASE) % TOTAL) + TOTAL) % TOTAL;
  }

  local(de, t) { return this.localAxis(de.signal.node, de.signal.axis, t); }

  /** 'green' | 'yellow' | 'red' for a directed segment that ends at a signalized junction */
  state(de, t) {
    const local = this.local(de, t);
    return local < CYCLE.green ? 'green' : local < CYCLE.green + CYCLE.yellow ? 'yellow' : 'red';
  }
}

// Shared world counters (server/stats.py behind /api): every page reports what
// happened since its last report and gets everyone's all-time totals back.
// The visitor id is random and lives in localStorage; nothing else identifies you.

const HIT = '/api/hit';
const EVERY = 15; // seconds between reports while the tab is visible
const SIM_KEYS = ['born', 'shattered', 'generations'];

function visitorId() {
  try {
    let id = localStorage.getItem('life3d-id');
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem('life3d-id', id);
    }
    return id;
  } catch {
    return crypto.randomUUID(); // storage blocked: counts as a new visitor each load
  }
}

export class WorldStats {
  constructor(sim) {
    this.sim = sim;
    this.id = visitorId();
    this.pending = { pillar: 0, meteor: 0, blast: 0, sow: 0 };
    this.reported = Object.fromEntries(SIM_KEYS.map((k) => [k, 0])); // sim.stats values already sent
    this.visitSent = false;
    this.totals = null;
    this.clock = EVERY; // report right away
    this.inflight = false;
    addEventListener('pagehide', () => this.beacon(true));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.beacon(false);
    });
  }

  // A visitor did something (tool use).
  count(key) {
    this.pending[key]++;
  }

  // Everything not reported yet: tool uses plus growth of the sim's own counters.
  unsent() {
    const events = { ...this.pending };
    for (const k of SIM_KEYS) events[k] = this.sim.stats[k] - this.reported[k];
    return events;
  }

  markSent(events) {
    for (const k of Object.keys(this.pending)) this.pending[k] -= events[k];
    for (const k of SIM_KEYS) this.reported[k] += events[k];
  }

  // Totals as this visitor should see them: server totals plus what is still queued here.
  view() {
    if (!this.totals) return null;
    const events = this.unsent();
    const out = { ...this.totals };
    for (const [k, v] of Object.entries(events)) out[k] = (out[k] ?? 0) + v;
    return out;
  }

  update(dt) {
    this.clock += dt;
    if (this.clock < EVERY || this.inflight) return;
    this.clock = 0;
    this.report();
  }

  async report() {
    const events = this.unsent();
    const visit = !this.visitSent;
    this.inflight = true;
    try {
      const res = await fetch(HIT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: this.id, visit, events }),
      });
      if (!res.ok) return;
      this.totals = await res.json();
      this.markSent(events);
      this.visitSent = true;
    } catch {
      // offline or no API (local dev): the card stays hidden, counts stay queued
    } finally {
      this.inflight = false;
    }
  }

  // Last report on the way out; sendBeacon survives the page closing.
  beacon(leave) {
    if (!this.visitSent) return;
    const events = this.unsent();
    const body = JSON.stringify({ id: this.id, leave, events });
    if (navigator.sendBeacon?.(HIT, body)) this.markSent(events);
  }
}

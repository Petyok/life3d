// Headless run of the real Sim (CA + Rapier) per rule preset.
// usage: node tools/tune.mjs [seconds=60] [rule ids or "s/b/c/M" ...] [--key=value ...]
import { initPhysics, Sim } from '../src/sim/sim.js';
import { PRESETS } from '../src/sim/rules.js';

const args = process.argv.slice(2);
const opts = {};
const rest = [];
for (const a of args) {
  const m = /^--(\w+)=(.*)$/.exec(a);
  if (m) opts[m[1]] = m[2] === 'false' ? false : m[2] === 'true' ? true : Number.isNaN(Number(m[2])) ? m[2] : Number(m[2]);
  else rest.push(a);
}
const seconds = rest.length && /^\d+$/.test(rest[0]) ? Number(rest.shift()) : 60;
const rules = rest.length ? rest : PRESETS.map((p) => p.id);

await initPhysics();
for (const rule of rules) {
  const sim = new Sim({ rule, ...opts });
  sim.reset(opts.density);
  const rows = [];
  let worst = 0;
  let windowMs = 0;
  let births = 0;
  let lastGen = 0;
  const t0 = performance.now();
  const frames = Math.round(seconds * 60);
  for (let f = 0; f < frames; f++) {
    const a = performance.now();
    sim.update(1 / 60);
    const ms = performance.now() - a;
    worst = Math.max(worst, ms);
    windowMs += ms;
    if (sim.gen !== lastGen) {
      births += sim.grid.nBirths;
      lastGen = sim.gen;
    }
    if (f % 600 === 599) {
      const g = sim.grid;
      let solid = 0;
      let maxY = 0;
      for (let i = 0; i < g.N; i++)
        if (g.state[i]) {
          solid++;
          maxY = Math.max(maxY, (i / g.L) | 0);
        }
      const s = sim.stats;
      rows.push(
        `t=${String(Math.round(sim.time)).padStart(3)} live=${String(g.population()).padStart(5)} solid=${String(solid).padStart(5)} top=${String(maxY).padStart(2)} births/10s=${String(births).padStart(5)} dyn=${String(sim.nDynamic).padStart(4)}/${String(sim.bodies.length).padStart(3)}b rel=${s.released} drop=${s.dropped} shat=${s.shattered} knock=${s.knocked} snap=${s.snapped} lost=${s.lost} ${(windowMs / 600).toFixed(1)}ms/f`,
      );
      windowMs = 0;
      births = 0;
    }
  }
  const wall = performance.now() - t0;
  console.log(`\n== ${rule} (${sim.rule.text})  ${(wall / frames).toFixed(2)} ms/frame avg, worst ${worst.toFixed(1)} ms`);
  console.log(`   last ms: ca ${sim.timing.ca.toFixed(2)} support ${sim.timing.support.toFixed(2)} voxels ${sim.timing.voxels.toFixed(2)} physics ${sim.timing.physics.toFixed(2)}`);
  for (const r of rows) console.log('  ', r);
  sim.world.free();
}

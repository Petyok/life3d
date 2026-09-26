// Throwaway survey: CA without gravity, population over generations per rule/density.
import { Grid } from '../src/sim/grid.js';
import { PRESETS, parseRule } from '../src/sim/rules.js';
import { mulberry32 } from '../src/sim/sim.js';

const rules = process.argv.slice(2).length ? process.argv.slice(2) : PRESETS.map((p) => p.id);
for (const id of rules) {
  const p = PRESETS.find((q) => q.id === id);
  const rule = parseRule(p ? p.rule : id);
  const out = [];
  for (const d of [0.1, 0.2, 0.3, 0.45, 0.6]) {
    const g = new Grid(48, 32, 48);
    const rng = mulberry32(7);
    for (let y = 10; y < 22; y++) for (let z = 18; z < 30; z++) for (let x = 18; x < 30; x++) if (rng() < d) g.state[g.index(x, y, z)] = 1;
    const pops = [];
    for (let k = 0; k <= 120; k++) {
      if (k % 20 === 0) pops.push(g.population());
      g.step(rule);
    }
    out.push(`d=${d}: ${pops.join(' ')}`);
  }
  console.log(`${id} ${rule.text}\n  ${out.join('\n  ')}`);
}

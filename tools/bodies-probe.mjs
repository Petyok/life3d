// Throwaway: what are the live rigid bodies doing? (age, speed, size)
import { initPhysics, Sim } from '../src/sim/sim.js';
await initPhysics();
const sim = new Sim({ rule: process.argv[2] || 'pyro', seed: 1 });
sim.reset();
for (let f = 0; f < 60 * 20; f++) sim.update(1 / 60);
const rows = sim.bodies.map((b) => {
  const v = b.rb.linvel();
  const w = b.rb.angvel();
  return { n: b.n, life: b.life, low: b.low, v2: v.x * v.x + v.y * v.y + v.z * v.z, w2: w.x * w.x + w.y * w.y + w.z * w.z, y: b.rb.translation().y };
});
const hist = (key, edges) => edges.map((e, i) => `${key}<${e}:${rows.filter((r) => r[key] < e && (i === 0 || r[key] >= edges[i - 1])).length}`).join(' ');
console.log('bodies', rows.length, 'cubes', sim.nDynamic);
console.log(hist('life', [0.5, 1, 2, 4, 8, 15]));
console.log(hist('v2', [0.08, 0.5, 2, 10, 1000]));
console.log(hist('w2', [0.04, 0.2, 1, 5, 1000]));
console.log(hist('n', [2, 3, 5, 10, 200]));
console.log('slow-lin but spinning', rows.filter((r) => r.v2 < 0.08 && r.w2 >= 0.04).length, ' fast', rows.filter((r) => r.v2 >= 2).length);

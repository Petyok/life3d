import './style.css';
import { initPhysics, Sim } from './sim/sim.js';
import { PRESETS } from './sim/rules.js';
import { Renderer } from './render/renderer.js';
import { UI } from './ui.js';

await initPhysics();

// ?rule=<preset id or s/b/c/M>&seed=<n>
const q = new URLSearchParams(location.search);
const opts = {};
if (q.get('rule')) opts.rule = q.get('rule');
if (q.get('seed')) opts.seed = Number(q.get('seed')) || 1;
else opts.seed = (Math.random() * 2 ** 31) | 0;

let sim;
try {
  sim = new Sim(opts);
} catch {
  sim = new Sim({ ...opts, rule: PRESETS[0].id });
}
sim.reset();

const view = new Renderer(document.getElementById('view'), sim);
// 30 fps cap by default keeps small laptops cool; G toggles it.
const loop = { cap30: true, simMs: 0, renderMs: 0 };
const ui = new UI(sim, view, loop);
document.getElementById('loading').classList.add('gone');

let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = (now - last) / 1000;
  if (loop.cap30 && dt < 1 / 30 - 0.004) return;
  last = now;
  const t0 = performance.now();
  sim.update(dt);
  const t1 = performance.now();
  view.render();
  const t2 = performance.now();
  loop.simMs += (t1 - t0 - loop.simMs) * 0.1;
  loop.renderMs += (t2 - t1 - loop.renderMs) * 0.1;
  ui.update(dt);
}
requestAnimationFrame(frame);

window.__life = { sim, view, ui, loop };

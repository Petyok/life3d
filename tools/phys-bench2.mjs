// Throwaway: static collision for ~8000 lattice cells + ~300 bodies. Which representation is cheap?
import RAPIER from '@dimforge/rapier3d-compat';
await RAPIER.init();
const W = 48, H = 32;
let seed = 1;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const cells = [];
for (let k = 0; k < 8000; k++) {
  const x = Math.floor(rnd() * W), z = Math.floor(rnd() * W);
  const y = Math.floor(Math.pow(rnd(), 2) * 16);
  cells.push([x, y, z]);
}
function bodies(world, n) {
  for (let b = 0; b < n; b++) {
    const rb = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(2 + rnd() * 44, 18 + rnd() * 12, 2 + rnd() * 44));
    for (let k = 0; k < 2; k++) world.createCollider(RAPIER.ColliderDesc.cuboid(0.47, 0.47, 0.47).setTranslation(0, k, 0), rb);
  }
}
const avg = (a) => (a.reduce((x, y) => x + y, 0) / a.length).toFixed(2);

// A: one voxel collider pinned to the whole lattice
{
  const world = new RAPIER.World({ x: 0, y: -20, z: 0 });
  world.timestep = 1 / 30;
  const c = new Int32Array(cells.flat().concat([0, 0, 0, W - 1, H - 1, W - 1]));
  const vb = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(-0.5, -0.5, -0.5));
  world.createCollider(RAPIER.ColliderDesc.voxels(c, { x: 1, y: 1, z: 1 }), vb);
  bodies(world, 300);
  const t = [];
  for (let s = 0; s < 60; s++) { const a = performance.now(); world.step(); t.push(performance.now() - a); }
  console.log(`voxels(1): air ${avg(t.slice(2, 15))} ms, later ${avg(t.slice(40))} ms`);
  world.free();
}
// B: 8^3 voxel chunks, each only with its own cells
{
  const world = new RAPIER.World({ x: 0, y: -20, z: 0 });
  world.timestep = 1 / 30;
  const chunks = new Map();
  for (const [x, y, z] of cells) {
    const key = `${x >> 3},${y >> 3},${z >> 3}`;
    if (!chunks.has(key)) chunks.set(key, []);
    chunks.get(key).push(x, y, z);
  }
  const vb = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(-0.5, -0.5, -0.5));
  for (const list of chunks.values()) world.createCollider(RAPIER.ColliderDesc.voxels(new Int32Array(list), { x: 1, y: 1, z: 1 }), vb);
  bodies(world, 300);
  const t = [];
  for (let s = 0; s < 60; s++) { const a = performance.now(); world.step(); t.push(performance.now() - a); }
  console.log(`voxels(${chunks.size} chunks): air ${avg(t.slice(2, 15))} ms, later ${avg(t.slice(40))} ms`);
  world.free();
}
// C: one cuboid collider per cell, plus churn cost
{
  const world = new RAPIER.World({ x: 0, y: -20, z: 0 });
  world.timestep = 1 / 30;
  const fb = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const cols = [];
  let a = performance.now();
  for (const [x, y, z] of cells) cols.push(world.createCollider(RAPIER.ColliderDesc.cuboid(0.5, 0.5, 0.5).setTranslation(x, y, z), fb));
  const build = performance.now() - a;
  bodies(world, 300);
  const t = [];
  for (let s = 0; s < 60; s++) { const b = performance.now(); world.step(); t.push(performance.now() - b); }
  a = performance.now();
  for (let k = 0; k < 700; k++) world.removeCollider(cols[k], false);
  for (let k = 0; k < 700; k++) cols[k] = world.createCollider(RAPIER.ColliderDesc.cuboid(0.5, 0.5, 0.5).setTranslation(k % W, 20, (k / W) | 0), fb);
  const churn = performance.now() - a;
  const b = performance.now(); world.step(); const after = performance.now() - b;
  console.log(`cuboids: build 8000 ${build.toFixed(1)} ms, air ${avg(t.slice(2, 15))} ms, later ${avg(t.slice(40))} ms, churn 700+700 ${churn.toFixed(1)} ms, step after churn ${after.toFixed(1)} ms`);
  world.free();
}

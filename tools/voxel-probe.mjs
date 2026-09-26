// Throwaway: does the Voxels collider behave as the sim assumes?
import RAPIER from '@dimforge/rapier3d-compat';
await RAPIER.init();
const world = new RAPIER.World({ x: 0, y: -18, z: 0 });
// corners pin the domain; voxel (i,j,k) should span [i-0.5, i+0.5] after the -0.5 shift
const coords = new Int32Array([0, 0, 0, 31, 15, 31, 5, 0, 5, 5, 1, 5]);
const fixed = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(-0.5, -0.5, -0.5));
const vox = world.createCollider(RAPIER.ColliderDesc.voxels(coords, { x: 1, y: 1, z: 1 }), fixed);
vox.setVoxel(0, 0, 0, false);
vox.setVoxel(31, 15, 31, false);
// grow outside the initial set but inside the pinned domain
vox.setVoxel(9, 0, 9, true);
vox.setVoxel(9, 1, 9, true);
vox.setVoxel(9, 2, 9, true);
// outside the pinned domain
let outside = 'ok';
try { vox.setVoxel(40, 0, 40, true); } catch (e) { outside = 'throws: ' + e; }

function drop(x, z) {
  const b = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(x, 8, z));
  world.createCollider(RAPIER.ColliderDesc.cuboid(0.47, 0.47, 0.47).setDensity(1), b);
  return b;
}
const a = drop(5, 5); // expect rest at y = 2 (on top of voxel y=1)
const c = drop(9, 9); // expect rest at y = 3
const d = drop(40, 40); // outside domain: falls through if set failed
for (let i = 0; i < 240; i++) world.step();
const y = (b) => b.translation().y.toFixed(3);
console.log({ outside, a: y(a), c: y(c), d: y(d), aSleep: a.isSleeping() });
// remove the column under c: does it wake and fall?
vox.setVoxel(9, 2, 9, false);
vox.setVoxel(9, 1, 9, false);
for (let i = 0; i < 120; i++) world.step();
console.log({ afterRemove: y(c), cSleep: c.isSleeping() });
// cost of many updates
let t = performance.now();
for (let i = 0; i < 20000; i++) vox.setVoxel(i % 32, (i >> 5) % 16, (i >> 9) % 32, (i & 1) === 0);
console.log('20k setVoxel ms', (performance.now() - t).toFixed(1));
t = performance.now();
for (let i = 0; i < 60; i++) world.step();
console.log('60 steps after churn ms', (performance.now() - t).toFixed(1));

// Throwaway: what makes Rapier steps expensive here? voxels vs cuboids, body count, solver iterations.
import RAPIER from '@dimforge/rapier3d-compat';
await RAPIER.init();

function run({ floor, bodies, cubesPer, iters = 4, dt = 1 / 60 }) {
  const world = new RAPIER.World({ x: 0, y: -20, z: 0 });
  world.timestep = dt;
  world.numSolverIterations = iters;
  const W = 48;
  if (floor === 'voxels') {
    const c = [];
    for (let z = 0; z < W; z++) for (let x = 0; x < W; x++) c.push(x, 0, z);
    // some bumps
    for (let k = 0; k < 400; k++) c.push((k * 7) % W, 1 + (k % 3), (k * 13) % W);
    const vb = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(-0.5, -0.5, -0.5));
    world.createCollider(RAPIER.ColliderDesc.voxels(new Int32Array(c), { x: 1, y: 1, z: 1 }), vb);
  } else {
    const fb = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    world.createCollider(RAPIER.ColliderDesc.cuboid(W / 2, 0.5, W / 2).setTranslation(W / 2 - 0.5, 0, W / 2 - 0.5), fb);
    for (let k = 0; k < 400; k++) world.createCollider(RAPIER.ColliderDesc.cuboid(0.5, 0.5 + (k % 3) / 2, 0.5).setTranslation((k * 7) % W, 1 + (k % 3) / 2, (k * 13) % W), fb);
  }
  let seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let b = 0; b < bodies; b++) {
    const rb = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(2 + rnd() * 44, 4 + rnd() * 20, 2 + rnd() * 44));
    for (let k = 0; k < cubesPer; k++) world.createCollider(RAPIER.ColliderDesc.cuboid(0.47, 0.47, 0.47).setTranslation(0, k, 0), rb);
  }
  const times = [];
  for (let s = 0; s < 150; s++) {
    const t = performance.now();
    world.step();
    times.push(performance.now() - t);
  }
  const avg = (a) => (a.reduce((x, y) => x + y, 0) / a.length).toFixed(2);
  const r = `${floor.padEnd(7)} bodies=${bodies} cubes/body=${cubesPer} iters=${iters}: falling ${avg(times.slice(10, 40))} ms, landed ${avg(times.slice(100, 150))} ms`;
  world.free();
  return r;
}

for (const floor of ['voxels', 'cuboids']) {
  console.log(run({ floor, bodies: 400, cubesPer: 1 }));
  console.log(run({ floor, bodies: 400, cubesPer: 3 }));
  console.log(run({ floor, bodies: 150, cubesPer: 3 }));
}
console.log(run({ floor: 'voxels', bodies: 400, cubesPer: 3, iters: 2 }));
console.log(run({ floor: 'voxels', bodies: 400, cubesPer: 3, iters: 1 }));

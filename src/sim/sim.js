// Game of Life on a lattice + Rapier rigid bodies.
// Solid cells live in the lattice and are mirrored into one Voxels collider.
// Cells that lose structural support leave the lattice as rigid bodies, break
// on hard impacts, knock other cells loose, and rejoin the lattice once they
// come to rest.
import RAPIER from '@dimforge/rapier3d-compat';
import { Grid, STRENGTH_INF } from './grid.js';
import { PRESETS, parseRule } from './rules.js';

export { RAPIER };

export async function initPhysics() {
  await RAPIER.init();
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 30 Hz physics: resting contacts dominate Rapier's cost here, and the
// renderer interpolates poses between steps.
export const DT = 1 / 30;
const HALF = 0.47; // dynamic cube half extent: a small gap keeps fresh bodies out of contact
const STRENGTH_MAX_UI = 13; // slider value treated as "unbreakable"
const CHUNK = 8; // voxel collider chunk edge; syncVoxels' >> 3 / & ~7 assume 8

// Free-cell search order when a resting cube snaps back into an occupied cell.
const SNAP_TRY = [
  [0, 0, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1],
  [0, 2, 0], [1, 1, 0], [-1, 1, 0], [0, 1, 1], [0, 1, -1], [0, 3, 0],
];

export const DEFAULTS = {
  size: [48, 32, 48],
  rule: 'pyro',
  tickRate: 3, // generations per second
  strength: 6, // how far support reaches sideways / downwards
  gravity: 20,
  shatter: 5, // velocity change (u/s) that breaks a falling body
  knock: 7, // velocity change that knocks lattice cells loose
  wobble: 0.6, // random spin given to released bodies (rad/s)
  meteors: true,
  maxDynamic: 600, // cubes simulated as rigid bodies at once (~12 µs each per step at rest)
  maxBodies: 160,
  maxBody: 150,
  seed: 1,
};

function rotate(q, x, y, z, out) {
  // v' = v + 2w(u×v) + 2u×(u×v), u = (q.x,q.y,q.z)
  const tx = 2 * (q.y * z - q.z * y);
  const ty = 2 * (q.z * x - q.x * z);
  const tz = 2 * (q.x * y - q.y * x);
  out[0] = x + q.w * tx + (q.y * tz - q.z * ty);
  out[1] = y + q.w * ty + (q.z * tx - q.x * tz);
  out[2] = z + q.w * tz + (q.x * ty - q.y * tx);
  return out;
}

export class Sim {
  constructor(opts = {}) {
    this.p = { ...DEFAULTS, ...opts };
    const [W, H, D] = this.p.size;
    this.W = W;
    this.H = H;
    this.D = D;
    this.grid = new Grid(W, H, D);
    const N = this.grid.N;
    this.solid = new Uint8Array(N);
    this.bornAt = new Float32Array(N);
    this.slide = new Float32Array(N * 3);
    this.slideAt = new Float32Array(N);
    this.slideDur = new Float32Array(N);
    this.ghosts = [];
    this.bodies = [];
    this.nDynamic = 0;
    this.rng = mulberry32(this.p.seed);
    this.tmp = [0, 0, 0];
    this.time = 0;
    this.acc = 0;
    this.gen = 0;
    this.tickClock = 0;
    this.running = true;
    this.version = 0;
    this.voxelsDirty = false;
    this.supportDirty = false;
    this.lastSupport = 0;
    this.knockLeft = 0;
    this.nextMeteor = 4;
    this.stats = { released: 0, dropped: 0, shattered: 0, knocked: 0, snapped: 0, lost: 0 };
    this.timing = { ca: 0, support: 0, voxels: 0, physics: 0 };
    this.setRule(this.p.rule);
    this.buildWorld();
  }

  setRule(idOrText) {
    const preset = PRESETS.find((p) => p.id === idOrText);
    this.rule = parseRule(preset ? preset.rule : idOrText);
    this.preset = preset ?? null;
  }

  get strength() {
    return this.p.strength >= STRENGTH_MAX_UI ? STRENGTH_INF : Math.max(1, Math.round(this.p.strength));
  }

  buildWorld() {
    if (this.world) this.world.free();
    const { W, H, D } = this;
    this.world = new RAPIER.World({ x: 0, y: -this.p.gravity, z: 0 });
    this.world.timestep = DT;
    const ground = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(W / 2, 0.5, D / 2)
        .setTranslation(W / 2 - 0.5, -1, D / 2 - 0.5)
        .setFriction(0.9),
      ground,
    );
    // The lattice collides as 8³ Voxels chunks, created on demand and dropped
    // when empty: a single lattice-sized Voxels collider pairs with every body
    // in the air, which made each step several times slower.
    // Voxel (i,j,k) spans [i-0.5, i+0.5], so cell centres sit on integer coordinates.
    this.voxelBody = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(-0.5, -0.5, -0.5));
    this.cw = Math.ceil(W / CHUNK);
    this.cd = Math.ceil(D / CHUNK);
    this.chunks = new Array(this.cw * this.cd * Math.ceil(H / CHUNK)).fill(null);
    this.chunkFill = new Int32Array(this.chunks.length);
    this.pendingSows = [];
    this.solid.fill(0);
    this.bodies = [];
    this.nDynamic = 0;
  }

  setGravity(g) {
    this.p.gravity = g;
    this.world.gravity = { x: 0, y: -g, z: 0 };
  }

  // Fresh world: random soup in the middle of the platform.
  reset(density) {
    const g = this.grid;
    g.clear();
    this.buildWorld();
    this.ghosts = [];
    this.gen = 0;
    this.tickClock = 0;
    this.bornAt.fill(this.time);
    this.slideAt.fill(-10);
    this.slideDur.fill(0.15);
    const d = density ?? this.preset?.density ?? 0.3;
    const { W, H, D } = this;
    const rx = Math.floor(W * 0.22);
    const rz = Math.floor(D * 0.22);
    const hy = Math.floor(H * 0.45);
    const cx = W >> 1;
    const cz = D >> 1;
    for (let y = 0; y < hy; y++)
      for (let z = cz - rz; z < cz + rz; z++)
        for (let x = cx - rx; x < cx + rx; x++) {
          if (this.rng() >= d) continue;
          const i = g.index(x, y, z);
          g.state[i] = 1;
          g.age[i] = 0;
        }
    this.releaseUnsupported();
    this.syncVoxels();
    this.nextMeteor = this.time + 6;
    this.version++;
  }

  clearAll() {
    this.grid.clear();
    this.buildWorld();
    this.ghosts = [];
    this.gen = 0;
    this.version++;
  }

  syncVoxels() {
    const t0 = performance.now();
    const { W, D, L, N } = this.grid;
    const st = this.grid.state;
    const so = this.solid;
    for (let i = 0; i < N; i++) {
      const s = st[i] !== 0 ? 1 : 0;
      if (s === so[i]) continue;
      so[i] = s;
      const x = i % W;
      const y = (i / L) | 0;
      const z = ((i / W) | 0) % D;
      const k = (x >> 3) + this.cw * ((z >> 3) + this.cd * (y >> 3));
      let c = this.chunks[k];
      if (s) {
        if (!c) c = this.chunks[k] = this.makeChunk(x & ~7, y & ~7, z & ~7);
        c.setVoxel(x, y, z, true);
        this.chunkFill[k]++;
      } else {
        c.setVoxel(x, y, z, false);
        if (--this.chunkFill[k] === 0) {
          this.world.removeCollider(c, true);
          this.chunks[k] = null;
        }
      }
    }
    this.voxelsDirty = false;
    this.timing.voxels = performance.now() - t0;
  }

  // Empty Voxels collider whose domain is pinned to one 8³ chunk.
  makeChunk(x0, y0, z0) {
    const e = CHUNK - 1;
    const pins = new Int32Array([x0, y0, z0, x0 + e, y0 + e, z0 + e]);
    const c = this.world.createCollider(RAPIER.ColliderDesc.voxels(pins, { x: 1, y: 1, z: 1 }).setFriction(0.9), this.voxelBody);
    c.setVoxel(x0, y0, z0, false);
    c.setVoxel(x0 + e, y0 + e, z0 + e, false);
    return c;
  }

  tick() {
    const t0 = performance.now();
    const g = this.grid;
    g.step(this.rule);
    const now = this.time;
    for (let k = 0; k < g.nBirths; k++) this.bornAt[g.births[k]] = now;
    for (let k = 0; k < g.nVanished; k++) {
      const i = g.vanished[k];
      this.ghosts.push({ i, s: g.vanishedState[k], age: g.age[i], t: now });
    }
    this.gen++;
    const t1 = performance.now();
    this.timing.ca = t1 - t0;
    this.releaseUnsupported();
    this.syncVoxels();
    this.version++;
  }

  // Unsupported clusters fall. Chunks of 2+ cells become rigid bodies while the
  // physics budget lasts (largest first); single cells and overflow drop
  // straight down inside the lattice, which costs nothing.
  releaseUnsupported() {
    const t0 = performance.now();
    const g = this.grid;
    const n = g.support(this.strength);
    let released = 0;
    let dropped = 0;
    if (n > 0) {
      const clusters = g.clusters(n, this.p.maxBody);
      const order = [];
      for (let k = 0; k < clusters.length; k++) if (clusters[k].length >= 2) order.push(k);
      order.sort((a, b) => clusters[b].length - clusters[a].length);
      const phys = new Uint8Array(clusters.length);
      let dyn = this.nDynamic;
      let nb = this.bodies.length;
      for (const k of order) {
        if (dyn + clusters[k].length > this.p.maxDynamic || nb >= this.p.maxBodies) continue;
        phys[k] = 1;
        dyn += clusters[k].length;
        nb++;
      }
      for (let k = 0; k < clusters.length; k++) {
        if (phys[k]) {
          this.spawnFromCells(clusters[k]);
          released += clusters[k].length;
        }
      }
      // clusters come lowest-first, so a lower one has landed before the next drops onto it
      for (let k = 0; k < clusters.length; k++) if (!phys[k] && this.latticeDrop(clusters[k])) dropped += clusters[k].length;
    }
    this.stats.released += released;
    this.stats.dropped += dropped;
    this.supportDirty = false;
    this.lastSupport = this.time;
    this.timing.support = performance.now() - t0;
    if (released || dropped) this.version++;
    return released;
  }

  // Move a cluster straight down until one of its cells rests on something.
  latticeDrop(cells) {
    const g = this.grid;
    const { L } = g;
    const st = g.state;
    const mark = g.mark;
    for (const c of cells) mark[c] = 3;
    let d = Infinity;
    for (const c of cells) {
      let j = c - L;
      let k = 0;
      while (j >= 0 && (st[j] === 0 || mark[j] === 3)) {
        k++;
        j -= L;
      }
      if (k < d) d = k;
    }
    for (const c of cells) mark[c] = 0;
    if (!(d > 0 && d < Infinity)) return false;
    const sorted = Int32Array.from(cells).sort();
    const shift = d * L;
    const dur = Math.sqrt((2 * d) / this.p.gravity);
    for (const c of sorted) {
      const nc = c - shift;
      st[nc] = st[c];
      g.age[nc] = g.age[c];
      this.bornAt[nc] = this.bornAt[c];
      st[c] = 0;
      g.age[c] = 0;
      this.slide[nc * 3] = 0;
      this.slide[nc * 3 + 1] = d;
      this.slide[nc * 3 + 2] = 0;
      this.slideAt[nc] = this.time;
      this.slideDur[nc] = dur;
    }
    this.voxelsDirty = true;
    return true;
  }

  // Lift lattice cells out into one rigid body (the caller syncs voxels).
  spawnFromCells(cells) {
    const g = this.grid;
    const { W, D, L } = g;
    const n = cells.length;
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let k = 0; k < n; k++) {
      const i = cells[k];
      cx += i % W;
      cy += (i / L) | 0;
      cz += ((i / W) | 0) % D;
    }
    cx /= n;
    cy /= n;
    cz /= n;
    const local = new Float32Array(n * 3);
    const states = new Uint8Array(n);
    const ages = new Uint16Array(n);
    for (let k = 0; k < n; k++) {
      const i = cells[k];
      local[k * 3] = (i % W) - cx;
      local[k * 3 + 1] = ((i / L) | 0) - cy;
      local[k * 3 + 2] = (((i / W) | 0) % D) - cz;
      states[k] = g.state[i];
      ages[k] = g.age[i];
      g.state[i] = 0;
      g.age[i] = 0;
    }
    const a = this.rng() * Math.PI * 2;
    const w = this.p.wobble * (0.4 + 0.6 * this.rng());
    return this.createBody(cx, cy, cz, null, local, states, ages, { x: 0, y: 0, z: 0 }, {
      x: Math.cos(a) * w,
      y: 0,
      z: Math.sin(a) * w,
    });
  }

  createBody(tx, ty, tz, rot, local, states, ages, v, w, calm = 0) {
    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(tx, ty, tz)
      .setLinvel(v.x, v.y, v.z)
      .setAngvel(w)
      .setLinearDamping(0.05)
      .setAngularDamping(0.6);
    if (rot) desc.setRotation(rot);
    const rb = this.world.createRigidBody(desc);
    const n = states.length;
    let r2 = 0;
    let mx = 0;
    let my = 0;
    let mz = 0;
    for (let k = 0; k < n; k++) {
      const lx = local[k * 3];
      const ly = local[k * 3 + 1];
      const lz = local[k * 3 + 2];
      mx += lx;
      my += ly;
      mz += lz;
      this.world.createCollider(
        RAPIER.ColliderDesc.cuboid(HALF, HALF, HALF)
          .setTranslation(lx, ly, lz)
          .setDensity(1)
          .setFriction(0.8)
          .setRestitution(0.05),
        rb,
      );
    }
    mx /= n;
    my /= n;
    mz /= n;
    for (let k = 0; k < n; k++) {
      const dx = local[k * 3] - mx;
      const dy = local[k * 3 + 1] - my;
      const dz = local[k * 3 + 2] - mz;
      r2 = Math.max(r2, dx * dx + dy * dy + dz * dz);
    }
    const body = {
      rb,
      n,
      local,
      states,
      ages,
      com: [mx, my, mz], // local centre of mass (uniform density)
      radius: Math.sqrt(r2) + 0.5,
      v: { x: v.x, y: v.y, z: v.z },
      w: { x: w.x, y: w.y, z: w.z },
      low: 0,
      life: 0,
      calm,
      shatterAt: 0,
      born: this.time,
    };
    this.bodies.push(body);
    this.nDynamic += n;
    return body;
  }

  removeBody(b) {
    this.world.removeRigidBody(b.rb);
    this.nDynamic -= b.n;
    b.rb = null;
  }

  stepPhysics() {
    const t0 = performance.now();
    // previous poses, for render interpolation between steps
    for (const b of this.bodies) {
      b.pt = b.rb.translation();
      b.pq = b.rb.rotation();
    }
    this.world.step();
    const { shatter, knock } = this.p;
    this.knockLeft = 10;
    const keep = [];
    const broken = [];
    for (const b of this.bodies) {
      const rb = b.rb;
      const lv = rb.linvel();
      const av = rb.angvel();
      if (b.calm > 0) b.calm -= DT;
      else {
        const dv = Math.hypot(lv.x - b.v.x, lv.y - b.v.y, lv.z - b.v.z);
        const dw = Math.hypot(av.x - b.w.x, av.y - b.w.y, av.z - b.w.z);
        const impact = dv + dw * b.radius * 0.5;
        if (impact > knock) this.knockFrom(b, impact);
        if (impact > shatter && b.n > 1) b.shatterAt = impact;
        if (b.seeds && impact > shatter) {
          // a meteor brings life: a patch of soup grows where it hit, once the debris clears
          const t = rb.translation();
          this.pendingSows.push({ x: t.x, z: t.z, at: this.time + 0.5 });
          b.seeds = false;
        }
      }
      b.v = lv;
      b.w = av;
      // Small debris counts as settled while still creeping (the snap slide hides
      // the rest); big bodies must be really still, or a column snaps mid-topple.
      const small = b.n <= 4;
      const v2 = lv.x * lv.x + lv.y * lv.y + lv.z * lv.z;
      const w2 = av.x * av.x + av.y * av.y + av.z * av.z;
      const slow = small ? v2 < 0.3 && w2 < 0.6 : v2 < 0.1 && w2 < 0.04;
      b.low = slow ? b.low + DT : 0;
      b.life += DT;
      if (rb.translation().y < -25) {
        this.stats.lost += b.n;
        this.removeBody(b);
        continue;
      }
      if (b.shatterAt > 0) {
        broken.push(b);
        continue;
      }
      const settleTime = small ? 0.12 : 0.2 + 0.03 * b.radius;
      if (b.low > settleTime || rb.isSleeping() || b.life > (small ? 4 : 10)) {
        this.snap(b);
        continue;
      }
      keep.push(b);
    }
    this.bodies = keep;
    for (const b of broken) this.shatterBody(b);
    if (this.voxelsDirty) this.syncVoxels();
    this.timing.physics = performance.now() - t0;
  }

  worldPos(b, k, t, q, out) {
    rotate(q, b.local[k * 3], b.local[k * 3 + 1], b.local[k * 3 + 2], out);
    out[0] += t.x;
    out[1] += t.y;
    out[2] += t.z;
    return out;
  }

  // A hard landing knocks lattice cells in front of the impact loose.
  knockFrom(b, impact) {
    const v = b.v;
    const sp = Math.hypot(v.x, v.y, v.z);
    if (sp < 2 || this.knockLeft <= 0) return;
    const chance = Math.min(1, (impact - this.p.knock) / this.p.knock + 0.25);
    let budget = Math.min(this.knockLeft, 1 + Math.floor((impact - this.p.knock) * 0.35 * Math.sqrt(b.n)));
    const g = this.grid;
    const t = b.rb.translation();
    const q = b.rb.rotation();
    const p = this.tmp;
    const dx = v.x / sp;
    const dy = v.y / sp;
    const dz = v.z / sp;
    const start = Math.floor(this.rng() * b.n);
    for (let s = 0; s < b.n && budget > 0; s++) {
      const k = (start + s) % b.n;
      this.worldPos(b, k, t, q, p);
      const x = Math.round(p[0] + dx * 0.9);
      const y = Math.round(p[1] + dy * 0.9);
      const z = Math.round(p[2] + dz * 0.9);
      if (!g.inside(x, y, z)) continue;
      const i = g.index(x, y, z);
      if (g.state[i] === 0 || this.rng() > chance) continue;
      const kick = 0.45 + 0.2 * this.rng();
      this.dislodge(i, v.x * kick + (this.rng() - 0.5) * 3, Math.abs(v.y) * 0.2 + 2 + this.rng() * 2, v.z * kick + (this.rng() - 0.5) * 3);
      budget--;
      this.knockLeft--;
      this.stats.knocked++;
    }
  }

  dislodge(i, vx, vy, vz) {
    if (this.nDynamic >= this.p.maxDynamic || this.bodies.length >= this.p.maxBodies) return null;
    const g = this.grid;
    const { W, D, L } = g;
    const states = new Uint8Array([g.state[i]]);
    const ages = new Uint16Array([g.age[i]]);
    g.state[i] = 0;
    g.age[i] = 0;
    this.voxelsDirty = true;
    this.supportDirty = true;
    this.version++;
    const r = () => (this.rng() - 0.5) * 8;
    return this.createBody(i % W, (i / L) | 0, ((i / W) | 0) % D, null, new Float32Array(3), states, ages,
      { x: vx, y: vy, z: vz }, { x: r(), y: r(), z: r() }, 0.15);
  }

  // Break a body into random compact fragments; harder hits make smaller ones.
  shatterBody(b) {
    const rb = b.rb;
    const n = b.n;
    const impact = b.shatterAt;
    const t = rb.translation();
    const q = rb.rotation();
    const lv = rb.linvel();
    const av = rb.angvel();
    const key = (k) =>
      (Math.round(b.local[k * 3] - b.local[0]) + 256) |
      ((Math.round(b.local[k * 3 + 1] - b.local[1]) + 256) << 9) |
      ((Math.round(b.local[k * 3 + 2] - b.local[2]) + 256) << 18);
    const at = new Map();
    for (let k = 0; k < n; k++) at.set(key(k), k);
    const piece = new Int32Array(n).fill(-1);
    const maxPiece = impact > 2.2 * this.p.shatter ? 2 : impact > 1.5 * this.p.shatter ? 3 : 6;
    const order = Array.from({ length: n }, (_, k) => k);
    for (let k = n - 1; k > 0; k--) {
      const j = Math.floor(this.rng() * (k + 1));
      [order[k], order[j]] = [order[j], order[k]];
    }
    const groups = [];
    for (const seed of order) {
      if (piece[seed] >= 0) continue;
      const id = groups.length;
      const target = Math.min(maxPiece, 2 + Math.floor(this.rng() * maxPiece));
      const members = [seed];
      piece[seed] = id;
      for (let h = 0; h < members.length && members.length < target; h++) {
        const base = key(members[h]);
        for (let dy = -1; dy <= 1 && members.length < target; dy++)
          for (let dz = -1; dz <= 1 && members.length < target; dz++)
            for (let dx = -1; dx <= 1 && members.length < target; dx++) {
              const m = Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
              if (m === 0 || m === 3) continue;
              const j = at.get(base + dx + (dy << 9) + (dz << 18));
              if (j === undefined || piece[j] >= 0) continue;
              piece[j] = id;
              members.push(j);
            }
      }
      groups.push(members);
    }
    const com = rotate(q, b.com[0], b.com[1], b.com[2], [0, 0, 0]);
    const rot = { x: q.x, y: q.y, z: q.z, w: q.w };
    const kick = impact * 0.12;
    this.removeBody(b);
    for (const members of groups) {
      const m = members.length;
      let px = 0;
      let py = 0;
      let pz = 0;
      for (const k of members) {
        px += b.local[k * 3];
        py += b.local[k * 3 + 1];
        pz += b.local[k * 3 + 2];
      }
      px /= m;
      py /= m;
      pz /= m;
      const wp = rotate(q, px, py, pz, [0, 0, 0]);
      const rx = wp[0] - com[0];
      const ry = wp[1] - com[1];
      const rz = wp[2] - com[2];
      const rl = Math.hypot(rx, ry, rz) || 1;
      const local = new Float32Array(m * 3);
      const states = new Uint8Array(m);
      const ages = new Uint16Array(m);
      members.forEach((k, j) => {
        local[j * 3] = b.local[k * 3] - px;
        local[j * 3 + 1] = b.local[k * 3 + 1] - py;
        local[j * 3 + 2] = b.local[k * 3 + 2] - pz;
        states[j] = b.states[k];
        ages[j] = b.ages[k];
      });
      const out = kick * (0.5 + this.rng());
      const v = {
        x: lv.x + (av.y * rz - av.z * ry) + (rx / rl) * out + (this.rng() - 0.5) * kick,
        y: lv.y + (av.z * rx - av.x * rz) + Math.abs(ry / rl) * out * 0.5 + this.rng() * kick,
        z: lv.z + (av.x * ry - av.y * rx) + (rz / rl) * out + (this.rng() - 0.5) * kick,
      };
      const r = () => (this.rng() - 0.5) * 4;
      const w = { x: av.x + r(), y: av.y + r(), z: av.z + r() };
      this.createBody(t.x + wp[0], t.y + wp[1], t.z + wp[2], rot, local, states, ages, v, w, 0.25);
    }
    this.stats.shattered++;
  }

  // A body at rest goes back into the lattice, cube by cube.
  snap(b) {
    const g = this.grid;
    const t = b.rb.translation();
    const q = b.rb.rotation();
    const p = this.tmp;
    for (let k = 0; k < b.n; k++) {
      this.worldPos(b, k, t, q, p);
      const cx = Math.round(p[0]);
      const cz = Math.round(p[2]);
      const cy = Math.max(0, Math.round(p[1]));
      let placed = false;
      for (const o of SNAP_TRY) {
        const x = cx + o[0];
        const y = cy + o[1];
        const z = cz + o[2];
        if (!g.inside(x, y, z)) continue;
        const i = g.index(x, y, z);
        if (g.state[i] !== 0) continue;
        g.state[i] = b.states[k];
        g.age[i] = b.ages[k];
        this.slide[i * 3] = p[0] - x;
        this.slide[i * 3 + 1] = p[1] - y;
        this.slide[i * 3 + 2] = p[2] - z;
        this.slideAt[i] = this.time;
        this.slideDur[i] = 0.15;
        placed = true;
        break;
      }
      if (placed) this.stats.snapped++;
      else this.stats.lost++;
    }
    this.removeBody(b);
    this.voxelsDirty = true;
    this.supportDirty = true;
    this.version++;
  }

  surfaceY(x, z) {
    const g = this.grid;
    for (let y = g.H - 1; y >= 0; y--) if (g.state[g.index(x, y, z)] !== 0) return y + 1;
    return 0;
  }

  randomQuat() {
    const u = this.rng();
    const v = this.rng() * Math.PI * 2;
    const w = this.rng() * Math.PI * 2;
    const a = Math.sqrt(1 - u);
    const c = Math.sqrt(u);
    return { x: a * Math.sin(v), y: a * Math.cos(v), z: c * Math.sin(w), w: c * Math.cos(w) };
  }

  // Tools ------------------------------------------------------------------

  dropMeteor(x, z, size) {
    const s = size ?? 3 + Math.floor(this.rng() * 3);
    const r = s / 2;
    const cells = [];
    for (let dy = -r; dy <= r; dy++)
      for (let dz = -r; dz <= r; dz++)
        for (let dx = -r; dx <= r; dx++)
          if (dx * dx + dy * dy + dz * dz <= r * r + 0.5 && this.rng() < 0.7) cells.push(dx, dy, dz);
    const n = cells.length / 3;
    if (!n || this.nDynamic + n > this.p.maxDynamic) return null;
    const r2 = () => (this.rng() - 0.5) * 3;
    const body = this.createBody(x, this.H + 6, z, this.randomQuat(), new Float32Array(cells), new Uint8Array(n).fill(1),
      new Uint16Array(n), { x: r2(), y: -14, z: r2() }, { x: r2(), y: r2(), z: r2() });
    body.rb.setSoftCcdPrediction(2); // it arrives fast
    body.seeds = true;
    return body;
  }

  // Random soup on top of the surface in a disc, tallest in the middle.
  sowPatch(x, z, radius = 4, density = 0.35) {
    const g = this.grid;
    for (let dz = -radius; dz <= radius; dz++)
      for (let dx = -radius; dx <= radius; dx++) {
        const d = Math.hypot(dx, dz);
        if (d > radius) continue;
        const cx = Math.round(x) + dx;
        const cz = Math.round(z) + dz;
        if (cx < 0 || cz < 0 || cx >= g.W || cz >= g.D) continue;
        const base = this.surfaceY(cx, cz);
        const h = 1 + Math.round((1 - d / radius) * 3);
        for (let y = base; y < Math.min(g.H, base + h); y++) {
          const i = g.index(cx, y, cz);
          if (g.state[i] !== 0 || this.rng() >= density) continue;
          g.state[i] = 1;
          g.age[i] = 0;
          this.bornAt[i] = this.time;
        }
      }
    this.supportDirty = true;
    this.voxelsDirty = true;
    this.version++;
  }

  // A tall 2x2 column, tilted a little so it topples, lands and breaks up.
  dropPillar(x, z, height) {
    const h = height ?? 12 + Math.floor(this.rng() * 7);
    const n = h * 4;
    if (this.nDynamic + n > this.p.maxDynamic) return null;
    const local = new Float32Array(n * 3);
    let k = 0;
    for (let y = 0; y < h; y++)
      for (let dz = 0; dz < 2; dz++)
        for (let dx = 0; dx < 2; dx++) {
          local[k++] = dx - 0.5;
          local[k++] = y - (h - 1) / 2;
          local[k++] = dz - 0.5;
        }
    const a = this.rng() * Math.PI * 2;
    const tilt = (8 + this.rng() * 6) * (Math.PI / 180);
    const s = Math.sin(tilt / 2);
    const rot = { x: Math.cos(a) * s, y: 0, z: Math.sin(a) * s, w: Math.cos(tilt / 2) };
    const cx = Math.max(1, Math.min(this.W - 2, Math.round(x)));
    const cz = Math.max(1, Math.min(this.D - 2, Math.round(z)));
    let base = 0;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) base = Math.max(base, this.surfaceY(cx + dx, cz + dz));
    const spin = 0.5; // a nudge about the tilt axis so it commits to falling over
    return this.createBody(x, base + h / 2 + 1.5, z, rot, local, new Uint8Array(n).fill(1), new Uint16Array(n),
      { x: 0, y: 0, z: 0 }, { x: Math.cos(a) * spin, y: 0, z: Math.sin(a) * spin }, 0.6);
  }

  blast(x, y, z, radius = 4) {
    const g = this.grid;
    const r = radius;
    for (const b of this.bodies) {
      const t = b.rb.translation();
      const ox = t.x - x;
      const oy = t.y - y;
      const oz = t.z - z;
      const d = Math.hypot(ox, oy, oz);
      if (d > r * 2) continue;
      const f = ((r * 2 - d) / (r * 2)) * 14 * b.rb.mass();
      const l = d || 1;
      b.rb.applyImpulse({ x: (ox / l) * f, y: (oy / l) * f + f * 0.3, z: (oz / l) * f }, true);
    }
    for (let dy = -r; dy <= r; dy++)
      for (let dz = -r; dz <= r; dz++)
        for (let dx = -r; dx <= r; dx++) {
          const d = Math.hypot(dx, dy, dz);
          if (d > r) continue;
          const cx = Math.round(x) + dx;
          const cy = Math.round(y) + dy;
          const cz = Math.round(z) + dz;
          if (!g.inside(cx, cy, cz)) continue;
          const i = g.index(cx, cy, cz);
          if (g.state[i] === 0) continue;
          const f = (r - d + 1) * 3.2;
          const l = d || 1;
          if (this.dislodge(i, (dx / l) * f, (dy / l) * f + 5, (dz / l) * f)) continue;
          // out of physics budget: the cell is vaporised instead
          this.ghosts.push({ i, s: g.state[i], age: g.age[i], t: this.time });
          g.state[i] = 0;
          g.age[i] = 0;
        }
    this.supportDirty = true;
    this.version++;
    this.syncVoxels();
  }

  sow(x, y, z, radius = 3, density = 0.35) {
    const g = this.grid;
    const r = radius;
    for (let dy = -r; dy <= r; dy++)
      for (let dz = -r; dz <= r; dz++)
        for (let dx = -r; dx <= r; dx++) {
          if (dx * dx + dy * dy + dz * dz > r * r || this.rng() >= density) continue;
          const cx = Math.round(x) + dx;
          const cy = Math.round(y) + dy;
          const cz = Math.round(z) + dz;
          if (!g.inside(cx, cy, cz)) continue;
          const i = g.index(cx, cy, cz);
          if (g.state[i] !== 0) continue;
          g.state[i] = 1;
          g.age[i] = 0;
          this.bornAt[i] = this.time;
        }
    this.supportDirty = true;
    this.voxelsDirty = true;
    this.version++;
  }

  // Ray query against the lattice, the platform and falling bodies.
  pick(origin, dir) {
    const hit = this.world.castRayAndGetNormal(new RAPIER.Ray(origin, dir), 500, true);
    if (!hit) return null;
    const t = hit.timeOfImpact;
    return {
      point: { x: origin.x + dir.x * t, y: origin.y + dir.y * t, z: origin.z + dir.z * t },
      normal: hit.normal,
    };
  }

  // Advance by real time dt: fixed 60 Hz physics, CA ticks at tickRate.
  update(dt) {
    this.acc += Math.min(dt, 0.1);
    let steps = 0;
    while (this.acc >= DT && steps < 4) {
      this.stepPhysics();
      this.acc -= DT;
      this.time += DT;
      steps++;
    }
    if (steps === 4) this.acc = 0;
    if (this.running) {
      this.tickClock += Math.min(dt, 0.1);
      const period = 1 / this.p.tickRate;
      if (this.tickClock >= period) {
        this.tickClock = Math.min(this.tickClock - period, period);
        this.tick();
      }
    }
    if (this.supportDirty && this.time - this.lastSupport > 0.15) {
      this.releaseUnsupported();
      this.syncVoxels();
    }
    while (this.pendingSows.length && this.pendingSows[0].at <= this.time) {
      const s = this.pendingSows.shift();
      this.sowPatch(s.x, s.z, 4 + Math.floor(this.rng() * 2));
    }
    if (this.p.meteors && this.time >= this.nextMeteor) {
      const m = 6;
      this.dropMeteor(m + this.rng() * (this.W - 2 * m), m + this.rng() * (this.D - 2 * m));
      const pop = this.grid.population();
      this.nextMeteor = this.time + (pop < 300 ? 2.5 : 6) + this.rng() * 5;
    }
    if (this.ghosts.length && this.time - this.ghosts[0].t > 0.6) {
      this.ghosts = this.ghosts.filter((gh) => this.time - gh.t <= 0.6);
      this.version++;
    }
  }
}

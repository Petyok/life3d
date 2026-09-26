// Lattice of cells: CA generations, structural support and cluster grouping.
// Index layout: i = x + z*W + y*W*D, so y (up) is the slowest axis.

// 18-neighbourhood (faces + edges). Support flows up for free and costs 1 in
// every other direction, so overhangs and hanging parts have limited reach.
const N18 = [];
for (let dy = -1; dy <= 1; dy++)
  for (let dz = -1; dz <= 1; dz++)
    for (let dx = -1; dx <= 1; dx++) {
      const m = Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
      if (m === 1 || m === 2) N18.push([dx, dy, dz, dx === 0 && dz === 0 && dy === 1 ? 0 : 1]);
    }

export const STRENGTH_INF = 250;

export class Grid {
  constructor(W, H, D) {
    this.W = W;
    this.H = H;
    this.D = D;
    this.L = W * D;
    const N = (this.N = W * H * D);
    this.state = new Uint8Array(N);
    this.age = new Uint16Array(N);
    this.next = new Uint8Array(N);
    this.live = new Uint8Array(N);
    this.sx = new Uint8Array(N);
    this.sxz = new Uint8Array(N);
    this.stab = new Uint8Array(N);
    this.mark = new Uint8Array(N);
    this.qa = new Int32Array(N);
    this.qb = new Int32Array(N);
    this.births = new Int32Array(N);
    this.nBirths = 0;
    this.vanished = new Int32Array(N);
    this.vanishedState = new Uint8Array(N);
    this.nVanished = 0;
  }

  index(x, y, z) {
    return x + z * this.W + y * this.L;
  }

  inside(x, y, z) {
    return x >= 0 && y >= 0 && z >= 0 && x < this.W && y < this.H && z < this.D;
  }

  clear() {
    this.state.fill(0);
    this.age.fill(0);
  }

  population() {
    let n = 0;
    const s = this.state;
    for (let i = 0; i < this.N; i++) if (s[i] === 1) n++;
    return n;
  }

  // One CA generation. Fills births[] (empty -> alive) and vanished[] (solid -> empty).
  step(rule) {
    const { N, state, live, next, age } = this;
    for (let i = 0; i < N; i++) live[i] = state[i] === 1 ? 1 : 0;
    const count = rule.hood === 'M' ? this.mooreCounts() : this.vnCounts();
    const { survive, birth, states } = rule;
    let nb = 0;
    let nv = 0;
    for (let i = 0; i < N; i++) {
      const s = state[i];
      const c = count[i];
      let n;
      if (s === 0) n = birth[c] ? 1 : 0;
      else if (s === 1) n = survive[c] ? 1 : states > 2 ? 2 : 0;
      else n = s + 1 >= states ? 0 : s + 1;
      next[i] = n;
      if (n === 1) {
        if (s === 0) {
          this.births[nb++] = i;
          age[i] = 0;
        } else if (age[i] < 65535) age[i]++;
      } else if (n === 0 && s !== 0) {
        this.vanished[nv] = i;
        this.vanishedState[nv++] = s;
      }
    }
    this.state = next;
    this.next = state;
    this.nBirths = nb;
    this.nVanished = nv;
  }

  // 3x3x3 box sum of live cells minus self, as three separable 3-tap passes.
  mooreCounts() {
    const { W, H, D, L, live, sx, sxz } = this;
    for (let y = 0; y < H; y++)
      for (let z = 0; z < D; z++) {
        const b = y * L + z * W;
        for (let x = 0; x < W; x++) {
          const i = b + x;
          sx[i] = live[i] + (x > 0 ? live[i - 1] : 0) + (x < W - 1 ? live[i + 1] : 0);
        }
      }
    for (let y = 0; y < H; y++)
      for (let z = 0; z < D; z++) {
        const b = y * L + z * W;
        for (let x = 0; x < W; x++) {
          const i = b + x;
          sxz[i] = sx[i] + (z > 0 ? sx[i - W] : 0) + (z < D - 1 ? sx[i + W] : 0);
        }
      }
    // reuse sx as the output buffer
    const out = sx;
    for (let y = 0; y < H; y++) {
      const b = y * L;
      for (let k = 0; k < L; k++) {
        const i = b + k;
        out[i] = sxz[i] + (y > 0 ? sxz[i - L] : 0) + (y < H - 1 ? sxz[i + L] : 0) - live[i];
      }
    }
    return out;
  }

  vnCounts() {
    const { W, H, D, L, live, sx } = this;
    for (let y = 0; y < H; y++)
      for (let z = 0; z < D; z++) {
        const b = y * L + z * W;
        for (let x = 0; x < W; x++) {
          const i = b + x;
          sx[i] =
            (x > 0 ? live[i - 1] : 0) +
            (x < W - 1 ? live[i + 1] : 0) +
            (z > 0 ? live[i - W] : 0) +
            (z < D - 1 ? live[i + W] : 0) +
            (y > 0 ? live[i - L] : 0) +
            (y < H - 1 ? live[i + L] : 0);
        }
      }
    return sx;
  }

  // Structural support: ground cells get `strength`, which flows through the
  // 18-neighbourhood (free straight up, -1 any other way). Returns the number
  // of solid cells left at 0 (unsupported); their indices are in qa[0..n).
  support(strength) {
    const { W, H, D, L, N, state, stab } = this;
    stab.fill(0);
    let cur = this.qa;
    let nxt = this.qb;
    let nc = 0;
    for (let i = 0; i < L; i++)
      if (state[i] !== 0) {
        stab[i] = strength;
        cur[nc++] = i;
      }
    for (let level = strength; level >= 1 && nc > 0; level--) {
      let nn = 0;
      for (let k = 0; k < nc; k++) {
        const i = cur[k];
        if (stab[i] !== level) continue;
        const x = i % W;
        const z = ((i / W) | 0) % D;
        const y = (i / L) | 0;
        for (let t = 0; t < N18.length; t++) {
          const o = N18[t];
          const nx = x + o[0];
          const ny = y + o[1];
          const nz = z + o[2];
          if (nx < 0 || ny < 0 || nz < 0 || nx >= W || ny >= H || nz >= D) continue;
          const j = nx + nz * W + ny * L;
          if (state[j] === 0) continue;
          const v = level - o[3];
          if (v <= stab[j]) continue;
          stab[j] = v;
          if (o[3] === 0) cur[nc++] = j;
          else nxt[nn++] = j;
        }
      }
      const t = cur;
      cur = nxt;
      nxt = t;
      nc = nn;
    }
    let nu = 0;
    const out = this.qa;
    for (let i = 0; i < N; i++) if (state[i] !== 0 && stab[i] === 0) out[nu++] = i;
    return nu;
  }

  // Group the n unsupported cells in qa[] into 18-connected clusters of at most
  // maxSize cells (big ones are cut into BFS-ordered chunks, which stay compact).
  clusters(n, maxSize) {
    const { W, H, D, L, state, mark, qa, qb } = this;
    for (let k = 0; k < n; k++) mark[qa[k]] = 1;
    const result = [];
    for (let k = 0; k < n; k++) {
      const seed = qa[k];
      if (mark[seed] !== 1) continue;
      mark[seed] = 2;
      let head = 0;
      let tail = 0;
      qb[tail++] = seed;
      while (head < tail) {
        const i = qb[head++];
        const x = i % W;
        const z = ((i / W) | 0) % D;
        const y = (i / L) | 0;
        for (let t = 0; t < N18.length; t++) {
          const o = N18[t];
          const nx = x + o[0];
          const ny = y + o[1];
          const nz = z + o[2];
          if (nx < 0 || ny < 0 || nz < 0 || nx >= W || ny >= H || nz >= D) continue;
          const j = nx + nz * W + ny * L;
          if (mark[j] !== 1 || state[j] === 0) continue;
          mark[j] = 2;
          qb[tail++] = j;
        }
      }
      for (let s = 0; s < tail; s += maxSize) result.push(qb.slice(s, Math.min(tail, s + maxSize)));
    }
    for (let k = 0; k < n; k++) mark[qa[k]] = 0;
    return result;
  }
}

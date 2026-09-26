import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { makeCubeMesh } from './cubes.js';
import { DT } from '../sim/sim.js';

// Palette: living cells run mint -> cyan -> azure -> deep blue with age; husks
// (dying states) are grey slate, so live tissue reads apart from dead
// scaffolding; anything in flight glows ember.
const AGE_STOPS = [
  [0, new THREE.Color('#9dffc9')],
  [3, new THREE.Color('#38e8ff')],
  [14, new THREE.Color('#3d8bff')],
  [48, new THREE.Color('#4a4dff')],
];
const HUSK_FRESH = new THREE.Color('#9aa3c7');
const HUSK_OLD = new THREE.Color('#2b2e44');
const EMBER = new THREE.Color('#ff8f3a');

function ageColor(age, out) {
  if (age >= AGE_STOPS[AGE_STOPS.length - 1][0]) return out.copy(AGE_STOPS[AGE_STOPS.length - 1][1]);
  for (let k = 1; k < AGE_STOPS.length; k++) {
    const [a1, c1] = AGE_STOPS[k];
    if (age <= a1) {
      const [a0, c0] = AGE_STOPS[k - 1];
      return out.copy(c0).lerp(c1, (age - a0) / (a1 - a0));
    }
  }
  return out;
}

// Colour for a cell of the given state/age under a rule with `states` states.
function cellColor(state, age, states, out) {
  if (state <= 1) return ageColor(age, out);
  const decay = (state - 2) / Math.max(1, states - 3);
  return out.copy(HUSK_FRESH).lerp(HUSK_OLD, Math.min(1, decay));
}

export class Renderer {
  constructor(canvas, sim) {
    this.sim = sim;
    this.canvas = canvas;
    const r = (this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' }));
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.25));
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    r.toneMapping = THREE.NeutralToneMapping; // keeps hues; ACES turned the palette muddy
    r.toneMappingExposure = 1.0;

    const { W, H, D } = sim;
    const scene = (this.scene = new THREE.Scene());
    scene.fog = new THREE.Fog('#141026', 90, 230); // near/far follow the zoom in render()
    this.sky = this.makeSky();
    scene.add(this.sky);

    const cam = (this.camera = new THREE.PerspectiveCamera(42, 1, 0.5, 600));
    cam.position.set(W * 0.5 + 52, 46, D * 0.5 + 60);
    const controls = (this.controls = new OrbitControls(cam, canvas));
    controls.target.set(W / 2 - 0.5, 5, D / 2 - 0.5);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.maxPolarAngle = Math.PI * 0.495;
    controls.minDistance = 12;
    controls.maxDistance = 170;
    controls.update();

    scene.add(new THREE.HemisphereLight('#9fb8ff', '#3a2a40', 1.1));
    const sun = (this.sun = new THREE.DirectionalLight('#fff1dc', 2.6));
    sun.position.set(W / 2 - 30, 70, D / 2 - 18);
    sun.target.position.set(W / 2, 0, D / 2);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const ext = Math.max(W, D) * 0.8;
    Object.assign(sun.shadow.camera, { left: -ext, right: ext, top: ext, bottom: -ext, near: 10, far: 200 });
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.03;
    scene.add(sun, sun.target);
    const rim = new THREE.DirectionalLight('#b48cff', 0.7);
    rim.position.set(W / 2 + 40, 25, D / 2 + 50);
    scene.add(rim);

    scene.add(this.makePlatform(W, D));

    this.cells = makeCubeMesh(W * H * D);
    // load may reach 2.5x the base budget and user tools double it again
    this.falling = makeCubeMesh(sim.p.maxDynamic * 5 + 64, { roughness: 0.45 });
    // falling cubes never pop in, slide or vanish: their animation slots are constant
    const FA = this.falling.attrs.anim.array;
    for (let k = 0; k < FA.length; k += 4) FA.set([-10, -10, 0, 0.15], k);
    scene.add(this.cells.mesh, this.falling.mesh);

    this.cursor = this.makeCursor();
    scene.add(this.cursor);

    this.builtVersion = -1;
    this.tmpColor = new THREE.Color();
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  makeSky() {
    const geo = new THREE.SphereGeometry(400, 32, 16);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {},
      vertexShader: /* glsl */ `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: /* glsl */ `varying vec3 vDir;
        void main(){
          float h = vDir.y;
          // linear-space colours (tone mapping + sRGB conversion follow)
          vec3 low = vec3(0.016, 0.010, 0.042), mid = vec3(0.060, 0.026, 0.125), top = vec3(0.004, 0.006, 0.022);
          vec3 c = h < 0.0 ? low : mix(mix(low, mid, smoothstep(0.0, 0.18, h)), top, smoothstep(0.18, 0.9, h));
          gl_FragColor = vec4(c, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    const sky = new THREE.Mesh(geo, mat);
    sky.renderOrder = -1;
    sky.frustumCulled = false; // it rides on the camera, see render()
    return sky;
  }

  makePlatform(W, D) {
    const group = new THREE.Group();
    const c = document.createElement('canvas');
    const px = 16;
    c.width = W * px;
    c.height = D * px;
    const g = c.getContext('2d');
    g.fillStyle = '#1d1a33';
    g.fillRect(0, 0, c.width, c.height);
    g.strokeStyle = 'rgba(160,150,255,0.10)';
    g.lineWidth = 1;
    for (let k = 0; k <= W; k++) {
      g.beginPath();
      g.moveTo(k * px + 0.5, 0);
      g.lineTo(k * px + 0.5, c.height);
      g.stroke();
    }
    for (let k = 0; k <= D; k++) {
      g.beginPath();
      g.moveTo(0, k * px + 0.5);
      g.lineTo(c.width, k * px + 0.5);
      g.stroke();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const top = new THREE.Mesh(
      new THREE.PlaneGeometry(W, D),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9, metalness: 0 }),
    );
    top.rotation.x = -Math.PI / 2;
    top.position.set(W / 2 - 0.5, -0.5, D / 2 - 0.5);
    top.receiveShadow = true;
    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(W, 3, D),
      new THREE.MeshStandardMaterial({ color: '#15122a', roughness: 0.8 }),
    );
    slab.position.set(W / 2 - 0.5, -2.01, D / 2 - 0.5);
    slab.receiveShadow = true;
    const edge = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(W, 3, D)),
      new THREE.LineBasicMaterial({ color: '#7d6cff', transparent: true, opacity: 0.35 }),
    );
    edge.position.copy(slab.position);
    group.add(slab, top, edge);
    return group;
  }

  makeCursor() {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.85, 1, 48),
      new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.55, depthTest: false, side: THREE.DoubleSide }),
    );
    ring.renderOrder = 10;
    ring.visible = false;
    return ring;
  }

  setCursor(hit, radius) {
    if (!hit) {
      this.cursor.visible = false;
      return;
    }
    const { point, normal } = hit;
    this.cursor.visible = true;
    this.cursor.position.set(point.x + normal.x * 0.05, point.y + normal.y * 0.05, point.z + normal.z * 0.05);
    this.cursor.lookAt(point.x + normal.x, point.y + normal.y, point.z + normal.z);
    this.cursor.scale.setScalar(radius);
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // Lattice -> instance buffers. Cells boxed in on all six faces are skipped.
  rebuildCells() {
    const sim = this.sim;
    const g = sim.grid;
    const { W, H, D, L, N } = g;
    const st = g.state;
    const { pos, col, anim, slide, heat } = this.cells.attrs;
    const HT = heat.array;
    const P = pos.array;
    const C = col.array;
    const A = anim.array;
    const S = slide.array;
    const c = this.tmpColor;
    const states = sim.rule.states;
    let n = 0;
    for (let i = 0; i < N; i++) {
      const s = st[i];
      if (s === 0) continue;
      const x = i % W;
      const z = ((i / W) | 0) % D;
      const y = (i / L) | 0;
      if (
        x > 0 && x < W - 1 && z > 0 && z < D - 1 && y > 0 && y < H - 1 &&
        st[i - 1] && st[i + 1] && st[i - W] && st[i + W] && st[i - L] && st[i + L]
      )
        continue;
      P[n * 3] = x;
      P[n * 3 + 1] = y;
      P[n * 3 + 2] = z;
      cellColor(s, g.age[i], states, c);
      C[n * 3] = c.r;
      C[n * 3 + 1] = c.g;
      C[n * 3 + 2] = c.b;
      A[n * 4] = sim.bornAt[i];
      A[n * 4 + 1] = sim.slideAt[i];
      A[n * 4 + 2] = 0;
      A[n * 4 + 3] = sim.slideDur[i];
      HT[n] = s === 1 && g.age[i] < 2 ? 0.28 - g.age[i] * 0.12 : 0; // newborns glow faintly
      S[n * 3] = sim.slide[i * 3];
      S[n * 3 + 1] = sim.slide[i * 3 + 1];
      S[n * 3 + 2] = sim.slide[i * 3 + 2];
      n++;
    }
    for (const gh of sim.ghosts) {
      if (n >= this.cells.capacity) break;
      const i = gh.i;
      if (st[i] !== 0) continue;
      P[n * 3] = i % W;
      P[n * 3 + 1] = (i / L) | 0;
      P[n * 3 + 2] = ((i / W) | 0) % D;
      cellColor(Math.max(gh.s, 2), gh.age, Math.max(states, 3), c);
      C[n * 3] = c.r;
      C[n * 3 + 1] = c.g;
      C[n * 3 + 2] = c.b;
      A[n * 4] = -10;
      A[n * 4 + 1] = -10;
      A[n * 4 + 2] = gh.t;
      A[n * 4 + 3] = 0.15;
      S[n * 3] = S[n * 3 + 1] = S[n * 3 + 2] = 0;
      HT[n] = 0;
      n++;
    }
    this.cells.commit(n, ['pos', 'col', 'anim', 'slide', 'heat']);
    this.cellCount = n;
  }

  updateFalling() {
    const sim = this.sim;
    const { pos, quat, col, heat: hv } = this.falling.attrs;
    const P = pos.array;
    const Q = quat.array;
    const C = col.array;
    const Hh = hv.array;
    const c = this.tmpColor;
    const states = sim.rule.states;
    const cap = this.falling.capacity;
    const o = [0, 0, 0];
    const t = { x: 0, y: 0, z: 0 };
    const q = { x: 0, y: 0, z: 0, w: 1 };
    const alpha = Math.min(1, sim.acc / DT);
    let n = 0;
    for (const b of sim.bodies) {
      const rb = b.rb;
      const ct = rb.translation();
      const cq = rb.rotation();
      if (b.pt) {
        // pose between the last two physics steps
        t.x = b.pt.x + (ct.x - b.pt.x) * alpha;
        t.y = b.pt.y + (ct.y - b.pt.y) * alpha;
        t.z = b.pt.z + (ct.z - b.pt.z) * alpha;
        const p = b.pq;
        const sgn = p.x * cq.x + p.y * cq.y + p.z * cq.z + p.w * cq.w < 0 ? -1 : 1;
        q.x = p.x + (cq.x * sgn - p.x) * alpha;
        q.y = p.y + (cq.y * sgn - p.y) * alpha;
        q.z = p.z + (cq.z * sgn - p.z) * alpha;
        q.w = p.w + (cq.w * sgn - p.w) * alpha;
        const l = Math.hypot(q.x, q.y, q.z, q.w);
        q.x /= l;
        q.y /= l;
        q.z /= l;
        q.w /= l;
      } else {
        Object.assign(t, ct);
        Object.assign(q, cq);
      }
      const v = rb.linvel();
      const heat = Math.min(1, Math.hypot(v.x, v.y, v.z) / 14);
      for (let k = 0; k < b.n && n < cap; k++) {
        sim.worldPos(b, k, t, q, o);
        P[n * 3] = o[0];
        P[n * 3 + 1] = o[1];
        P[n * 3 + 2] = o[2];
        Q[n * 4] = q.x;
        Q[n * 4 + 1] = q.y;
        Q[n * 4 + 2] = q.z;
        Q[n * 4 + 3] = q.w;
        cellColor(b.states[k], b.ages[k], states, c).lerp(EMBER, 0.5 + 0.45 * heat);
        C[n * 3] = c.r;
        C[n * 3 + 1] = c.g;
        C[n * 3 + 2] = c.b;
        Hh[n] = 0.15 + heat * 0.9;
        n++;
      }
    }
    this.falling.commit(n, ['pos', 'quat', 'col', 'heat']);
  }

  render() {
    const sim = this.sim;
    if (sim.version !== this.builtVersion) {
      this.rebuildCells();
      this.builtVersion = sim.version;
    }
    this.updateFalling();
    this.cells.setTime(sim.time);
    this.falling.setTime(sim.time);
    this.controls.update();
    // The sky dome is centred on the camera, so zooming out never pushes its far
    // side past the far plane (that clipped a black disc into the sky). Fog is
    // relative to the zoom: a light depth cue across the platform at any distance.
    this.sky.position.copy(this.camera.position);
    const d = this.camera.position.distanceTo(this.controls.target);
    this.scene.fog.near = d;
    this.scene.fog.far = d + 160;
    this.renderer.render(this.scene, this.camera);
  }

  // Screen point -> world ray.
  ray(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, this.camera);
    const { origin, direction } = rc.ray;
    return { origin: { x: origin.x, y: origin.y, z: origin.z }, dir: { x: direction.x, y: direction.y, z: direction.z } };
  }
}

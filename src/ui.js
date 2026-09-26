import { PRESETS, parseRule } from './sim/rules.js';

const TOOLS = {
  pillar: { radius: 1.4 },
  meteor: { radius: 2.5 },
  blast: { radius: 4 },
  sow: { radius: 3 },
};

const $ = (id) => document.getElementById(id);
const fmt = new Intl.NumberFormat('en-US');

export class UI {
  constructor(sim, view, loop) {
    this.sim = sim;
    this.view = view;
    this.loop = loop;
    this.tool = 'pillar';
    this.mouse = null;
    this.down = null;
    this.frames = 0;
    this.fpsClock = 0;

    const rule = $('rule');
    for (const p of PRESETS) rule.add(new Option(`${p.name}  ·  ${p.rule}`, p.id));
    rule.add(new Option('Custom', 'custom'));
    rule.value = sim.preset ? sim.preset.id : 'custom';
    rule.addEventListener('change', () => {
      if (rule.value === 'custom') {
        $('ruleText').focus();
        return;
      }
      this.applyRule(rule.value, true);
    });
    const text = $('ruleText');
    text.value = sim.rule.text;
    text.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key !== 'Enter') return;
      try {
        parseRule(text.value);
      } catch (err) {
        text.classList.add('bad');
        text.title = String(err.message);
        return;
      }
      text.classList.remove('bad');
      this.applyRule(text.value, true);
    });

    this.slider('speed', () => sim.p.tickRate, (v) => (sim.p.tickRate = v), (v) => `${v}/s`);
    this.slider('grip', () => sim.p.strength, (v) => {
      sim.p.strength = v;
      sim.supportDirty = true;
    }, (v) => (v >= 13 ? '∞' : String(v)));
    // "Brittle" is the inverse of the shatter threshold: higher breaks more easily.
    this.slider('brittle', () => 13 - sim.p.shatter, (v) => {
      sim.p.shatter = 13 - v;
      sim.p.knock = sim.p.shatter + 2;
    }, (v) => String(v));
    this.slider('gravity', () => sim.p.gravity, (v) => sim.setGravity(v), (v) => String(v));

    const met = $('meteors');
    met.checked = sim.p.meteors;
    met.addEventListener('change', () => (sim.p.meteors = met.checked));

    $('play').addEventListener('click', () => this.togglePlay());
    $('step').addEventListener('click', () => this.step());
    $('soup').addEventListener('click', () => sim.reset());
    $('clear').addEventListener('click', () => sim.clearAll());
    $('collapse').addEventListener('click', () => this.togglePanel());

    for (const b of document.querySelectorAll('#tools button')) b.addEventListener('click', () => this.setTool(b.dataset.tool));
    this.setTool(this.tool);

    const canvas = view.canvas;
    canvas.addEventListener('pointermove', (e) => (this.mouse = { x: e.clientX, y: e.clientY }));
    canvas.addEventListener('pointerleave', () => (this.mouse = null));
    canvas.addEventListener('pointerdown', (e) => {
      this.down = { x: e.clientX, y: e.clientY, t: performance.now(), button: e.button };
    });
    canvas.addEventListener('pointerup', (e) => {
      const d = this.down;
      this.down = null;
      if (!d || d.button !== 0 || e.button !== 0) return;
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6 || performance.now() - d.t > 450) return;
      this.useTool(e.clientX, e.clientY);
    });
    window.addEventListener('keydown', (e) => this.key(e));
    this.syncPlay();
    if (window.innerWidth <= 720) this.togglePanel(); // on phones the full panel covers the world
  }

  slider(id, get, set, label) {
    const el = $(id);
    const out = $(`${id}Out`);
    el.value = String(get());
    out.textContent = label(Number(el.value));
    el.addEventListener('input', () => {
      const v = Number(el.value);
      set(v);
      out.textContent = label(v);
    });
  }

  applyRule(idOrText, reseed) {
    const sim = this.sim;
    sim.setRule(idOrText);
    $('rule').value = sim.preset ? sim.preset.id : 'custom';
    $('ruleText').value = sim.rule.text;
    $('ruleNote').textContent = sim.preset ? sim.preset.note : 'custom rule';
    if (reseed) sim.reset();
  }

  setTool(name) {
    this.tool = name;
    for (const b of document.querySelectorAll('#tools button')) b.classList.toggle('on', b.dataset.tool === name);
  }

  togglePlay() {
    this.sim.running = !this.sim.running;
    this.syncPlay();
  }

  syncPlay() {
    const b = $('play');
    b.textContent = this.sim.running ? 'Pause' : 'Play';
    b.classList.toggle('on', !this.sim.running);
    $('ruleNote').textContent = this.sim.preset ? this.sim.preset.note : 'custom rule';
  }

  step() {
    this.sim.running = false;
    this.sim.tick();
    this.syncPlay();
  }

  togglePanel() {
    const p = $('panel');
    p.classList.toggle('collapsed');
    $('collapse').textContent = p.classList.contains('collapsed') ? '+' : '–';
  }

  key(e) {
    if (e.target instanceof HTMLInputElement && !['range', 'checkbox'].includes(e.target.type)) return;
    if (e.target instanceof HTMLSelectElement) return;
    const k = e.key.toLowerCase();
    if (k === ' ') {
      e.preventDefault();
      this.togglePlay();
    } else if (k === 'n') this.step();
    else if (k === 'r') this.sim.reset();
    else if (k === 'c') this.sim.clearAll();
    else if (k === 'h') this.togglePanel();
    else if (k === 'g') this.loop.cap30 = !this.loop.cap30;
    else if (k === 'm') {
      this.sim.p.meteors = !this.sim.p.meteors;
      $('meteors').checked = this.sim.p.meteors;
    } else if (k >= '1' && k <= '4') this.setTool(Object.keys(TOOLS)[Number(k) - 1]);
  }

  hit(x, y) {
    const { origin, dir } = this.view.ray(x, y);
    return this.sim.pick(origin, dir);
  }

  useTool(x, y) {
    const h = this.hit(x, y);
    if (!h) return;
    const sim = this.sim;
    const { point: p, normal: n } = h;
    const W = sim.W;
    const D = sim.D;
    const cx = Math.min(W - 1, Math.max(0, p.x));
    const cz = Math.min(D - 1, Math.max(0, p.z));
    if (this.tool === 'pillar') sim.dropPillar(cx, cz, undefined, true);
    else if (this.tool === 'meteor') sim.dropMeteor(cx, cz, 4 + Math.floor(Math.random() * 3), true);
    else if (this.tool === 'blast') sim.blast(p.x - n.x * 0.5, p.y - n.y * 0.5, p.z - n.z * 0.5, TOOLS.blast.radius);
    else if (this.tool === 'sow') sim.sow(p.x + n.x * 2, p.y + n.y * 2, p.z + n.z * 2, TOOLS.sow.radius);
  }

  update(dt) {
    const sim = this.sim;
    this.view.setCursor(this.mouse && !this.down ? this.hit(this.mouse.x, this.mouse.y) : null, TOOLS[this.tool].radius);
    this.frames++;
    this.fpsClock += dt;
    if (this.fpsClock >= 0.5) {
      $('sGen').textContent = fmt.format(sim.gen);
      $('sLive').textContent = fmt.format(sim.grid.population());
      $('sFall').textContent = fmt.format(sim.nDynamic);
      $('fps').textContent = `${Math.round(this.frames / this.fpsClock)} fps${this.loop.cap30 ? ' (cap 30, G)' : ''}`;
      this.frames = 0;
      this.fpsClock = 0;
    }
  }
}

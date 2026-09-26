// 3D cellular-automaton rules in "survive/birth/states/neighbourhood" notation,
// e.g. "4/4/5/M": survive with 4 live neighbours, birth with 4, 5 states, Moore.
// States: 0 empty, 1 alive, 2..states-1 dying (still solid, not counted as live).

export function parseRule(text) {
  const parts = text.trim().split('/');
  if (parts.length !== 4) throw new Error(`rule needs 4 parts: ${text}`);
  const [s, b, c, n] = parts;
  const hood = n.trim().toUpperCase();
  if (hood !== 'M' && hood !== 'VN') throw new Error(`neighbourhood must be M or VN: ${text}`);
  const states = Number.parseInt(c, 10);
  if (!(states >= 2 && states <= 250)) throw new Error(`states must be 2..250: ${text}`);
  const max = hood === 'M' ? 26 : 6;
  return { text: `${s}/${b}/${states}/${hood}`, survive: mask(s, max), birth: mask(b, max), states, hood };
}

function mask(list, max) {
  const m = new Uint8Array(27);
  for (const tok of list.split(',')) {
    const t = tok.trim();
    if (!t) continue;
    const [lo, hi] = t.split('-').map((v) => Number.parseInt(v, 10));
    const top = hi === undefined ? lo : hi;
    if (!Number.isInteger(lo) || !Number.isInteger(top) || lo < 0 || top > max || top < lo) throw new Error(`bad range "${t}"`);
    for (let k = lo; k <= top; k++) m[k] = 1;
  }
  return m;
}

// Picked from headless runs with gravity on (tools/tune.mjs). Most classic 3D
// rules either die at once under gravity (445, Clouds, Bays 5766) or fill the
// whole box (Amoeba, Coral, Pulse Waves), which also buries the physics.
export const PRESETS = [
  { id: 'pyro', name: 'Pyroclastic', rule: '4-7/6-8/10/M', note: 'spires grow on long-lived husks, then cave in' },
  { id: 'architecture', name: 'Architecture', rule: '4-6/3/2/M', note: 'restless foam, constant rockfall (heavy)' },
  { id: 'builder', name: 'Builder', rule: '2,6,9/4,6,8-9/10/M', note: 'towers shoot up to the ceiling and crash' },
];

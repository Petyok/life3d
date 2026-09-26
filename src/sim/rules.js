// 3D cellular-automaton rules in "survive/birth/states/neighborhood" notation,
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
  return { text, survive: mask(s, max), birth: mask(b, max), states, hood };
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

// Presets picked by headless runs with gravity on (tools/tune.mjs).
export const PRESETS = [
  { id: '445', name: '445', rule: '4/4/5/M', note: 'crystal clusters with slow decay' },
  { id: 'pyro', name: 'Pyroclastic', rule: '4-7/6-8/10/M', note: 'bursting growth, long-lived husks' },
  { id: 'coral', name: 'Coral', rule: '5-8/6-7,9,12/4/M', note: 'branching reef' },
  { id: 'builder', name: 'Builder', rule: '2,6,9/4,6,8-9/10/M', note: 'towers and scaffolding' },
  { id: 'clouds', name: 'Clouds', rule: '13-26/13-14,17-19/2/M', note: 'blobs that swell and cave in' },
  { id: 'amoeba', name: 'Amoeba', rule: '9-26/5-7,12-13,15/5/M', note: 'fast-growing mass' },
  { id: 'bays', name: 'Bays 5766', rule: '5-7/6/2/M', note: 'classic 3D Life' },
];

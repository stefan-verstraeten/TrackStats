// Paired measurements on two sides, e.g. blood pressure on the left and right arm.
//
// A "sided" measurement tracker has every value twice: fields carry { side: 'L' | 'R', base: <base id> }.
// Right-arm fields keep the original field ids, so values recorded before sides existed
// (or restored from an older backup) automatically belong to the right arm.
// Left-arm fields get the id 'L_' + base id.

export const SIDES = [
  { id: 'L', name: 'Left arm', short: 'L' },
  { id: 'R', name: 'Right arm', short: 'R' },
];

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export const isSided = (t) => t?.type === 'number' && Array.isArray(t.sides) && t.sides.length === 2;

/** The values without side (the right-arm fields of a sided tracker). */
export function baseFields(t) {
  return isSided(t) ? t.fields.filter((f) => f.side === 'R') : t.fields || [];
}

export function sideFields(t, side) {
  return t.fields.filter((f) => f.side === side);
}

/** [{ base, name, unit, decimals, targetMin, targetMax, L: field, R: field }] */
export function pairs(t) {
  return baseFields(t).map((r) => {
    const base = r.base || r.id;
    return { ...r, base, R: r, L: t.fields.find((f) => f.side === 'L' && f.base === base) };
  });
}

/** Full left + right field list from base fields (right side keeps the base ids). */
export function sidedFields(base) {
  const clean = base.map(({ side, base: b, ...f }) => f);
  return [
    ...clean.map((f) => ({ ...f, id: 'L_' + f.id, side: 'L', base: f.id })),
    ...clean.map((f) => ({ ...f, side: 'R', base: f.id })),
  ];
}

/** Convert a plain measurement tracker to left/right. Existing values become the right side. */
export function makeSided(t, deltaAlert = 10) {
  return {
    ...t,
    sides: SIDES.map((s) => ({ ...s })),
    fields: sidedFields(baseFields(t)),
    deltaAlert: isNum(t.deltaAlert) ? t.deltaAlert : deltaAlert,
  };
}

/** Pairs whose arm difference is checked against the alert: same unit as the first value (e.g. mmHg, not bpm). */
export function deltaPairs(t) {
  const p = pairs(t);
  return p.filter((x) => x.L && x.unit === p[0]?.unit);
}

/** Right − left per base value for one entry (only where both sides were measured). */
export function entryDeltas(t, e) {
  const out = {};
  for (const p of pairs(t)) {
    const l = e.values?.[p.L?.id];
    const r = e.values?.[p.R.id];
    if (isNum(l) && isNum(r)) out[p.base] = r - l;
  }
  return out;
}

/** Delta points per base over a list of entries: { [base]: [{t, v}] } oldest first. */
export function deltaPoints(t, entries) {
  const out = {};
  for (const p of pairs(t)) out[p.base] = [];
  for (const e of entries) {
    const d = entryDeltas(t, e);
    for (const [base, v] of Object.entries(d)) out[base].push({ t: new Date(e.ts), v });
  }
  for (const k of Object.keys(out)) out[k].sort((a, b) => a.t - b.t);
  return out;
}

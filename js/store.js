// Local data store. Everything lives on the device in localStorage.
//
// Tracker: { id, name, icon, color, type, order, createdAt, ...typeOptions }
//   type 'number' -> fields: [{ id, name, unit, decimals, targetMin, targetMax }]
//   type 'scale'  -> scaleMin, scaleMax, lowLabel, highLabel
//   type 'count'  -> unit, dailyGoal
//   type 'check'  -> (yes / no per day)
// Entry: { id, trackerId, ts (ISO string), values: { [fieldId]: number }, note }
//   Non-number trackers store their single value under field id 'v'.

const KEY = 'trackstats.v1';
const listeners = new Set();
let state = load();

function empty() {
  return { version: 1, trackers: [], entries: [] };
}

function valid(s) {
  return s && Array.isArray(s.trackers) && Array.isArray(s.entries);
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw);
      if (valid(s)) return s;
    }
  } catch (err) {
    console.error('TrackStats: could not load data', err);
  }
  return empty();
}

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (err) {
    console.error(err);
    alert('Could not save: device storage is full or unavailable. Export your data to be safe.');
  }
  listeners.forEach((fn) => fn());
}

export function onChange(fn) {
  listeners.add(fn);
}

export function uid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

// ---- trackers ----

export function trackers() {
  return state.trackers.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

export function tracker(id) {
  return state.trackers.find((t) => t.id === id);
}

/** The value fields of a tracker (non-number trackers have one implicit field 'v'). */
export function fieldsOf(t) {
  if (t.type === 'number') return t.fields || [];
  if (t.type === 'scale') return [{ id: 'v', name: t.name, unit: '', decimals: 1 }];
  return [{ id: 'v', name: t.name, unit: t.unit || '', decimals: 0 }];
}

export function saveTracker(t) {
  const i = state.trackers.findIndex((x) => x.id === t.id);
  if (i >= 0) {
    state.trackers[i] = t;
  } else {
    t.order = state.trackers.reduce((m, x) => Math.max(m, x.order ?? 0), -1) + 1;
    t.createdAt ||= new Date().toISOString();
    state.trackers.push(t);
  }
  persist();
}

export function deleteTracker(id) {
  state.trackers = state.trackers.filter((t) => t.id !== id);
  state.entries = state.entries.filter((e) => e.trackerId !== id);
  persist();
}

export function moveTracker(id, dir) {
  const list = trackers();
  list.forEach((t, k) => (t.order = k));
  const i = list.findIndex((t) => t.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return;
  [list[i].order, list[j].order] = [list[j].order, list[i].order];
  persist();
}

// ---- entries ----

/** Entries, newest first. Optionally only those of one tracker. */
export function entries(trackerId) {
  const list = trackerId ? state.entries.filter((e) => e.trackerId === trackerId) : state.entries.slice();
  return list.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
}

export function entry(id) {
  return state.entries.find((e) => e.id === id);
}

export function saveEntry(e) {
  const i = state.entries.findIndex((x) => x.id === e.id);
  if (i >= 0) state.entries[i] = e;
  else state.entries.push(e);
  persist();
}

/** Save several new entries with a single write. */
export function saveEntries(list) {
  state.entries.push(...list);
  persist();
}

export function deleteEntry(id) {
  state.entries = state.entries.filter((e) => e.id !== id);
  persist();
}

// ---- backup ----

export function exportData() {
  return {
    app: 'TrackStats',
    version: state.version,
    exportedAt: new Date().toISOString(),
    trackers: state.trackers,
    entries: state.entries,
  };
}

// ---- matching trackers by name (restore + duplicate merge) ----

const norm = (s) => String(s || '').trim().toLowerCase();
const sameTracker = (a, b) => a.type === b.type && norm(a.name) === norm(b.name);

/**
 * Map a source tracker's field ids onto a target tracker's fields, by value name and arm.
 * Values without an arm belong to the right arm (that is how data from before left/right is treated).
 */
function fieldMap(target, source) {
  const map = {};
  if (target.type !== 'number') return map; // single value 'v'
  const sided = Array.isArray(target.sides);
  for (const f of source.fields || []) {
    const side = sided ? f.side || 'R' : undefined;
    const hit = (target.fields || []).find((k) => norm(k.name) === norm(f.name) && (!sided || k.side === side));
    map[f.id] = hit ? hit.id : f.id;
  }
  return map;
}

function moveEntry(e, targetId, map) {
  const values = {};
  for (const [k, v] of Object.entries(e.values || {})) values[map[k] ?? k] = v;
  return { ...e, trackerId: targetId, values };
}

/** Drop exact duplicates (same tracker, time, values and type), e.g. after restoring the same data twice. */
function dedupeEntries(list) {
  const seen = new Set();
  return list.filter((e) => {
    const key = [e.trackerId, e.ts, JSON.stringify(Object.entries(e.values || {}).sort()), e.kind || ''].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Groups of trackers with the same name and type: [[a, b], ...]. */
export function duplicateGroups() {
  const groups = new Map();
  for (const t of trackers()) {
    const k = t.type + '|' + norm(t.name);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}

/**
 * Merge trackers with the same name and type into one. The one with the most entries is kept;
 * the others' entries move to it (values matched by name and arm). Nothing is deleted except exact duplicates.
 */
export function mergeDuplicates() {
  let merged = 0;
  const count = (id) => state.entries.filter((e) => e.trackerId === id).length;
  for (const group of duplicateGroups()) {
    group.sort((a, b) => count(b.id) - count(a.id) || (a.order ?? 0) - (b.order ?? 0));
    const [keep, ...dups] = group;
    for (const d of dups) {
      const map = fieldMap(keep, d);
      if (keep.type === 'number') {
        for (const f of d.fields || []) if (!keep.fields.some((k) => k.id === map[f.id])) keep.fields.push({ ...f });
      }
      state.entries = state.entries.map((e) => (e.trackerId === d.id ? moveEntry(e, keep.id, map) : e));
      state.trackers = state.trackers.filter((t) => t.id !== d.id);
      merged++;
    }
  }
  state.entries = dedupeEntries(state.entries);
  persist();
  return merged;
}

/**
 * Merge a backup into the current data. Items with the same id are overwritten.
 * A backup tracker that has a different id but the same name and type as an existing tracker
 * is folded into the existing one, so restoring never creates duplicates.
 */
export function importData(data) {
  if (!valid(data)) throw new Error('This file is not a TrackStats backup.');
  const byId = (list) => new Map(list.map((x) => [x.id, x]));
  const t = byId(state.trackers);
  const redirect = new Map(); // backup tracker id -> { id, map }
  for (const x of data.trackers) {
    if (!x.id) continue;
    if (!t.has(x.id)) {
      const same = [...t.values()].find((k) => sameTracker(k, x));
      if (same) {
        redirect.set(x.id, { id: same.id, map: fieldMap(same, x) });
        continue;
      }
    }
    t.set(x.id, x);
  }
  const e = byId(state.entries);
  for (const x of data.entries) {
    if (!x.id || !x.trackerId || !x.ts) continue;
    const r = redirect.get(x.trackerId);
    e.set(x.id, r ? moveEntry(x, r.id, r.map) : x);
  }
  state.trackers = [...t.values()];
  state.entries = dedupeEntries([...e.values()]);
  persist();
  return { trackers: data.trackers.length, entries: data.entries.length };
}

export function eraseAll() {
  state = empty();
  persist();
}

export function counts() {
  return { trackers: state.trackers.length, entries: state.entries.length };
}

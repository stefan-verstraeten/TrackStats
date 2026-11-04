// Pure date and statistics helpers (no DOM, no storage).

const pad = (n) => String(n).padStart(2, '0');

export function dayKey(d) {
  d = new Date(d);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function endOfDay(d) {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

export function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/** Each local day from start to end (inclusive) as Date at midnight. */
export function eachDay(start, end) {
  const days = [];
  for (let d = startOfDay(start); d <= end; d = addDays(d, 1)) days.push(d);
  return days;
}

/** Start of the period: range is a number of days, or 'all'. */
export function rangeStart(range, entries) {
  const today = startOfDay(new Date());
  if (range === 'all') {
    if (!entries.length) return addDays(today, -6);
    const first = entries.reduce((m, e) => (e.ts < m ? e.ts : m), entries[0].ts);
    const s = startOfDay(first);
    return s < today ? s : addDays(today, -6);
  }
  return addDays(today, -(range - 1));
}

export function inPeriod(entries, start, end) {
  return entries.filter((e) => {
    const t = new Date(e.ts);
    return t >= start && t <= end;
  });
}

const num = (v) => typeof v === 'number' && Number.isFinite(v);

/** Points {t: Date, v: number} of one field, oldest first. */
export function points(entries, fieldId) {
  return entries
    .map((e) => ({ t: new Date(e.ts), v: e.values?.[fieldId] }))
    .filter((p) => num(p.v))
    .sort((a, b) => a.t - b.t);
}

/** Summary of a measured field: count, mean, min, max, latest, change, sd, share within target. */
export function fieldStats(pts, field = {}) {
  if (!pts.length) return null;
  const vals = pts.map((p) => p.v);
  const n = vals.length;
  const mean = vals.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(vals.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1)) : 0;
  const lo = num(field.targetMin) ? field.targetMin : -Infinity;
  const hi = num(field.targetMax) ? field.targetMax : Infinity;
  const hasTarget = lo !== -Infinity || hi !== Infinity;
  return {
    n,
    mean,
    sd,
    min: Math.min(...vals),
    max: Math.max(...vals),
    first: vals[0],
    latest: vals[n - 1],
    change: vals[n - 1] - vals[0],
    inTarget: hasTarget ? vals.filter((v) => v >= lo && v <= hi).length / n : null,
  };
}

/** Average per local day, for smoothing dense series. */
export function dailyMeans(pts) {
  const map = new Map();
  for (const p of pts) {
    const k = dayKey(p.t);
    const cur = map.get(k) || { sum: 0, n: 0, t: startOfDay(p.t) };
    cur.sum += p.v;
    cur.n += 1;
    map.set(k, cur);
  }
  return [...map.values()].map((d) => ({ t: new Date(d.t.getTime() + 12 * 3600e3), v: d.sum / d.n }));
}

/** Sum per day over [start, end] (days without entries are 0). */
export function dailyTotals(entries, start, end, fieldId = 'v') {
  const map = new Map();
  for (const e of entries) {
    const v = e.values?.[fieldId];
    if (!num(v)) continue;
    const k = dayKey(e.ts);
    map.set(k, (map.get(k) || 0) + v);
  }
  return eachDay(start, end).map((d) => ({ t: d, v: map.get(dayKey(d)) || 0 }));
}

/** Group daily values into weeks (summed). */
export function weekly(days) {
  const out = [];
  for (let i = 0; i < days.length; i += 7) {
    const chunk = days.slice(i, i + 7);
    out.push({ t: chunk[0].t, v: chunk.reduce((a, d) => a + d.v, 0), days: chunk.length });
  }
  return out;
}

export function countStats(days, goal) {
  const total = days.reduce((a, d) => a + d.v, 0);
  const active = days.filter((d) => d.v > 0).length;
  return {
    total,
    perDay: days.length ? total / days.length : 0,
    best: days.reduce((m, d) => Math.max(m, d.v), 0),
    activeDays: active,
    goalDays: goal > 0 ? days.filter((d) => d.v >= goal).length : null,
    days: days.length,
  };
}

/** Set of day keys marked "yes" (any entry with value 1 that day). */
export function doneDays(entries) {
  const set = new Set();
  for (const e of entries) if (e.values?.v === 1) set.add(dayKey(e.ts));
  return set;
}

export function checkStats(allEntries, start, end) {
  const done = doneDays(allEntries);
  const days = eachDay(start, end);
  const hit = days.filter((d) => done.has(dayKey(d))).length;

  // Current streak: today counts if done; if not done yet, the streak up to yesterday is kept.
  let streak = 0;
  let d = startOfDay(new Date());
  if (!done.has(dayKey(d))) d = addDays(d, -1);
  while (done.has(dayKey(d))) {
    streak++;
    d = addDays(d, -1);
  }

  // Best streak over all time.
  const keys = [...done].sort();
  let best = 0;
  let run = 0;
  let prev = null;
  for (const k of keys) {
    const cur = new Date(k + 'T12:00:00');
    run = prev && dayKey(addDays(prev, 1)) === k ? run + 1 : 1;
    best = Math.max(best, run);
    prev = cur;
  }

  return { days: days.length, done: hit, pct: days.length ? hit / days.length : 0, streak, best, doneSet: done };
}

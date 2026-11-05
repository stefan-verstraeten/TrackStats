import * as store from './store.js';
import * as S from './stats.js';
import { lineChart, barChart, calendar, overviewChart } from './charts.js';
import { isSided, sideFields, pairs, deltaPairs, entryDeltas, deltaPoints, makeSided, sidedFields, baseFields } from './sides.js';

// ---------- helpers ----------

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const num = (v) => typeof v === 'number' && Number.isFinite(v);
const parseNum = (s) => {
  if (s == null) return null;
  const v = parseFloat(String(s).replace(',', '.'));
  return Number.isFinite(v) ? v : null;
};
const fmt = (v, dp = 0) => (num(v) ? v.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp }) : '–');
const pct = (v) => (num(v) ? `${Math.round(v * 100)}%` : '–');
const pad = (n) => String(n).padStart(2, '0');
const toLocalInput = (d) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const timeOf = (d) => d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

function dayLabel(d) {
  const k = S.dayKey(d);
  if (k === S.dayKey(new Date())) return 'Today';
  if (k === S.dayKey(S.addDays(new Date(), -1))) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}

function relTime(d) {
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  return `${dayLabel(d)}, ${timeOf(d)}`;
}

export const COLORS = ['#0d9488', '#2563eb', '#db2777', '#d97706', '#7c3aed', '#059669', '#dc2626', '#0891b2'];
const TYPE_LABEL = { number: 'Measurement', scale: 'Scale', count: 'Counter', check: 'Yes / No' };

/** Counters that record what each item was (e.g. liquid intake: water, coffee…). */
const hasKinds = (t) => t.type === 'count' && !!t.trackKind;
const DEFAULT_DRINKS = ['Water', 'Coffee', 'Tea', 'Milk', 'Juice', 'Soft drink', 'Soup', 'Alcohol'];
const kindLabel = (e) => e.kind || 'Unspecified';

/** Amount a counter adds per tap (e.g. 250 ml). */
const stepOf = (t) => (num(t.step) && t.step > 0 ? t.step : 1);

/** Color for field i of a tracker: first field uses the tracker color. */
function seriesColor(t, i) {
  if (i === 0) return t.color;
  const rest = COLORS.filter((c) => c !== t.color);
  return rest[(i - 1) % rest.length];
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

// ---------- UI state (remembered per device) ----------

const UI_KEY = 'trackstats.ui';
const DASH_RANGE_VALUES = [3, 7, 30, 90, 365, 'all'];
const ui = Object.assign(
  { tab: 'today', dashMode: 'day', dashRange: 7, dashDay: null, tableAll: false, ovHidden: [], historyFilter: 'all', historyLimit: 150 },
  (() => {
    try {
      return JSON.parse(localStorage.getItem(UI_KEY)) || {};
    } catch {
      return {};
    }
  })()
);
ui.historyLimit = 150;
ui.dashDay = null; // dashboard always opens on today
if (ui.tab === 'stats') ui.tab = 'dashboard';
if (!DASH_RANGE_VALUES.includes(ui.dashRange)) ui.dashRange = 7;
function saveUi() {
  try {
    localStorage.setItem(UI_KEY, JSON.stringify({ tab: ui.tab, dashMode: ui.dashMode, dashRange: ui.dashRange, ovHidden: ui.ovHidden, historyFilter: ui.historyFilter }));
  } catch {
    /* ignore */
  }
}

// ---------- value formatting ----------

/** "128/82 mmHg · 64 bpm" style text for one entry. */
function formatEntry(t, e, units = true) {
  const v = e.values || {};
  switch (t.type) {
    case 'check':
      return v.v === 1 ? 'Yes' : 'No';
    case 'count':
      return `${fmt(v.v)}${units && t.unit ? ' ' + esc(t.unit) : ''}${units && e.kind ? ' · ' + esc(e.kind) : ''}`;
    case 'scale':
      return units ? `${fmt(v.v)} / ${t.scaleMax}` : fmt(v.v);
    default: {
      if (isSided(t)) {
        // "[L] 128/82 · 66  [R] 131/85 · 68" with coloured arm badges
        const parts = t.sides.map((s) => {
          const txt = valuesText(sideFields(t, s.id), v, false);
          return txt ? `${armBadge(s)}${txt}` : '';
        });
        return parts.filter(Boolean).join(' ') || '–';
      }
      return valuesText(store.fieldsOf(t), v, units) || '–';
    }
  }
}

const armBadge = (s) => `<b class="arm arm-${s.id}" title="${esc(s.name)}">${esc(s.short)}</b>`;

/** "128/82 mmHg · 66 bpm": consecutive values with the same unit are joined with "/". */
function valuesText(fields, v, units = true) {
  const groups = [];
  for (const f of fields) {
    if (!num(v[f.id])) continue;
    const last = groups[groups.length - 1];
    const val = fmt(v[f.id], f.decimals);
    if (last && last.unit === f.unit && f.unit) last.vals.push(val);
    else groups.push({ unit: f.unit, vals: [val] });
  }
  return groups.map((g) => g.vals.join('/') + (units && g.unit ? ' ' + esc(g.unit) : '')).join(' · ');
}

function todaySummary(t) {
  const list = store.entries(t.id);
  const todayKey = S.dayKey(new Date());
  const today = list.filter((e) => S.dayKey(e.ts) === todayKey);
  if (t.type === 'count') {
    const sum = today.reduce((a, e) => a + (e.values?.v || 0), 0);
    const goal = t.dailyGoal > 0 ? ` of ${fmt(t.dailyGoal)}` : '';
    const items = hasKinds(t) && today.length ? ` · ${plural(today.length, 'drink', 'drinks')}` : '';
    return { text: `Today: <b>${fmt(sum)}</b>${goal}${t.unit ? ' ' + esc(t.unit) : ''}${items}`, done: t.dailyGoal > 0 && sum >= t.dailyGoal };
  }
  if (t.type === 'check') {
    const yes = today.some((e) => e.values?.v === 1);
    const { streak } = S.checkStats(list, S.startOfDay(new Date()), S.endOfDay(new Date()));
    const st = streak > 1 ? ` · ${streak}-day streak` : '';
    return { text: (yes ? '<b>Done today</b>' : 'Not yet today') + st, done: yes };
  }
  if (t.type === 'scale' && t.defaultZero) {
    const v = scaleVals(today);
    return { text: `Today: <b>${v.length ? Math.max(...v) : 0}</b> / ${t.scaleMax}${v.length ? '' : ' · none logged'}`, done: v.length > 0 };
  }
  if (!list.length) return { text: 'No entries yet' };
  const last = list[0];
  return { text: `<b>${formatEntry(t, last)}</b> · ${relTime(new Date(last.ts))}`, done: today.length > 0 };
}

// ---------- rendering ----------

const view = $('#view');

function setTop(title, actions = '') {
  $('#view-title').textContent = title;
  $('#top-actions').innerHTML = actions;
}

function render() {
  $$('.tabbar button').forEach((b) => b.setAttribute('aria-current', b.dataset.tab === ui.tab ? 'page' : 'false'));
  const views = { today: renderToday, dashboard: renderDashboard, history: renderHistory, trackers: renderTrackers };
  (views[ui.tab] || renderToday)();
}

function emptyState() {
  return `
    <div class="empty">
      <div class="empty-icon">📈</div>
      <h2>Track what matters to you</h2>
      <p>Start with blood pressure, liquid intake and a 1–10 headache score — or build your own trackers.</p>
      <button class="btn primary" data-act="setup-mine">Add my 3 trackers</button>
      <button class="btn" data-act="templates">Choose from examples</button>
      <button class="btn" data-act="new-tracker">Create a tracker</button>
    </div>`;
}

function renderToday() {
  const now = new Date();
  setTop(now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }));
  const list = store.trackers();
  if (!list.length) {
    view.innerHTML = emptyState();
    return;
  }
  view.innerHTML = `
    ${duplicateBanner()}
    <div class="home-actions">
      <button class="action primary" data-act="new-entry">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
        <span><b>New entry</b><small>${list.map((t) => esc(t.name)).join(', ')}</small></span>
      </button>
      <button class="action" data-act="go-dashboard">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19h16M6 15l4-5 4 3 5-7"/></svg>
        <span><b>Dashboard</b><small>Day view, trends &amp; data</small></span>
      </button>
    </div>
    <h3 class="section">Today</h3>
    <div class="cards">
      ${list
        .map((t) => {
          const s = todaySummary(t);
          let quick = '';
          if (hasKinds(t)) {
            quick = `<button class="quick" data-act="log" data-id="${t.id}" aria-label="Log ${esc(t.name)}">+</button>`;
          } else if (t.type === 'count') {
            const step = stepOf(t);
            quick = `<button class="quick${String(step).length > 2 ? ' wide' : ''}" data-act="quick-count" data-id="${t.id}" aria-label="Add ${step} ${esc(t.unit || '')} to ${esc(t.name)}">+${fmt(step)}</button>`;
          }
          else if (t.type === 'check') {
            quick = s.done
              ? `<button class="quick on" data-act="undo-check" data-id="${t.id}" aria-label="Undo ${esc(t.name)} today">✓</button>`
              : `<button class="quick" data-act="quick-check" data-id="${t.id}" aria-label="Mark ${esc(t.name)} done today">✓</button>`;
          } else quick = `<button class="quick" data-act="log" data-id="${t.id}" aria-label="Log ${esc(t.name)}">+</button>`;
          return `
          <div class="card tracker-card" style="--c:${t.color}">
            <button class="card-main" data-act="log" data-id="${t.id}">
              <span class="ticon">${esc(t.icon || '•')}</span>
              <span class="tbody">
                <span class="tname">${esc(t.name)}</span>
                <span class="tsub">${s.text}</span>
              </span>
            </button>
            ${quick}
          </div>`;
        })
        .join('')}
    </div>
    <p class="hint">Tap a tracker to log just that one; the round button is a quick add.</p>`;
}

/** Shown when two trackers share a name (e.g. examples added and then a backup restored). */
function duplicateBanner() {
  const groups = store.duplicateGroups();
  if (!groups.length) return '';
  return `
    <div class="banner">
      <b>Duplicate trackers</b>
      <span>${groups.map((g) => `${esc(g[0].icon || '')} ${esc(g[0].name)} ×${g.length}`).join(' · ')}</span>
      <small>Probably the examples were added and a backup restored. Merging keeps every entry.</small>
      <button class="btn primary" data-act="merge-dups">Merge duplicates</button>
    </div>`;
}

function renderHistory() {
  const list = store.trackers();
  setTop('History');
  if (!list.length) {
    view.innerHTML = emptyState();
    return;
  }
  if (ui.historyFilter !== 'all' && !store.tracker(ui.historyFilter)) ui.historyFilter = 'all';
  const all = store.entries(ui.historyFilter === 'all' ? undefined : ui.historyFilter);
  const shown = all.slice(0, ui.historyLimit);
  let html = `
    <label class="filter">
      <span class="sr">Filter</span>
      <select data-act="history-filter">
        <option value="all">All trackers</option>
        ${list.map((t) => `<option value="${t.id}" ${ui.historyFilter === t.id ? 'selected' : ''}>${esc(t.icon)} ${esc(t.name)}</option>`).join('')}
      </select>
    </label>`;
  if (!all.length) {
    view.innerHTML = html + `<div class="empty small"><p>Nothing logged yet.</p></div>`;
    return;
  }
  let curDay = null;
  html += '<div class="history">';
  for (const e of shown) {
    const t = store.tracker(e.trackerId);
    if (!t) continue;
    const d = new Date(e.ts);
    const k = S.dayKey(d);
    if (k !== curDay) {
      if (curDay) html += '</div>';
      html += `<h3 class="day">${dayLabel(d)}</h3><div class="card list">`;
      curDay = k;
    }
    html += entryRow(e);
  }
  html += '</div></div>';
  if (all.length > shown.length) html += `<button class="btn block" data-act="more-history">Show more (${all.length - shown.length} older)</button>`;
  view.innerHTML = html;
}

// ---------- daily aggregates ----------
// One place that defines what a tracker's "value for the day" is.
// Extend here when adding new daily aggregates.

function tile(label, value, sub = '', cls = '') {
  return `<div class="tile ${cls}"><span class="tl">${label}</span><span class="tv">${value}</span>${sub ? `<span class="ts">${sub}</span>` : ''}</div>`;
}

/** Map dayKey -> entries. */
function byDay(list) {
  const m = new Map();
  for (const e of list) {
    const k = S.dayKey(e.ts);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(e);
  }
  return m;
}

function scaleVals(list) {
  return list.map((e) => e.values?.v).filter(num);
}

function outOfTarget(f, v) {
  return num(v) && ((num(f.targetMin) && v < f.targetMin) || (num(f.targetMax) && v > f.targetMax));
}

/**
 * Aggregate of one tracker for one day:
 *  measurement -> per value: mean, min, max, n (+ right − left difference for left/right trackers)
 *  counter     -> total
 *  scale       -> highest and mean (0 when "no entry = 0" and nothing was logged)
 *  yes/no      -> done or not
 */
function dayAggregate(t, list = []) {
  if (t.type === 'number') {
    const a = { n: list.length, fields: store.fieldsOf(t).map((f) => ({ f, st: S.fieldStats(S.points(list, f.id), f) })) };
    if (isSided(t)) {
      // Arm difference (right − left) per entry that has both arms, then summarised.
      const dps = deltaPoints(t, list);
      a.deltas = pairs(t).map((p) => ({ p, st: S.fieldStats(dps[p.base]) }));
    }
    return a;
  }
  if (t.type === 'count') {
    return { n: list.length, total: list.reduce((a, e) => a + (num(e.values?.v) ? e.values.v : 0), 0), byKind: hasKinds(t) ? kindTotals(list) : null };
  }
  if (t.type === 'scale') {
    const v = scaleVals(list);
    if (!v.length) return { n: 0, max: t.defaultZero ? 0 : null, mean: t.defaultZero ? 0 : null };
    return { n: v.length, max: Math.max(...v), mean: v.reduce((a, b) => a + b, 0) / v.length };
  }
  return { n: list.length, yes: list.some((e) => e.values?.v === 1) };
}

/** [{kind, total, n}] sorted by total, largest first. */
function kindTotals(list) {
  const m = new Map();
  for (const e of list) {
    if (!num(e.values?.v)) continue;
    const k = kindLabel(e);
    const cur = m.get(k) || { kind: k, total: 0, n: 0 };
    cur.total += e.values.v;
    cur.n += 1;
    m.set(k, cur);
  }
  return [...m.values()].sort((a, b) => b.total - a.total);
}

/** Horizontal bars: share of each type in the total. perDays: show "per day" averages over that many days. */
function kindBreakdown(t, kinds, perDays = 0) {
  if (!kinds?.length) return '';
  const total = kinds.reduce((a, k) => a + k.total, 0) || 1;
  const unit = t.unit ? ' ' + esc(t.unit) : '';
  return `<div class="kinds">${kinds
    .map(
      (k) => `
      <div class="kind-row">
        <span class="kname">${esc(k.kind)}</span>
        <span class="kbar"><i style="width:${((k.total / total) * 100).toFixed(1)}%;background:var(--c)"></i></span>
        <span class="kval">${perDays ? fmt(k.total / perDays) + unit + '<small>/day</small>' : fmt(k.total) + unit}<small> · ${Math.round((k.total / total) * 100)}%</small></span>
      </div>`
    )
    .join('')}</div>`;
}

/** "+5", "−3", "0" */
const signed = (v, dp = 0) => {
  if (!num(v)) return '–';
  const r = Number(v.toFixed(dp)); // so −0.3 shows as "0", not "−0"
  return (r > 0 ? '+' : r < 0 ? '−' : '') + fmt(Math.abs(r), dp);
};
const meanOf = (vals) => {
  const v = vals.filter(num);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};

function entryRow(e) {
  const t = store.tracker(e.trackerId);
  if (!t) return '';
  const d = new Date(e.ts);
  return `
    <button class="row" data-act="edit-entry" data-id="${e.id}" style="--c:${t.color}">
      <span class="ticon sm">${esc(t.icon || '•')}</span>
      <span class="rbody">
        <span class="rtop"><span class="rname">${esc(t.name)}</span><span class="rval">${formatEntry(t, e)}</span></span>
        <span class="rnote">${timeOf(d)}${e.note ? ` · ${esc(e.note)}` : ''}</span>
      </span>
    </button>`;
}

function cardTitle(t, sub) {
  return `<h3 class="card-title"><span class="ticon sm">${esc(t.icon || '•')}</span><span>${esc(t.name)}<small class="block">${sub}</small></span></h3>`;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// ---------- dashboard ----------

const DASH_RANGES = [
  [3, '3D'],
  [7, '1W'],
  [30, '1M'],
  [90, '3M'],
  [365, '1Y'],
  ['all', 'All'],
];

const DASH_MODES = [
  ['day', 'Day'],
  ['period', 'Multi-day'],
  ['overview', 'Overview'],
];

function renderDashboard() {
  setTop('Dashboard');
  const list = store.trackers();
  if (!list.length) {
    view.innerHTML = emptyState();
    return;
  }
  const modeSeg = `
    <div class="seg" role="group" aria-label="View">
      ${DASH_MODES.map(([m, l]) => `<button data-act="dash-mode" data-mode="${m}" aria-pressed="${ui.dashMode === m}">${l}</button>`).join('')}
    </div>`;
  const body = ui.dashMode === 'period' ? periodView(list) : ui.dashMode === 'overview' ? overviewView(list) : dayView(list);
  view.innerHTML = modeSeg + body;
}

// ---- left / right arm ----

/** Table with a row per arm plus the difference (R − L); `a` is a dayAggregate over any set of entries. */
function sidedTable(t, a, { withRange = false } = {}) {
  const ps = pairs(t);
  const stats = new Map(a.fields.map((x) => [x.f.id, x.st]));
  const alertable = new Set(deltaPairs(t).map((p) => p.base));
  const cell = (st, p) =>
    st
      ? `<td class="${outOfTarget(p, st.mean) ? 'warn' : ''}">${fmt(st.mean, p.decimals)}${withRange && st.min !== st.max ? `<small>${fmt(st.min, p.decimals)}–${fmt(st.max, p.decimals)}</small>` : ''}</td>`
      : '<td class="dim">–</td>';
  const sideRows = t.sides
    .map((s) => `<tr><th>${armBadge(s)}${esc(s.name)}</th>${ps.map((p) => cell(stats.get(s.id === 'L' ? p.L?.id : p.R.id), p)).join('')}</tr>`)
    .join('');
  const deltaRow = `<tr class="delta"><th>Difference<small>right − left</small></th>${ps
    .map((p) => {
      const st = a.deltas?.find((d) => d.p.base === p.base)?.st;
      if (!st) return '<td class="dim">–</td>';
      const warn = alertable.has(p.base) && num(t.deltaAlert) && Math.abs(st.mean) >= t.deltaAlert;
      return `<td class="${warn ? 'warn' : ''}">${signed(st.mean, p.decimals)}${withRange && st.n > 1 ? `<small>${signed(st.min, p.decimals)} … ${signed(st.max, p.decimals)}</small>` : ''}</td>`;
    })
    .join('')}</tr>`;
  const noPairs = a.n && !a.deltas?.some((d) => d.st);
  return `
    <div class="table-wrap">
      <table class="sidetable">
        <thead><tr><th></th>${ps.map((p) => `<th>${esc(p.name)}<small>${esc(p.unit)}</small></th>`).join('')}</tr></thead>
        <tbody>${sideRows}${deltaRow}</tbody>
      </table>
    </div>
    ${noPairs ? '<p class="muted small">The difference needs left and right measured in the same entry.</p>' : ''}`;
}

/** Arm difference over time: chart with the ±alert zone and summary tiles. */
function deltaSection(t, period, start, end) {
  const dps = deltaPoints(t, period);
  const dp = deltaPairs(t);
  const alert = num(t.deltaAlert) ? t.deltaAlert : null;
  const colors = ['#7c3aed', '#db2777', '#0891b2'];
  const series = dp.map((p, i) => {
    const pts = dps[p.base];
    return { name: `${p.name}`, color: colors[i % colors.length], points: pts.length > 120 ? S.dailyMeans(pts) : pts };
  });
  const head = `<h4 class="sub-h">Arm difference <small>right − left, per reading${alert ? ` · shaded: within ±${fmt(alert)} ${esc(dp[0]?.unit || '')}` : ''}</small></h4>`;
  if (!series.some((s) => s.points.length)) {
    return head + '<p class="muted small">No readings with both arms in this period. Enter left and right in the same entry to track the difference.</p>';
  }
  const tiles = dp
    .map((p, i) => {
      const vals = dps[p.base].map((x) => x.v);
      if (!vals.length) return '';
      const abs = vals.map(Math.abs);
      const over = alert ? abs.filter((v) => v >= alert).length : null;
      return `
        <div class="field-stats">
          <h4><span class="dot" style="background:${colors[i % colors.length]}"></span>Δ ${esc(p.name)} <small>${esc(p.unit)}</small></h4>
          <div class="tiles">
            ${tile('Avg', signed(meanOf(vals), p.decimals), `|Δ| ${fmt(meanOf(abs), p.decimals)}`, alert && Math.abs(meanOf(vals)) >= alert ? 'warn' : '')}
            ${tile('Largest', fmt(Math.max(...abs), p.decimals), '|Δ|', alert && Math.max(...abs) >= alert ? 'warn' : '')}
            ${alert ? tile(`≥ ${fmt(alert)}`, `${over}<small> / ${vals.length}</small>`, 'readings', over ? 'warn' : '') : tile('Readings', fmt(vals.length))}
            ${tile('Latest', signed(vals[vals.length - 1], p.decimals))}
          </div>
        </div>`;
    })
    .join('');
  return (
    head +
    lineChart({ series, xStart: start, xEnd: end, bands: alert ? [{ min: -alert, max: alert, color: '#059669' }] : [], yRange: alert ? [-alert, alert] : [0], label: 'Arm difference over time' }) +
    `<div class="legend">${series.map((s) => `<span><i style="background:${s.color}"></i>Δ ${esc(s.name)}</span>`).join('')}</div>` +
    tiles
  );
}

/** Colors per arm: left = reds, right = blues; lighter for the 2nd/3rd value. */
const ARM_COLORS = { L: ['#dc2626', '#f87171', '#fca5a5'], R: ['#2563eb', '#60a5fa', '#93c5fd'] };

function sidedPeriodBody(t, period, start, end) {
  const ps = pairs(t);
  const main = ps.filter((p) => p.unit === ps[0].unit); // e.g. systolic + diastolic (mmHg); pulse stays in the table
  const series = [];
  main.forEach((p, i) => {
    for (const s of t.sides) {
      const f = s.id === 'L' ? p.L : p.R;
      const pts = S.points(period, f.id);
      series.push({ name: `${s.short} ${p.name}`, color: ARM_COLORS[s.id][i % 3], points: pts.length > 120 ? S.dailyMeans(pts) : pts });
    }
  });
  const bands = main.filter((p) => num(p.targetMin) || num(p.targetMax)).map((p) => ({ min: p.targetMin, max: p.targetMax, color: '#64748b' }));
  return (
    lineChart({ series, xStart: start, xEnd: end, bands, label: `${t.name} over time` }) +
    `<div class="legend">${series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('')}</div>` +
    `<h4 class="sub-h">Period averages <small>lowest–highest below</small></h4>` +
    sidedTable(t, dayAggregate(t, period), { withRange: true }) +
    deltaSection(t, period, start, end)
  );
}

// ---- single day ----

function daySummaryCard(t, list) {
  const a = dayAggregate(t, list);
  let sub = '';
  let tiles = '';
  let extra = '';
  if (t.type === 'number') {
    sub = a.n ? `${plural(a.n, 'reading', 'readings')} · daily average` : 'No readings';
    if (isSided(t)) {
      if (a.n) extra = sidedTable(t, a);
    } else {
      tiles = a.fields
        .filter((x) => x.st)
        .map(({ f, st }) =>
          tile(esc(f.name), fmt(st.mean, f.decimals), [esc(f.unit), st.min !== st.max ? `${fmt(st.min, f.decimals)}–${fmt(st.max, f.decimals)}` : ''].filter(Boolean).join(' · '), outOfTarget(f, st.mean) ? 'warn' : '')
        )
        .join('');
    }
  } else if (t.type === 'count') {
    sub = a.n ? (hasKinds(t) ? plural(a.n, 'drink', 'drinks') : plural(a.n, 'entry', 'entries')) : 'Nothing logged';
    const goal = t.dailyGoal > 0 ? `${pct(a.total / t.dailyGoal)} of ${fmt(t.dailyGoal)} goal` : '';
    tiles = tile('Total', fmt(a.total), [esc(t.unit), goal].filter(Boolean).join(' · '));
    extra = kindBreakdown(t, a.byKind);
  } else if (t.type === 'scale') {
    sub = a.n ? plural(a.n, 'score', 'scores') : t.defaultZero ? 'No score logged — counts as 0' : 'No score';
    tiles = a.max == null ? '' : tile('Highest', fmt(a.max), `of ${t.scaleMax}`) + (a.n > 1 ? tile('Average', fmt(a.mean, 1)) : '');
  } else {
    tiles = tile('Done', a.yes ? 'Yes' : 'No');
  }
  return `<section class="card stat-block" style="--c:${t.color}">${cardTitle(t, sub)}${tiles ? `<div class="tiles">${tiles}</div>` : ''}${extra}</section>`;
}

function dayView(list) {
  const todayKey = S.dayKey(new Date());
  if (!ui.dashDay || ui.dashDay > todayKey) ui.dashDay = todayKey;
  const key = ui.dashDay;
  const day = new Date(key + 'T12:00:00');
  const dayEntries = store.entries().filter((e) => S.dayKey(e.ts) === key).reverse(); // oldest first
  const longDate = day.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  return `
    <div class="daynav">
      <button class="icon-btn" data-act="day-shift" data-d="-1" aria-label="Previous day">‹</button>
      <label class="daypick"><b>${dayLabel(day)}</b><small>${longDate}</small>
        <input type="date" data-act="day-pick" value="${key}" max="${todayKey}" aria-label="Pick a day">
      </label>
      <button class="icon-btn" data-act="day-shift" data-d="1" aria-label="Next day" ${key === todayKey ? 'disabled' : ''}>›</button>
    </div>
    ${list.map((t) => daySummaryCard(t, dayEntries.filter((e) => e.trackerId === t.id))).join('')}
    <h3 class="section">All entries</h3>
    ${dayEntries.length ? `<div class="card list">${dayEntries.map(entryRow).join('')}</div>` : `<div class="card pad muted small">Nothing logged on this day.</div>`}
    <button class="btn primary block" data-act="new-entry" data-day="${key}">＋ New entry for this day</button>`;
}

// ---- multiple days ----

function periodCard(t, start, end, dayMap) {
  const period = [...dayMap.values()].flat();
  let body = '';
  if (isSided(t)) {
    body = sidedPeriodBody(t, period, start, end);
  } else if (t.type === 'number') {
    const fields = store.fieldsOf(t);
    const series = [];
    const bands = [];
    let anyDense = false;
    let stats = '';
    fields.forEach((f, i) => {
      const pts = S.points(period, f.id);
      const st = S.fieldStats(pts, f);
      const color = seriesColor(t, i);
      const dense = pts.length > 120;
      anyDense ||= dense;
      series.push({ name: f.name, color, points: dense ? S.dailyMeans(pts) : pts });
      if (num(f.targetMin) || num(f.targetMax)) bands.push({ min: f.targetMin, max: f.targetMax, color });
      if (!st) return;
      const dp = f.decimals;
      stats += `
        <div class="field-stats">
          <h4><span class="dot" style="background:${color}"></span>${esc(f.name)} <small>${esc(f.unit)}</small></h4>
          <div class="tiles">
            ${tile('Average', fmt(st.mean, dp), `± ${fmt(st.sd, dp)}`, outOfTarget(f, st.mean) ? 'warn' : '')}
            ${tile('Low', fmt(st.min, dp))}
            ${tile('High', fmt(st.max, dp))}
            ${st.inTarget != null ? tile('In target', pct(st.inTarget), targetText(f)) : tile('Latest', fmt(st.latest, dp))}
          </div>
        </div>`;
    });
    body =
      lineChart({ series, xStart: start, xEnd: end, bands, label: `${t.name} over time` }) +
      (fields.length > 1 ? `<div class="legend">${series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('')}</div>` : '') +
      (anyDense ? '<p class="muted small center">Showing daily averages</p>' : '') +
      (stats || '<p class="muted small">No readings in this period.</p>');
  } else if (t.type === 'count') {
    const daily = S.dailyTotals(period, start, end);
    const st = S.countStats(daily, t.dailyGoal);
    const weeklyMode = daily.length > 92;
    const dp = stepOf(t) >= 10 ? 0 : 1;
    body =
      barChart({ bars: weeklyMode ? S.weekly(daily) : daily, color: t.color, goal: weeklyMode ? (t.dailyGoal || 0) * 7 : t.dailyGoal, xStart: start, xEnd: end, label: `${t.name} per day` }) +
      (weeklyMode ? '<p class="muted small center">Weekly totals</p>' : '') +
      `<div class="tiles">
        ${tile('Per day', fmt(st.perDay, dp), esc(t.unit))}
        ${tile('Best day', fmt(st.best), esc(t.unit))}
        ${st.goalDays != null ? tile('Goal met', `${st.goalDays}<small> / ${st.days}</small>`, 'days') : tile('Days logged', `${st.activeDays}<small> / ${st.days}</small>`)}
      </div>` +
      (hasKinds(t) && period.length ? `<h4 class="sub-h">By type <small>average per day</small></h4>${kindBreakdown(t, kindTotals(period), daily.length)}` : '');
  } else if (t.type === 'scale') {
    const daily = S.eachDay(start, end)
      .map((d) => {
        const v = scaleVals(dayMap.get(S.dayKey(d)) || []);
        return { t: new Date(d.getTime() + 12 * 3600e3), v: v.length ? Math.max(...v) : t.defaultZero ? 0 : null };
      })
      .filter((p) => num(p.v));
    const vals = daily.map((p) => p.v);
    const above = vals.filter((v) => v > 0).length;
    body =
      lineChart({ series: [{ name: t.name, color: t.color, points: daily }], xStart: start, xEnd: end, yRange: [t.defaultZero ? 0 : t.scaleMin, t.scaleMax], label: `${t.name} per day` }) +
      `<div class="tiles">
        ${tile('Daily avg', fmt(meanOf(vals), 1), t.defaultZero ? 'incl. 0 days' : '')}
        ${tile('Highest', vals.length ? fmt(Math.max(...vals)) : '–', `of ${t.scaleMax}`)}
        ${t.defaultZero ? tile('Days > 0', `${above}<small> / ${vals.length}</small>`) : tile('Days scored', fmt(vals.length))}
      </div>`;
  } else {
    const st = S.checkStats(store.entries(t.id), start, end);
    body =
      calendar({ days: S.eachDay(start, end), doneSet: st.doneSet, keyOf: S.dayKey, color: t.color, label: `${t.name} calendar` }) +
      `<div class="tiles">
        ${tile('Done', pct(st.pct), `${st.done} of ${st.days} days`)}
        ${tile('Streak', `${st.streak}<small> d</small>`, `best ${st.best}`)}
      </div>`;
  }
  return `<section class="card pcard" style="--c:${t.color}">${cardTitle(t, plural(period.length, 'entry', 'entries'))}${body}</section>`;
}

/** The selected period, never starting before the first entry. */
function periodRange() {
  const today = S.startOfDay(new Date());
  const end = S.endOfDay(today);
  const all = store.entries();
  const first = all.length ? S.startOfDay(all[all.length - 1].ts) : today;
  let start = ui.dashRange === 'all' ? first : S.addDays(today, -(ui.dashRange - 1));
  let clamped = false;
  if (first > start) {
    start = first;
    clamped = true;
  }
  return { today, start, end, clamped };
}

function rangeHeader({ today, start, end, clamped }) {
  const days = S.eachDay(start, end).length;
  const startLabel = start.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: start.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
  return `
    <div class="seg" role="group" aria-label="Period">
      ${DASH_RANGES.map(([r, l]) => `<button data-act="dash-range" data-range="${r}" aria-pressed="${ui.dashRange === r}">${l}</button>`).join('')}
    </div>
    <p class="muted small period-note">${startLabel} – today · ${plural(days, 'day', 'days')}${clamped && ui.dashRange !== 'all' ? ' (since tracking began)' : ''}</p>`;
}

function periodView(list) {
  const r = periodRange();
  const groups = new Map(list.map((t) => [t.id, byDay(S.inPeriod(store.entries(t.id), r.start, r.end))]));
  return rangeHeader(r) + list.map((t) => periodCard(t, r.start, r.end, groups.get(t.id))).join('');
}

// ---- overview: everything on one chart + a table of all tracked days ----

/** Line/bar/strip series for the combined chart, one value per day. */
function overviewSeries(list, days, groups) {
  const lines = [];
  const bars = [];
  const strips = [];
  let leftUnit = '';
  let rightUnit = '';
  const dayList = (t, d) => groups.get(t.id).get(S.dayKey(d)) || [];
  const dayMean = (t, d, ids) => meanOf(dayList(t, d).flatMap((e) => ids.map((id) => e.values?.[id])));
  for (const t of list) {
    if (t.type === 'number') {
      const ps = pairs(t);
      const unit = ps[0]?.unit || '';
      leftUnit ||= unit;
      if (isSided(t)) {
        ps.forEach((p, i) => {
          if (p.unit === unit) {
            for (const s of t.sides) {
              const f = s.id === 'L' ? p.L : p.R;
              lines.push({ key: `${t.id}:${f.id}`, name: `${s.short} ${p.name}`, color: ARM_COLORS[s.id][i % 3], values: days.map((d) => dayMean(t, d, [f.id])) });
            }
          } else {
            // e.g. pulse: one dashed line, average of both arms
            lines.push({ key: `${t.id}:${p.base}`, name: `${p.name} (${p.unit})`, color: '#64748b', dash: true, values: days.map((d) => dayMean(t, d, [p.L?.id, p.R.id].filter(Boolean))) });
          }
        });
      } else {
        store.fieldsOf(t).forEach((f, i) =>
          lines.push({ key: `${t.id}:${f.id}`, name: `${f.name}${f.unit && f.unit !== unit ? ` (${f.unit})` : ''}`, color: seriesColor(t, i), dash: f.unit !== unit, values: days.map((d) => dayMean(t, d, [f.id])) })
        );
      }
    } else if (t.type === 'count') {
      const values = days.map((d) => {
        const l = dayList(t, d);
        return l.length ? dayAggregate(t, l).total : null;
      });
      if (!bars.length) {
        bars.push({ key: t.id, name: `${t.name} (${t.unit || 'total'})`, color: t.color, values });
        rightUnit = t.unit || '';
      } else {
        strips.push({ key: t.id, name: t.name, icon: t.icon, color: t.color, values, max: Math.max(1, ...values.filter(num)) });
      }
    } else if (t.type === 'scale') {
      strips.push({ key: t.id, name: `${t.name} (0–${t.scaleMax})`, icon: t.icon, color: t.color, max: t.scaleMax, values: days.map((d) => dayAggregate(t, dayList(t, d)).max) });
    } else {
      strips.push({ key: t.id, name: t.name, icon: t.icon, color: t.color, max: 1, values: days.map((d) => (dayList(t, d).length ? (dayAggregate(t, dayList(t, d)).yes ? 1 : 0) : null)) });
    }
  }
  return { lines, bars, strips, leftUnit, rightUnit };
}

/** Table columns: each knows how to get its value(s) from a tracker's day aggregate. */
function overviewColumns(list) {
  const cols = [];
  for (const t of list) {
    if (isSided(t)) {
      const ps = pairs(t);
      const main = ps.filter((p) => p.unit === ps[0].unit);
      const mean = (a, id) => a.fields.find((x) => x.f.id === id)?.st?.mean ?? null;
      for (const s of t.sides) {
        cols.push({
          t,
          head: `${s.name}`,
          sub: `${main.map((p) => p.name.slice(0, 3).toLowerCase()).join('/')} ${main[0]?.unit || ''}`,
          value: (a) => main.map((p) => mean(a, s.id === 'L' ? p.L?.id : p.R.id)),
          text: (v) => (v.some(num) ? v.map((x, i) => fmt(x, main[i].decimals)).join('/') : '–'),
          cls: (v) => (v.some((x, i) => outOfTarget(main[i], x)) ? 'warn' : ''),
        });
      }
      for (const p of deltaPairs(t).slice(0, 1)) {
        cols.push({
          t,
          head: 'Δ R − L',
          sub: `${p.name.slice(0, 3).toLowerCase()} ${p.unit}`,
          value: (a) => [a.deltas?.find((d) => d.p.base === p.base)?.st?.mean ?? null],
          text: (v) => signed(v[0], p.decimals),
          cls: (v) => (num(t.deltaAlert) && num(v[0]) && Math.abs(v[0]) >= t.deltaAlert ? 'warn' : ''),
        });
      }
      for (const p of ps.filter((x) => x.unit !== ps[0].unit)) {
        cols.push({ t, head: p.name, sub: `${p.unit} · avg`, value: (a) => [meanOf([mean(a, p.L?.id), mean(a, p.R.id)])], text: (v) => fmt(v[0], p.decimals) });
      }
    } else if (t.type === 'number') {
      for (const f of store.fieldsOf(t)) {
        cols.push({ t, head: f.name, sub: f.unit, value: (a) => [a.fields.find((x) => x.f.id === f.id)?.st?.mean ?? null], text: (v) => fmt(v[0], f.decimals), cls: (v) => (outOfTarget(f, v[0]) ? 'warn' : '') });
      }
    } else if (t.type === 'count') {
      cols.push({ t, head: t.name, sub: t.unit || 'total', value: (a) => [a.n ? a.total : null], text: (v) => fmt(v[0]) });
    } else if (t.type === 'scale') {
      cols.push({ t, head: t.name, sub: `0–${t.scaleMax}${t.defaultZero ? ' · max' : ''}`, value: (a) => [a.max], text: (v, avg) => fmt(v[0], avg ? 1 : 0), cls: (v) => (v[0] > 0 ? 'strong' : '') });
    } else {
      cols.push({ t, head: t.name, sub: 'done', value: (a) => [a.n ? (a.yes ? 1 : 0) : null], text: (v, avg) => (avg ? pct(v[0]) : v[0] ? '✓' : '–') });
    }
  }
  return cols;
}

function overviewView(list) {
  const r = periodRange();
  const days = S.eachDay(r.start, r.end);
  const groups = new Map(list.map((t) => [t.id, byDay(S.inPeriod(store.entries(t.id), r.start, r.end))]));
  const hidden = new Set(ui.ovHidden || []);
  const s = overviewSeries(list, days, groups);
  const chart = overviewChart({
    days,
    lines: s.lines.filter((x) => !hidden.has(x.key)),
    bars: s.bars.filter((x) => !hidden.has(x.key)),
    strips: s.strips.filter((x) => !hidden.has(x.key)),
    leftUnit: s.leftUnit,
    rightUnit: s.rightUnit,
  });
  const legend = [...s.lines, ...s.bars, ...s.strips]
    .map(
      (x) =>
        `<button class="lg${hidden.has(x.key) ? ' off' : ''}" data-act="ov-toggle" data-key="${esc(x.key)}" aria-pressed="${!hidden.has(x.key)}"><i class="${s.bars.includes(x) ? 'bar' : s.strips.includes(x) ? 'strip' : x.dash ? 'dash' : ''}" style="--lc:${x.color}"></i>${esc(x.name)}</button>`
    )
    .join('');

  // Table: every tracked day (any entry) in the period, newest first, plus averages.
  const cols = overviewColumns(list);
  const tracked = days
    .filter((d) => list.some((t) => groups.get(t.id).has(S.dayKey(d))))
    .reverse()
    .map((d) => {
      const k = S.dayKey(d);
      const aggs = new Map(list.map((t) => [t.id, dayAggregate(t, groups.get(t.id).get(k) || [])]));
      return { d, k, vals: cols.map((c) => c.value(aggs.get(c.t.id))) };
    });
  const avgs = cols.map((c, i) => {
    const width = tracked[0]?.vals[i].length || 1;
    return Array.from({ length: width }, (_, j) => meanOf(tracked.map((row) => row.vals[i][j])));
  });
  const shown = ui.tableAll ? tracked : tracked.slice(0, 60);
  const cellHtml = (c, v, avg = false) => `<td class="${(c.cls && c.cls(v)) || (v.some(num) ? '' : 'dim')}">${c.text(v, avg)}</td>`;

  return `
    ${rangeHeader(r)}
    <section class="card pcard">
      <h3 class="card-title"><span>All parameters<small class="block">per day · tap a label below to hide or show it</small></span></h3>
      ${chart}
      <div class="ov-legend">${legend}</div>
      <p class="muted small">Left axis: ${esc(s.leftUnit)}${s.rightUnit ? ` · right axis: ${esc(s.rightUnit)} (bars)` : ''}${s.strips.length ? ' · strips below: darker = higher' : ''}. Values are daily averages (blood pressure), totals (liquid) and highest score (headache).</p>
    </section>
    <h3 class="section">Tracked days <small>${plural(tracked.length, 'day', 'days')}</small></h3>
    ${
      tracked.length
        ? `<div class="card table-wrap">
      <table class="daytable ovtable">
        <thead><tr><th>Day</th>${cols.map((c) => `<th>${esc(c.head)}<small>${esc(c.sub)}</small></th>`).join('')}</tr></thead>
        <tbody>
          <tr class="avg"><td>Average</td>${cols.map((c, i) => cellHtml(c, avgs[i], true)).join('')}</tr>
          ${shown.map((row) => `<tr data-act="goto-day" data-day="${row.k}"><td>${row.d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}</td>${cols.map((c, i) => cellHtml(c, row.vals[i])).join('')}</tr>`).join('')}
        </tbody>
      </table>
    </div>
    ${tracked.length > shown.length ? `<button class="btn block" data-act="table-all">Show all ${tracked.length} days</button>` : ''}`
        : '<div class="card pad muted small">Nothing tracked in this period.</div>'
    }
    <p class="hint">Red = outside target, or an arm difference of ${fmt(list.find(isSided)?.deltaAlert ?? 10)} or more. Swipe the table sideways if it is wider than the screen; tap a day to open it.</p>`;
}

function targetText(f) {
  if (num(f.targetMin) && num(f.targetMax)) return `${fmt(f.targetMin, f.decimals)}–${fmt(f.targetMax, f.decimals)}`;
  if (num(f.targetMin)) return `≥ ${fmt(f.targetMin, f.decimals)}`;
  return `≤ ${fmt(f.targetMax, f.decimals)}`;
}

function renderTrackers() {
  setTop('Trackers', `<button class="icon-btn" data-act="new-tracker" aria-label="New tracker">＋</button>`);
  const list = store.trackers();
  const c = store.counts();
  view.innerHTML = `
    ${duplicateBanner()}
    ${
      list.length
        ? `<div class="card list">
            ${list
              .map(
                (t, i) => `
              <div class="row static" style="--c:${t.color}">
                <span class="ticon sm">${esc(t.icon || '•')}</span>
                <button class="rbody link" data-act="edit-tracker" data-id="${t.id}">
                  <span class="rname">${esc(t.name)}</span>
                  <span class="rnote">${TYPE_LABEL[t.type]} · ${store.entries(t.id).length} entries</span>
                </button>
                <span class="order">
                  <button class="icon-btn sm" data-act="move" data-dir="-1" data-id="${t.id}" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
                  <button class="icon-btn sm" data-act="move" data-dir="1" data-id="${t.id}" ${i === list.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
                </span>
              </div>`
              )
              .join('')}
          </div>`
        : emptyState()
    }
    ${list.length ? `<div class="btn-row"><button class="btn primary" data-act="new-tracker">New tracker</button><button class="btn" data-act="templates">Add examples</button></div>` : ''}

    <h3 class="section">Your data</h3>
    <div class="card pad">
      <p class="muted small">${c.trackers} trackers · ${c.entries} entries, stored only on this device. Export a backup now and then, and before clearing Safari data or switching phones.</p>
      <div class="btn-row">
        <button class="btn" data-act="export-json">Back up (JSON)</button>
        <button class="btn" data-act="export-csv">Export CSV</button>
      </div>
      <div class="btn-row">
        <label class="btn">Restore backup<input type="file" accept="application/json,.json" data-act="import" hidden></label>
        <button class="btn danger" data-act="erase">Erase all</button>
      </div>
    </div>
    <p class="hint">TrackStats · works offline · add it to your Home Screen via Share → “Add to Home Screen”.</p>`;
}

// ---------- sheet (dialog) ----------

const sheet = $('#sheet');
let sheetSubmit = null;

function openSheet(title, body, { onSubmit, footer }) {
  sheet.innerHTML = `
    <form method="dialog" class="sheet-form" novalidate>
      <header class="sheet-head">
        <button type="button" class="link-btn" data-act="close-sheet">Cancel</button>
        <h2 id="sheet-title">${title}</h2>
        <button type="submit" class="link-btn strong">Save</button>
      </header>
      <div class="sheet-body">${body}</div>
      ${footer ? `<footer class="sheet-foot">${footer}</footer>` : ''}
    </form>`;
  sheetSubmit = onSubmit;
  if (!sheet.open) sheet.showModal();
  sheet.scrollTop = 0;
}

function closeSheet() {
  sheetSubmit = null;
  if (sheet.open) sheet.close();
}

sheet.addEventListener('submit', (ev) => {
  ev.preventDefault();
  if (sheetSubmit && sheetSubmit(new FormData(ev.target), ev.target) !== false) closeSheet();
});
sheet.addEventListener('click', (ev) => {
  if (ev.target === sheet) closeSheet(); // tap on backdrop
});

// ---- value inputs (shared by the single-tracker form and the combined "New entry" form) ----

/**
 * Inputs for one tracker's values, named `${prefix}${fieldId}`.
 * fresh: combined form — nothing preselected except a 0 for "no entry = 0" scales.
 */
function valueInputs(t, vals, prefix, { fresh = false, autofocus = false, hintLast = false, kind = '', more = true } = {}) {
  if (hasKinds(t)) {
    return `
      <div class="drinks" data-tracker="${t.id}">${drinkRow(t, prefix, 0, vals.v, kind)}</div>
      ${more ? `<button type="button" class="btn block slim" data-act="add-drink" data-tracker="${t.id}" data-prefix="${prefix}">＋ Another ${esc((t.kindLabel || 'item').toLowerCase())}</button>` : ''}`;
  }
  if (isSided(t)) {
    // One row per arm, e.g. Left arm: Systolic / Diastolic / Pulse
    return t.sides
      .map((s, k) => {
        const fields = sideFields(t, s.id);
        const cols = fields.length >= 3 ? 'grid3' : fields.length === 2 ? 'grid2' : '';
        return `
        <div class="side-block side-${s.id}">
          <div class="side-label">${armBadge(s)}${esc(s.name)}</div>
          <div class="${cols}">${fields
            .map(
              (f, i) => `
            <label class="field"><span>${esc(f.name)}${f.unit ? ` <small>${esc(f.unit)}</small>` : ''}</span>
              <input name="${prefix}${f.id}" type="text" inputmode="decimal" autocomplete="off" ${autofocus && k === 0 && i === 0 ? 'autofocus' : ''}
                value="${num(vals[f.id]) ? vals[f.id] : ''}"></label>`
            )
            .join('')}</div>
        </div>`;
      })
      .join('');
  }
  if (t.type === 'number') {
    const last = hintLast ? store.entries(t.id)[0] : null;
    const fields = store.fieldsOf(t);
    const cols = fields.length >= 3 ? 'grid3' : fields.length === 2 ? 'grid2' : '';
    return `<div class="${cols}">${fields
      .map(
        (f, i) => `
        <label class="field"><span>${esc(f.name)}${f.unit ? ` <small>${esc(f.unit)}</small>` : ''}</span>
          <input name="${prefix}${f.id}" type="text" inputmode="decimal" autocomplete="off" ${autofocus && i === 0 ? 'autofocus' : ''}
            value="${num(vals[f.id]) ? vals[f.id] : ''}" placeholder="${last && num(last.values?.[f.id]) ? 'last ' + fmt(last.values[f.id], f.decimals) : ''}">
        </label>`
      )
      .join('')}</div>`;
  }
  if (t.type === 'scale') {
    const lo = t.defaultZero ? 0 : t.scaleMin;
    const cur = num(vals.v) ? vals.v : t.defaultZero ? 0 : null;
    let btns = '';
    for (let v = lo; v <= t.scaleMax; v++) {
      btns += `<label class="scale-opt"><input type="radio" name="${prefix}v" value="${v}" ${cur === v ? 'checked' : ''}><span>${v}</span></label>`;
    }
    const low = t.defaultZero ? `0 = none${t.lowLabel ? ` · ${t.scaleMin} = ${t.lowLabel}` : ''}` : t.lowLabel || '';
    return `
      <div class="scale" style="--n:${t.scaleMax - lo + 1}">${btns}</div>
      <div class="scale-labels"><small>${esc(low)}</small><small>${esc(t.highLabel || '')}</small></div>`;
  }
  if (t.type === 'check') {
    const cur = num(vals.v) ? vals.v : fresh ? null : 1;
    return `
      <div class="seg big">
        ${fresh ? `<label><input type="radio" name="${prefix}v" value="" ${cur == null ? 'checked' : ''}><span>–</span></label>` : ''}
        <label><input type="radio" name="${prefix}v" value="1" ${cur === 1 ? 'checked' : ''}><span>Yes</span></label>
        <label><input type="radio" name="${prefix}v" value="0" ${cur === 0 ? 'checked' : ''}><span>No</span></label>
      </div>`;
  }
  const step = stepOf(t);
  const v = num(vals.v) ? vals.v : fresh ? '' : step;
  return `
    <div class="stepper">
      <button type="button" data-act="step" data-d="${-step}" aria-label="Less">−</button>
      <input name="${prefix}v" type="text" inputmode="decimal" autocomplete="off" value="${v}" placeholder="0" aria-label="${esc(t.name)} amount">
      <button type="button" data-act="step" data-d="${step}" aria-label="More">+</button>
    </div>
    ${t.unit ? `<small class="block center">${esc(t.unit)} · − / + change by ${fmt(step)}</small>` : ''}`;
}

/** One free-amount item (e.g. a drink): amount + what it was, with quick-pick chips. */
function drinkRow(t, prefix, i, amount = null, kind = '') {
  const kinds = t.kinds?.length ? t.kinds : DEFAULT_DRINKS;
  return `
    <div class="drink-row">
      <div class="drink-top">
        <label class="field"><span>Amount${t.unit ? ` <small>${esc(t.unit)}</small>` : ''}</span>
          <input name="${prefix}v__${i}" type="text" inputmode="decimal" autocomplete="off" value="${num(amount) ? amount : ''}" placeholder="e.g. 330"></label>
        <label class="field"><span>${esc(t.kindLabel || 'Type')}</span>
          <input name="${prefix}kind__${i}" type="text" autocomplete="off" autocapitalize="sentences" value="${esc(kind)}" placeholder="Type or pick below"></label>
      </div>
      <div class="kchips">${kinds.map((k) => `<button type="button" class="kchip${k === kind ? ' on' : ''}" data-act="pick-kind" data-kind="${esc(k)}">${esc(k)}</button>`).join('')}</div>
    </div>`;
}

/** Read all item rows of a tracker: { items: [{v, kind}] } or { error }. */
function readDrinks(t, fd, prefix) {
  const items = [];
  for (let i = 0; fd.has(`${prefix}v__${i}`); i++) {
    const v = parseNum(fd.get(`${prefix}v__${i}`));
    const kind = String(fd.get(`${prefix}kind__${i}`) || '').trim();
    if (v == null) {
      if (kind) return { error: `Enter an amount for ${kind}.` };
      continue;
    }
    if (!(v > 0)) return { error: 'Amounts must be more than 0.' };
    items.push({ v, kind });
  }
  return { items };
}

function readValues(t, fd, prefix) {
  const values = {};
  for (const f of store.fieldsOf(t)) {
    const v = parseNum(fd.get(prefix + f.id));
    if (v != null) values[f.id] = v;
  }
  return values;
}

function whenInputs(d) {
  return `
    <div class="grid2">
      <label class="field"><span>Date</span><input name="date" type="date" value="${S.dayKey(d)}" max="${S.dayKey(new Date())}" required></label>
      <label class="field"><span>Time</span><input name="time" type="time" value="${pad(d.getHours())}:${pad(d.getMinutes())}" required></label>
    </div>`;
}

function readWhen(fd) {
  const ts = new Date(`${fd.get('date')}T${fd.get('time') || '12:00'}`);
  return isNaN(ts) ? null : ts;
}

// ---- combined new entry (all trackers in one form) ----

function openNewEntry(dayKey) {
  const list = store.trackers();
  if (!list.length) return toast('Create a tracker first');
  const now = new Date();
  // Date defaults to today (or the day open in the dashboard); time defaults to now.
  const when = dayKey ? new Date(`${dayKey}T${pad(now.getHours())}:${pad(now.getMinutes())}`) : now;
  const body = `
    ${whenInputs(when)}
    ${list
      .map(
        (t) => `
      <section class="entry-sec" style="--c:${t.color}">
        <h3><span class="ticon sm">${esc(t.icon || '•')}</span>${esc(t.name)}</h3>
        ${valueInputs(t, {}, `x_${t.id}_`, { fresh: true })}
      </section>`
      )
      .join('')}
    <label class="field"><span>Note <small>(optional, saved with each value)</small></span><textarea name="note" rows="2"></textarea></label>
    <p class="form-error" hidden></p>
    <p class="hint left">Fill in one or more categories; empty ones are skipped.</p>`;

  openSheet('New entry', body, {
    onSubmit(fd, form) {
      const ts = readWhen(fd);
      if (!ts) return formError(form, 'Pick a valid date and time.');
      const note = String(fd.get('note') || '').trim();
      const batch = [];
      for (const t of list) {
        if (hasKinds(t)) {
          const r = readDrinks(t, fd, `x_${t.id}_`);
          if (r.error) return formError(form, r.error);
          r.items.forEach(({ v, kind }) => batch.push({ id: store.uid(), trackerId: t.id, ts: ts.toISOString(), values: { v }, kind, note }));
          continue;
        }
        const values = readValues(t, fd, `x_${t.id}_`);
        if (!Object.keys(values).length) continue;
        if (t.type === 'scale' && t.defaultZero && values.v === 0) continue; // 0 is the default, nothing to store
        if (t.type === 'count' && !(values.v > 0)) continue;
        batch.push({ id: store.uid(), trackerId: t.id, ts: ts.toISOString(), values, note });
      }
      if (!batch.length) return formError(form, 'Fill in at least one category.');
      store.saveEntries(batch);
      toast(`Saved ${batch.map((e) => store.tracker(e.trackerId).name).join(', ')}`);
    },
  });
}

// ---- log / edit one entry ----

function openLog(trackerId, entryId) {
  const e = entryId ? store.entry(entryId) : null;
  const t = store.tracker(e ? e.trackerId : trackerId);
  if (!t) return;
  const body = `
    <div class="sheet-tracker" style="--c:${t.color}"><span class="ticon">${esc(t.icon || '•')}</span>${esc(t.name)}</div>
    <div class="field" style="--c:${t.color}">${valueInputs(t, e?.values || {}, 'f_', { autofocus: true, hintLast: !e, kind: e?.kind || '', more: !e })}</div>
    ${whenInputs(e ? new Date(e.ts) : new Date())}
    <label class="field"><span>Note <small>(optional)</small></span><textarea name="note" rows="2" placeholder="e.g. after exercise">${esc(e?.note || '')}</textarea></label>
    <p class="form-error" hidden></p>`;

  openSheet(e ? 'Edit entry' : 'Log', body, {
    footer: e ? `<button type="button" class="btn danger block" data-act="delete-entry" data-id="${e.id}">Delete entry</button>` : '',
    onSubmit(fd, form) {
      if (hasKinds(t)) {
        const r = readDrinks(t, fd, 'f_');
        if (r.error) return formError(form, r.error);
        if (!r.items.length) return formError(form, 'Enter an amount.');
        const ts = readWhen(fd);
        if (!ts) return formError(form, 'Enter a valid date and time.');
        const note = String(fd.get('note') || '').trim();
        if (e) store.saveEntry({ ...e, ts: ts.toISOString(), values: { v: r.items[0].v }, kind: r.items[0].kind, note });
        else store.saveEntries(r.items.map(({ v, kind }) => ({ id: store.uid(), trackerId: t.id, ts: ts.toISOString(), values: { v }, kind, note })));
        toast(e ? 'Entry updated' : `${t.name}: ${plural(r.items.length, 'item', 'items')} logged`);
        return;
      }
      const values = readValues(t, fd, 'f_');
      if (!Object.keys(values).length) return formError(form, t.type === 'scale' ? 'Pick a value.' : 'Enter a value.');
      if (!e && t.type === 'scale' && t.defaultZero && values.v === 0) {
        return formError(form, `0 is already the default. Pick ${t.scaleMin}–${t.scaleMax} to record a score.`);
      }
      const ts = readWhen(fd);
      if (!ts) return formError(form, 'Enter a valid date and time.');
      store.saveEntry({ id: e?.id || store.uid(), trackerId: t.id, ts: ts.toISOString(), values, note: String(fd.get('note') || '').trim() });
      toast(e ? 'Entry updated' : `${t.name} logged`);
    },
  });
}

function formError(form, msg) {
  const el = $('.form-error', form);
  el.textContent = msg;
  el.hidden = false;
  return false;
}

// ---- tracker editor ----

let draft = null;

function newField(name = '', unit = '') {
  return { id: store.uid().slice(0, 8), name, unit, decimals: 0, targetMin: null, targetMax: null };
}

function openTrackerEditor(id) {
  const existing = id ? store.tracker(id) : null;
  draft = existing
    ? structuredClone(existing)
    : { id: store.uid(), name: '', icon: '📊', color: COLORS[store.counts().trackers % COLORS.length], type: 'number', fields: [newField('Value')], scaleMin: 1, scaleMax: 5, lowLabel: 'Low', highLabel: 'High', unit: '', dailyGoal: null };
  draft.fields ||= [newField('Value')];
  draft._new = !existing;
  draft._locked = existing && store.entries(existing.id).length > 0;
  // Left/right trackers are edited as their base values; both arms are rebuilt on save.
  draft.sided = isSided(draft);
  draft._sidedLocked = draft.sided && draft._locked;
  if (draft.sided) draft.fields = baseFields(draft).map(({ side, base, ...f }) => f);
  renderTrackerEditor();
}

function renderTrackerEditor() {
  const d = draft;
  const typeOpt = (v) =>
    `<label><input type="radio" name="type" value="${v}" ${d.type === v ? 'checked' : ''} ${d._locked && d.type !== v ? 'disabled' : ''}><span>${TYPE_LABEL[v]}</span></label>`;
  let typeBody = '';
  if (d.type === 'number') {
    typeBody = `
      <h4 class="sub">Values to record</h4>
      ${d.fields
        .map(
          (f, i) => `
        <div class="field-row" data-fid="${f.id}">
          <div class="grid2">
            <label class="field"><span>Name</span><input name="fn_${f.id}" value="${esc(f.name)}" placeholder="e.g. Systolic" required></label>
            <label class="field"><span>Unit</span><input name="fu_${f.id}" value="${esc(f.unit)}" placeholder="e.g. mmHg"></label>
          </div>
          <div class="grid3">
            <label class="field"><span>Decimals</span>
              <select name="fd_${f.id}">${[0, 1, 2, 3].map((n) => `<option ${f.decimals === n ? 'selected' : ''}>${n}</option>`).join('')}</select>
            </label>
            <label class="field"><span>Target min</span><input name="flo_${f.id}" inputmode="decimal" value="${num(f.targetMin) ? f.targetMin : ''}" placeholder="–"></label>
            <label class="field"><span>Target max</span><input name="fhi_${f.id}" inputmode="decimal" value="${num(f.targetMax) ? f.targetMax : ''}" placeholder="–"></label>
          </div>
          ${d.fields.length > 1 ? `<button type="button" class="link-btn danger" data-act="remove-field" data-fid="${f.id}">Remove “${esc(f.name || 'value ' + (i + 1))}”</button>` : ''}
        </div>`
        )
        .join('')}
      <button type="button" class="btn block" data-act="add-field">＋ Add another value</button>
      <p class="hint left">Example: blood pressure has three values — Systolic, Diastolic (mmHg) and Pulse (bpm).</p>
      <input type="hidden" name="numberShown" value="1">
      <label class="check-line">
        <input type="checkbox" name="sided" ${d.sided ? 'checked' : ''} ${d._sidedLocked ? 'disabled' : ''}>
        <span><b>Measure on left and right arm</b><small class="block">Each entry gets the values above for both arms, and the dashboard shows the difference (right − left).${d._sidedLocked ? ' Can’t be switched off once left/right data exists.' : ' Existing values become right arm.'}</small></span>
      </label>
      ${
        d.sided
          ? `<label class="field"><span>Flag an arm difference of <small>(${esc(d.fields[0]?.unit || 'units')}, compared on ${esc(d.fields.filter((f) => f.unit === d.fields[0]?.unit).map((f) => f.name).join(' and '))})</small></span>
              <input name="deltaAlert" inputmode="decimal" value="${num(d.deltaAlert) ? d.deltaAlert : 10}"></label>
             <p class="hint left">10 is a placeholder — set the threshold that applies to you.</p>`
          : ''
      }`;
  } else if (d.type === 'scale') {
    typeBody = `
      <div class="grid2">
        <label class="field"><span>From</span><select name="scaleMin">${[0, 1].map((n) => `<option ${d.scaleMin === n ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
        <label class="field"><span>To</span><select name="scaleMax">${[3, 4, 5, 6, 7, 8, 9, 10].map((n) => `<option ${d.scaleMax === n ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
        <label class="field"><span>Low label</span><input name="lowLabel" value="${esc(d.lowLabel)}" placeholder="e.g. None"></label>
        <label class="field"><span>High label</span><input name="highLabel" value="${esc(d.highLabel)}" placeholder="e.g. Worst"></label>
      </div>
      <label class="check-line">
        <input type="checkbox" name="defaultZero" ${d.defaultZero ? 'checked' : ''}>
        <span><b>No entry = 0</b><small class="block">Logging starts at 0 and the dashboard shows 0 on days without a score (e.g. no headache).</small></span>
      </label>`;
  } else if (d.type === 'count') {
    typeBody = `
      <div class="grid2">
        <label class="field"><span>Unit</span><input name="unit" value="${esc(d.unit)}" placeholder="e.g. ml"></label>
        <label class="field"><span>Amount per tap</span><input name="step" inputmode="decimal" value="${num(d.step) ? d.step : 1}" placeholder="1"></label>
        <label class="field"><span>Daily goal <small>(optional)</small></span><input name="dailyGoal" inputmode="decimal" value="${num(d.dailyGoal) ? d.dailyGoal : ''}" placeholder="–"></label>
      </div>
      <label class="check-line">
        <input type="checkbox" name="trackKind" ${d.trackKind ? 'checked' : ''}>
        <span><b>Record what each item was</b><small class="block">Free amount per item plus its type (e.g. 330 ml · Coffee). The dashboard breaks totals down by type.</small></span>
      </label>
      <label class="field"><span>Suggested types <small>(comma-separated)</small></span>
        <input name="kinds" value="${esc((d.kinds?.length ? d.kinds : DEFAULT_DRINKS).join(', '))}"></label>
      <p class="hint left">Counters add up per day. Without types, the quick button on Home adds the amount per tap; with types, it opens the form.</p>`;
  } else {
    typeBody = `<p class="hint left">One tap per day on the Log screen. Stats show completion rate and streaks.</p>`;
  }

  const body = `
    <div class="grid-icon">
      <label class="field"><span>Icon</span><input name="icon" value="${esc(d.icon)}" maxlength="4" class="icon-input"></label>
      <label class="field"><span>Name</span><input name="name" value="${esc(d.name)}" placeholder="e.g. Blood pressure" required ${d._new ? 'autofocus' : ''}></label>
    </div>
    <div class="field"><span>Color</span>
      <div class="swatches">${COLORS.map((c) => `<label><input type="radio" name="color" value="${c}" ${d.color === c ? 'checked' : ''}><span style="background:${c}"></span></label>`).join('')}</div>
    </div>
    <div class="field"><span>Type${d._locked ? ' <small>(fixed once entries exist)</small>' : ''}</span>
      <div class="seg wrap">${['number', 'scale', 'count', 'check'].map(typeOpt).join('')}</div>
    </div>
    ${typeBody}
    <p class="form-error" hidden></p>`;

  openSheet(d._new ? 'New tracker' : 'Edit tracker', body, {
    footer: d._new ? '' : `<button type="button" class="btn danger block" data-act="delete-tracker" data-id="${d.id}">Delete tracker and its entries</button>`,
    onSubmit(fd, form) {
      readDraft(form);
      if (!draft.name.trim()) return formError(form, 'Give the tracker a name.');
      if (draft.type === 'number' && draft.fields.some((f) => !f.name.trim())) return formError(form, 'Every value needs a name.');
      const { _new, _locked, _sidedLocked, sided, ...t } = draft;
      t.name = t.name.trim();
      if (t.type !== 'number') delete t.fields;
      if (t.type === 'number' && sided) {
        Object.assign(t, makeSided({ ...t, sides: undefined }, 10));
        if (!num(t.deltaAlert)) t.deltaAlert = 10;
      } else {
        delete t.sides;
        delete t.deltaAlert;
      }
      store.saveTracker(t);
      toast(_new ? 'Tracker created' : 'Tracker saved');
      draft = null;
    },
  });
}

/** Copy the editor's current inputs into the draft (so re-rendering keeps them). */
function readDraft(form) {
  const fd = new FormData(form);
  const d = draft;
  d.name = String(fd.get('name') ?? d.name);
  d.icon = String(fd.get('icon') ?? d.icon).trim() || '📊';
  d.color = fd.get('color') || d.color;
  d.type = fd.get('type') || d.type;
  if (fd.has('scaleMin')) {
    d.scaleMin = +fd.get('scaleMin');
    d.defaultZero = fd.has('defaultZero');
  }
  if (fd.has('scaleMax')) d.scaleMax = +fd.get('scaleMax');
  if (fd.has('lowLabel')) d.lowLabel = String(fd.get('lowLabel'));
  if (fd.has('highLabel')) d.highLabel = String(fd.get('highLabel'));
  if (fd.has('unit')) d.unit = String(fd.get('unit')).trim();
  if (fd.has('dailyGoal')) d.dailyGoal = parseNum(fd.get('dailyGoal'));
  if (fd.has('step')) d.step = parseNum(fd.get('step')) > 0 ? parseNum(fd.get('step')) : 1;
  if (fd.has('kinds')) {
    d.trackKind = fd.has('trackKind');
    d.kinds = String(fd.get('kinds')).split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (fd.has('numberShown')) {
    d.sided = d._sidedLocked || fd.has('sided');
    if (fd.has('deltaAlert')) d.deltaAlert = parseNum(fd.get('deltaAlert'));
  }
  for (const f of d.fields || []) {
    if (!fd.has('fn_' + f.id)) continue;
    f.name = String(fd.get('fn_' + f.id));
    f.unit = String(fd.get('fu_' + f.id)).trim();
    f.decimals = +fd.get('fd_' + f.id);
    f.targetMin = parseNum(fd.get('flo_' + f.id));
    f.targetMax = parseNum(fd.get('fhi_' + f.id));
  }
}

// ---- templates ----

// `mine: true` = the default setup offered on first launch.
const TEMPLATES = [
  { mine: true, name: 'Blood pressure', icon: '🩺', color: '#dc2626', type: 'number', sided: true, deltaAlert: 10, fields: [['Systolic', 'mmHg', 0, 90, 120], ['Diastolic', 'mmHg', 0, 60, 80], ['Pulse', 'bpm', 0, null, null]] },
  { mine: true, name: 'Liquid intake', icon: '🥤', color: '#0891b2', type: 'count', unit: 'ml', step: 250, dailyGoal: null, trackKind: true, kindLabel: 'Drink', kinds: DEFAULT_DRINKS },
  { mine: true, name: 'Headache', icon: '🤕', color: '#7c3aed', type: 'scale', scaleMin: 1, scaleMax: 10, lowLabel: 'Mild', highLabel: 'Severe', defaultZero: true },
  { name: 'Weight', icon: '⚖️', color: '#2563eb', type: 'number', fields: [['Weight', 'kg', 1, null, null]] },
  { name: 'Blood glucose', icon: '🩸', color: '#d97706', type: 'number', fields: [['Glucose', 'mmol/L', 1, 4, 7.8]] },
  { name: 'Sleep', icon: '😴', color: '#7c3aed', type: 'number', fields: [['Sleep', 'h', 1, 7, 9]] },
  { name: 'Mood', icon: '🙂', color: '#0d9488', type: 'scale', scaleMin: 1, scaleMax: 5, lowLabel: 'Very low', highLabel: 'Great' },
  { name: 'Pain', icon: '🩹', color: '#db2777', type: 'scale', scaleMin: 0, scaleMax: 10, lowLabel: 'None', highLabel: 'Worst' },
  { name: 'Water', icon: '💧', color: '#2563eb', type: 'count', unit: 'glasses', step: 1, dailyGoal: 8 },
  { name: 'Medication taken', icon: '💊', color: '#059669', type: 'check' },
];

function fromTemplate(tp) {
  const t = { id: store.uid(), name: tp.name, icon: tp.icon, color: tp.color, type: tp.type };
  if (tp.type === 'number') {
    t.fields = tp.fields.map(([name, unit, decimals, targetMin, targetMax]) => ({ ...newField(name, unit), decimals, targetMin, targetMax }));
  }
  if (tp.type === 'scale') Object.assign(t, { scaleMin: tp.scaleMin, scaleMax: tp.scaleMax, lowLabel: tp.lowLabel, highLabel: tp.highLabel, defaultZero: !!tp.defaultZero });
  if (tp.type === 'count') {
    Object.assign(t, { unit: tp.unit, step: tp.step || 1, dailyGoal: tp.dailyGoal });
    if (tp.trackKind) Object.assign(t, { trackKind: true, kindLabel: tp.kindLabel, kinds: [...tp.kinds] });
  }
  return tp.sided ? makeSided(t, tp.deltaAlert) : t;
}

function openTemplates() {
  const have = new Set(store.trackers().map((t) => t.name));
  const body = `
    <p class="muted small">Pick examples to add. You can edit names, units and targets afterwards. Targets are generic examples, not medical advice — set your own.</p>
    <div class="card list">
      ${TEMPLATES.map(
        (tp, i) => `
        <label class="row check-row" style="--c:${tp.color}">
          <input type="checkbox" name="tpl" value="${i}" ${have.has(tp.name) ? 'disabled' : tp.mine && !have.size ? 'checked' : ''}>
          <span class="ticon sm">${tp.icon}</span>
          <span class="rbody"><span class="rname">${esc(tp.name)}</span><span class="rnote">${TYPE_LABEL[tp.type]}${have.has(tp.name) ? ' · already added' : ''}</span></span>
        </label>`
      ).join('')}
    </div>
    <p class="form-error" hidden></p>`;
  openSheet('Examples', body, {
    onSubmit(fd, form) {
      const picks = fd.getAll('tpl').map(Number);
      if (!picks.length) return formError(form, 'Select at least one.');
      picks.forEach((i) => store.saveTracker(fromTemplate(TEMPLATES[i])));
      toast(`${picks.length} tracker${picks.length > 1 ? 's' : ''} added`);
    },
  });
}

// ---------- import / export ----------

async function shareOrDownload(filename, text, type) {
  const blob = new Blob([text], { type });
  const file = new File([blob], filename, { type });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename });
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

const stamp = () => S.dayKey(new Date());

function exportCsv() {
  const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const rows = [['date', 'time', 'tracker', 'value_name', 'value', 'unit', 'type', 'note'].join(',')];
  for (const e of store.entries().reverse()) {
    const t = store.tracker(e.trackerId);
    if (!t) continue;
    const d = new Date(e.ts);
    for (const f of store.fieldsOf(t)) {
      const v = e.values?.[f.id];
      if (!num(v)) continue;
      const side = f.side && t.sides?.find((s) => s.id === f.side);
      rows.push([S.dayKey(d), `${pad(d.getHours())}:${pad(d.getMinutes())}`, q(t.name), q(side ? `${side.name} ${f.name}` : f.name), v, q(f.unit), q(e.kind), q(e.note)].join(','));
    }
  }
  shareOrDownload(`trackstats-${stamp()}.csv`, rows.join('\n'), 'text/csv');
}

async function importFile(input) {
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const n = { trackers: data.trackers?.length ?? 0, entries: data.entries?.length ?? 0 };
    if (!confirm(`Restore ${n.trackers} trackers and ${n.entries} entries from “${file.name}”?\n\nThey are merged with what is here; items that exist in both are replaced by the backup version.`)) return;
    store.importData(data);
    migrate(); // older backups: e.g. blood pressure without left/right -> all values go to the right arm
    toast('Backup restored');
  } catch (err) {
    alert('Could not read that file: ' + err.message);
  }
}

// ---------- events ----------

document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-act]');
  if (!el || el.tagName === 'SELECT' || el.tagName === 'INPUT') return;
  const { act, id } = el.dataset;
  switch (act) {
    case 'log':
      return openLog(id);
    case 'edit-entry':
      return openLog(null, id);
    case 'quick-count': {
      const t = store.tracker(id);
      const step = stepOf(t);
      store.saveEntry({ id: store.uid(), trackerId: id, ts: new Date().toISOString(), values: { v: step }, note: '' });
      return toast(`+${fmt(step)} ${t.unit || t.name}`);
    }
    case 'quick-check':
      store.saveEntry({ id: store.uid(), trackerId: id, ts: new Date().toISOString(), values: { v: 1 }, note: '' });
      return toast(`${store.tracker(id).name}: done`);
    case 'undo-check': {
      const k = S.dayKey(new Date());
      store.entries(id).filter((e) => S.dayKey(e.ts) === k && e.values?.v === 1).forEach((e) => store.deleteEntry(e.id));
      return toast('Undone');
    }
    case 'delete-entry':
      if (confirm('Delete this entry?')) {
        store.deleteEntry(id);
        closeSheet();
        toast('Entry deleted');
      }
      return;
    case 'step': {
      const input = el.parentElement.querySelector('input');
      input.value = Math.max(0, (parseNum(input.value) || 0) + Number(el.dataset.d));
      return;
    }
    case 'close-sheet':
      return closeSheet();
    case 'pick-kind': {
      const input = el.closest('.drink-row').querySelector('input[name*="kind__"]');
      input.value = input.value === el.dataset.kind ? '' : el.dataset.kind;
      syncKindChips(input);
      const amount = el.closest('.drink-row').querySelector('input[name*="v__"]');
      if (!amount.value) amount.focus();
      return;
    }
    case 'add-drink': {
      const box = $(`.drinks[data-tracker="${el.dataset.tracker}"]`, sheet);
      box.insertAdjacentHTML('beforeend', drinkRow(store.tracker(el.dataset.tracker), el.dataset.prefix, box.children.length));
      box.lastElementChild.querySelector('input').focus();
      return;
    }
    case 'new-tracker':
      return openTrackerEditor();
    case 'edit-tracker':
      return openTrackerEditor(id);
    case 'templates':
      return openTemplates();
    case 'setup-mine': {
      const have = new Set(store.trackers().map((t) => t.name));
      const add = TEMPLATES.filter((tp) => tp.mine && !have.has(tp.name));
      add.forEach((tp) => store.saveTracker(fromTemplate(tp)));
      return toast(`${add.length} trackers added`);
    }
    case 'add-field':
      readDraft(el.form);
      draft.fields.push(newField());
      renderTrackerEditor();
      $(`[name="fn_${draft.fields.at(-1).id}"]`, sheet)?.focus();
      return;
    case 'remove-field':
      readDraft(el.form);
      draft.fields = draft.fields.filter((f) => f.id !== el.dataset.fid);
      return renderTrackerEditor();
    case 'delete-tracker': {
      const t = store.tracker(id);
      const n = store.entries(id).length;
      if (confirm(`Delete “${t.name}”${n ? ` and its ${n} entries` : ''}? This cannot be undone.`)) {
        store.deleteTracker(id);
        closeSheet();
        toast('Tracker deleted');
      }
      return;
    }
    case 'move':
      return store.moveTracker(id, Number(el.dataset.dir));
    case 'new-entry':
      return openNewEntry(el.dataset.day);
    case 'merge-dups': {
      const groups = store.duplicateGroups();
      const lines = groups.map((g) => `• ${g[0].name}: ${g.length} trackers`).join('\n');
      if (!confirm(`Merge into one tracker each?\n\n${lines}\n\nAll entries are kept and moved to the tracker with the most entries. Exact duplicate entries are removed.`)) return;
      const n = store.mergeDuplicates();
      migrate();
      return toast(`Merged ${n} duplicate tracker${n === 1 ? '' : 's'}`);
    }
    case 'go-dashboard':
      ui.tab = 'dashboard';
      ui.dashMode = 'day';
      ui.dashDay = S.dayKey(new Date());
      saveUi();
      render();
      return window.scrollTo(0, 0);
    case 'dash-mode':
      ui.dashMode = el.dataset.mode;
      saveUi();
      return renderDashboard();
    case 'dash-range':
      ui.dashRange = el.dataset.range === 'all' ? 'all' : Number(el.dataset.range);
      ui.tableAll = false;
      saveUi();
      return renderDashboard();
    case 'day-shift': {
      const next = S.dayKey(S.addDays(new Date(ui.dashDay + 'T12:00:00'), Number(el.dataset.d)));
      if (next <= S.dayKey(new Date())) ui.dashDay = next;
      return renderDashboard();
    }
    case 'goto-day':
      ui.dashMode = 'day';
      ui.dashDay = el.dataset.day;
      saveUi();
      renderDashboard();
      return window.scrollTo(0, 0);
    case 'table-all':
      ui.tableAll = true;
      return renderDashboard();
    case 'ov-toggle': {
      const hidden = new Set(ui.ovHidden || []);
      if (hidden.has(el.dataset.key)) hidden.delete(el.dataset.key);
      else hidden.add(el.dataset.key);
      ui.ovHidden = [...hidden];
      saveUi();
      return renderDashboard();
    }
    case 'more-history':
      ui.historyLimit += 300;
      return renderHistory();
    case 'export-json':
      return shareOrDownload(`trackstats-backup-${stamp()}.json`, JSON.stringify(store.exportData(), null, 1), 'application/json');
    case 'export-csv':
      return exportCsv();
    case 'erase':
      if (confirm('Erase ALL trackers and entries on this device? Export a backup first if you might need them.') && confirm('Really erase everything?')) {
        store.eraseAll();
        toast('All data erased');
      }
      return;
  }
});

document.addEventListener('change', (ev) => {
  const el = ev.target;
  if (el.dataset.act === 'history-filter') {
    ui.historyFilter = el.value;
    ui.historyLimit = 150;
    saveUi();
    renderHistory();
  } else if (el.dataset.act === 'day-pick') {
    if (el.value) ui.dashDay = el.value > S.dayKey(new Date()) ? S.dayKey(new Date()) : el.value;
    renderDashboard();
  } else if (el.dataset.act === 'import') {
    importFile(el);
  } else if (el.name === 'type' && draft && sheet.contains(el)) {
    readDraft(el.form);
    renderTrackerEditor();
  }
});

function syncKindChips(input) {
  const v = input.value.trim().toLowerCase();
  $$('.kchip', input.closest('.drink-row')).forEach((c) => c.classList.toggle('on', c.dataset.kind.toLowerCase() === v));
}
document.addEventListener('input', (ev) => {
  if (ev.target.name?.includes('kind__')) syncKindChips(ev.target);
});

$$('.tabbar button').forEach((b) =>
  b.addEventListener('click', () => {
    ui.tab = b.dataset.tab;
    saveUi();
    render();
    window.scrollTo(0, 0);
  })
);

/**
 * Upgrades trackers made by older versions. Runs at start-up and after restoring a backup
 * (a backup carries the old tracker definitions). Entries are never rewritten:
 * blood pressure values recorded before left/right existed keep their field ids, which are the right-arm ids.
 */
function migrate() {
  for (const t of store.trackers()) {
    if (t.type === 'scale' && t.name === 'Headache' && t.defaultZero === undefined) store.saveTracker({ ...t, defaultZero: true });
    if (t.type === 'count' && t.name === 'Liquid intake' && t.trackKind === undefined) {
      store.saveTracker({ ...t, trackKind: true, kindLabel: 'Drink', kinds: [...DEFAULT_DRINKS] });
    }
    if (t.type === 'number' && t.name === 'Blood pressure' && !isSided(t)) store.saveTracker(makeSided(t));
  }
}
migrate();

store.onChange(render);

// Tapping the day title in the dashboard opens the date picker.
document.addEventListener('click', (ev) => {
  const input = ev.target.closest('.daypick')?.querySelector('input');
  if (input && input.showPicker) {
    try {
      input.showPicker();
    } catch {
      /* not allowed here; the native input still works */
    }
  }
});

// Re-render when returning to the app (e.g. "today" rolled over to a new day).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !sheet.open) render();
});

render();

// Offline support + ask the browser to keep our storage.
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('SW registration failed', err));
}
navigator.storage?.persist?.().catch(() => {});

import * as store from './store.js';
import * as S from './stats.js';
import { lineChart, barChart, calendar, emptyChart } from './charts.js';

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
const DASH_RANGE_VALUES = [3, 7, 30, 90, 365];
const ui = Object.assign(
  { tab: 'today', dashMode: 'day', dashRange: 7, dashDay: null, tableAll: false, historyFilter: 'all', historyLimit: 150 },
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
    localStorage.setItem(UI_KEY, JSON.stringify({ tab: ui.tab, dashMode: ui.dashMode, dashRange: ui.dashRange, historyFilter: ui.historyFilter }));
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
      return `${fmt(v.v)}${units && t.unit ? ' ' + esc(t.unit) : ''}`;
    case 'scale':
      return units ? `${fmt(v.v)} / ${t.scaleMax}` : fmt(v.v);
    default: {
      const groups = [];
      for (const f of store.fieldsOf(t)) {
        if (!num(v[f.id])) continue;
        const last = groups[groups.length - 1];
        const val = fmt(v[f.id], f.decimals);
        if (last && last.unit === f.unit && f.unit) last.vals.push(val);
        else groups.push({ unit: f.unit, vals: [val] });
      }
      if (!groups.length) return '–';
      return groups.map((g) => g.vals.join('/') + (units && g.unit ? ' ' + esc(g.unit) : '')).join(' · ');
    }
  }
}

function todaySummary(t) {
  const list = store.entries(t.id);
  const todayKey = S.dayKey(new Date());
  const today = list.filter((e) => S.dayKey(e.ts) === todayKey);
  if (t.type === 'count') {
    const sum = today.reduce((a, e) => a + (e.values?.v || 0), 0);
    const goal = t.dailyGoal > 0 ? ` of ${fmt(t.dailyGoal)}` : '';
    return { text: `Today: <b>${fmt(sum)}</b>${goal}${t.unit ? ' ' + esc(t.unit) : ''}`, done: t.dailyGoal > 0 && sum >= t.dailyGoal };
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
          if (t.type === 'count') {
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
 *  measurement -> per value: mean, min, max, n
 *  counter     -> total
 *  scale       -> highest and mean (0 when "no entry = 0" and nothing was logged)
 *  yes/no      -> done or not
 */
function dayAggregate(t, list = []) {
  if (t.type === 'number') {
    return { n: list.length, fields: store.fieldsOf(t).map((f) => ({ f, st: S.fieldStats(S.points(list, f.id), f) })) };
  }
  if (t.type === 'count') {
    return { n: list.length, total: list.reduce((a, e) => a + (num(e.values?.v) ? e.values.v : 0), 0) };
  }
  if (t.type === 'scale') {
    const v = scaleVals(list);
    if (!v.length) return { n: 0, max: t.defaultZero ? 0 : null, mean: t.defaultZero ? 0 : null };
    return { n: v.length, max: Math.max(...v), mean: v.reduce((a, b) => a + b, 0) / v.length };
  }
  return { n: list.length, yes: list.some((e) => e.values?.v === 1) };
}

/** Compact text of a day aggregate (table cells). */
function aggregateText(t, a) {
  if (t.type === 'number') {
    if (!a.n) return '–';
    const values = {};
    a.fields.forEach(({ f, st }) => st && (values[f.id] = st.mean));
    return formatEntry(t, { values }, false);
  }
  if (t.type === 'count') return fmt(a.total);
  if (t.type === 'scale') return a.max == null ? '–' : fmt(a.max);
  return a.yes ? '✓' : '–';
}

function aggregateClass(t, a) {
  if (t.type === 'number') return a.fields.some(({ f, st }) => st && outOfTarget(f, st.mean)) ? 'warn' : a.n ? '' : 'dim';
  if (t.type === 'scale') return a.n ? (a.max > 0 ? 'strong' : '') : 'dim';
  return a.n ? '' : 'dim';
}

/** Short unit label for a table column header. */
function columnUnit(t) {
  if (t.type === 'count') return t.unit || 'total';
  if (t.type === 'scale') return `0–${t.scaleMax}`;
  if (t.type === 'check') return 'done';
  return store.fieldsOf(t)[0]?.unit || '';
}

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
      <button data-act="dash-mode" data-mode="day" aria-pressed="${ui.dashMode === 'day'}">Day</button>
      <button data-act="dash-mode" data-mode="period" aria-pressed="${ui.dashMode === 'period'}">Multi-day</button>
    </div>`;
  view.innerHTML = modeSeg + (ui.dashMode === 'day' ? dayView(list) : periodView(list));
}

// ---- single day ----

function daySummaryCard(t, list) {
  const a = dayAggregate(t, list);
  let sub = '';
  let tiles = '';
  if (t.type === 'number') {
    sub = a.n ? `${plural(a.n, 'reading', 'readings')} · daily average` : 'No readings';
    tiles = a.fields
      .filter((x) => x.st)
      .map(({ f, st }) =>
        tile(esc(f.name), fmt(st.mean, f.decimals), [esc(f.unit), st.min !== st.max ? `${fmt(st.min, f.decimals)}–${fmt(st.max, f.decimals)}` : ''].filter(Boolean).join(' · '), outOfTarget(f, st.mean) ? 'warn' : '')
      )
      .join('');
  } else if (t.type === 'count') {
    sub = a.n ? plural(a.n, 'entry', 'entries') : 'Nothing logged';
    const goal = t.dailyGoal > 0 ? `${pct(a.total / t.dailyGoal)} of ${fmt(t.dailyGoal)} goal` : '';
    tiles = tile('Total', fmt(a.total), [esc(t.unit), goal].filter(Boolean).join(' · '));
  } else if (t.type === 'scale') {
    sub = a.n ? plural(a.n, 'score', 'scores') : t.defaultZero ? 'No score logged — counts as 0' : 'No score';
    tiles = a.max == null ? '' : tile('Highest', fmt(a.max), `of ${t.scaleMax}`) + (a.n > 1 ? tile('Average', fmt(a.mean, 1)) : '');
  } else {
    tiles = tile('Done', a.yes ? 'Yes' : 'No');
  }
  return `<section class="card stat-block" style="--c:${t.color}">${cardTitle(t, sub)}${tiles ? `<div class="tiles">${tiles}</div>` : ''}</section>`;
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
  if (t.type === 'number') {
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
      </div>`;
  } else if (t.type === 'scale') {
    const daily = S.eachDay(start, end)
      .map((d) => {
        const v = scaleVals(dayMap.get(S.dayKey(d)) || []);
        return { t: new Date(d.getTime() + 12 * 3600e3), v: v.length ? Math.max(...v) : t.defaultZero ? 0 : null };
      })
      .filter((p) => num(p.v));
    const vals = daily.map((p) => p.v);
    const mean = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    const above = vals.filter((v) => v > 0).length;
    body =
      lineChart({ series: [{ name: t.name, color: t.color, points: daily }], xStart: start, xEnd: end, yRange: [t.defaultZero ? 0 : t.scaleMin, t.scaleMax], label: `${t.name} per day` }) +
      `<div class="tiles">
        ${tile('Daily avg', fmt(mean, 1), t.defaultZero ? 'incl. 0 days' : '')}
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

function periodView(list) {
  const today = S.startOfDay(new Date());
  const end = S.endOfDay(today);
  let start = S.addDays(today, -(ui.dashRange - 1));
  // Don't count days before tracking began.
  const all = store.entries();
  let clamped = false;
  if (all.length) {
    const first = S.startOfDay(all[all.length - 1].ts);
    if (first > start) {
      start = first;
      clamped = true;
    }
  }
  const days = S.eachDay(start, end);
  const groups = new Map(list.map((t) => [t.id, byDay(S.inPeriod(store.entries(t.id), start, end))]));
  const rows = days.slice().reverse();
  const shown = ui.tableAll ? rows : rows.slice(0, 31);
  const startLabel = start.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: start.getFullYear() === today.getFullYear() ? undefined : 'numeric' });

  return `
    <div class="seg" role="group" aria-label="Period">
      ${DASH_RANGES.map(([r, l]) => `<button data-act="dash-range" data-range="${r}" aria-pressed="${ui.dashRange === r}">${l}</button>`).join('')}
    </div>
    <p class="muted small period-note">${startLabel} – today · ${plural(days.length, 'day', 'days')}${clamped ? ' (since tracking began)' : ''}</p>
    ${list.map((t) => periodCard(t, start, end, groups.get(t.id))).join('')}
    <h3 class="section">Day by day</h3>
    <div class="card table-wrap">
      <table class="daytable">
        <thead><tr><th>Day</th>${list.map((t) => `<th title="${esc(t.name)}">${esc(t.icon)}<small>${esc(columnUnit(t))}</small></th>`).join('')}</tr></thead>
        <tbody>
          ${shown
            .map((d) => {
              const k = S.dayKey(d);
              const cells = list
                .map((t) => {
                  const a = dayAggregate(t, groups.get(t.id).get(k));
                  return `<td class="${aggregateClass(t, a)}">${aggregateText(t, a)}</td>`;
                })
                .join('');
              return `<tr data-act="goto-day" data-day="${k}"><td>${d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}</td>${cells}</tr>`;
            })
            .join('')}
        </tbody>
      </table>
    </div>
    ${rows.length > shown.length ? `<button class="btn block" data-act="table-all">Show all ${rows.length} days</button>` : ''}
    <p class="hint">Per day: measurements are averaged, counters are summed, scores show the day’s highest${list.some((t) => t.defaultZero) ? ' (0 when none logged)' : ''}. Red = average outside target. Tap a day to open it.</p>`;
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
function valueInputs(t, vals, prefix, { fresh = false, autofocus = false, hintLast = false } = {}) {
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
    <div class="field" style="--c:${t.color}">${valueInputs(t, e?.values || {}, 'f_', { autofocus: true, hintLast: !e })}</div>
    ${whenInputs(e ? new Date(e.ts) : new Date())}
    <label class="field"><span>Note <small>(optional)</small></span><textarea name="note" rows="2" placeholder="e.g. after exercise">${esc(e?.note || '')}</textarea></label>
    <p class="form-error" hidden></p>`;

  openSheet(e ? 'Edit entry' : 'Log', body, {
    footer: e ? `<button type="button" class="btn danger block" data-act="delete-entry" data-id="${e.id}">Delete entry</button>` : '',
    onSubmit(fd, form) {
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
      <p class="hint left">Example: blood pressure has three values — Systolic, Diastolic (mmHg) and Pulse (bpm).</p>`;
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
      <p class="hint left">Counters add up per day. The quick button on the Log screen adds the amount per tap (e.g. +250 ml for a glass); tap the tracker to log a different amount.</p>`;
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
      const { _new, _locked, ...t } = draft;
      t.name = t.name.trim();
      if (t.type !== 'number') delete t.fields;
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
  { mine: true, name: 'Blood pressure', icon: '🩺', color: '#dc2626', type: 'number', fields: [['Systolic', 'mmHg', 0, 90, 120], ['Diastolic', 'mmHg', 0, 60, 80], ['Pulse', 'bpm', 0, null, null]] },
  { mine: true, name: 'Liquid intake', icon: '🥤', color: '#0891b2', type: 'count', unit: 'ml', step: 250, dailyGoal: null },
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
  if (tp.type === 'count') Object.assign(t, { unit: tp.unit, step: tp.step || 1, dailyGoal: tp.dailyGoal });
  return t;
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
  const rows = [['date', 'time', 'tracker', 'value_name', 'value', 'unit', 'note'].join(',')];
  for (const e of store.entries().reverse()) {
    const t = store.tracker(e.trackerId);
    if (!t) continue;
    const d = new Date(e.ts);
    for (const f of store.fieldsOf(t)) {
      const v = e.values?.[f.id];
      if (!num(v)) continue;
      rows.push([S.dayKey(d), `${pad(d.getHours())}:${pad(d.getMinutes())}`, q(t.name), q(f.name), v, q(f.unit), q(e.note)].join(','));
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
      ui.dashRange = Number(el.dataset.range);
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

$$('.tabbar button').forEach((b) =>
  b.addEventListener('click', () => {
    ui.tab = b.dataset.tab;
    saveUi();
    render();
    window.scrollTo(0, 0);
  })
);

// One-time upgrade: Headache trackers created before "no entry = 0" existed get it switched on.
for (const t of store.trackers()) {
  if (t.type === 'scale' && t.name === 'Headache' && t.defaultZero === undefined) store.saveTracker({ ...t, defaultZero: true });
}

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

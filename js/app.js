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
const ui = Object.assign(
  { tab: 'today', statsTracker: null, statsRange: 30, historyFilter: 'all', historyLimit: 150 },
  (() => {
    try {
      return JSON.parse(localStorage.getItem(UI_KEY)) || {};
    } catch {
      return {};
    }
  })()
);
ui.historyLimit = 150;
function saveUi() {
  try {
    localStorage.setItem(UI_KEY, JSON.stringify({ tab: ui.tab, statsTracker: ui.statsTracker, statsRange: ui.statsRange, historyFilter: ui.historyFilter }));
  } catch {
    /* ignore */
  }
}

// ---------- value formatting ----------

/** "128/82 mmHg · 64 bpm" style text for one entry. */
function formatEntry(t, e) {
  const v = e.values || {};
  switch (t.type) {
    case 'check':
      return v.v === 1 ? 'Yes' : 'No';
    case 'count':
      return `${fmt(v.v)}${t.unit ? ' ' + esc(t.unit) : ''}`;
    case 'scale':
      return `${fmt(v.v)} / ${t.scaleMax}`;
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
      return groups.map((g) => g.vals.join('/') + (g.unit ? ' ' + esc(g.unit) : '')).join(' · ');
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
  ({ today: renderToday, history: renderHistory, stats: renderStats, trackers: renderTrackers })[ui.tab]();
}

function emptyState() {
  return `
    <div class="empty">
      <div class="empty-icon">📈</div>
      <h2>Track what matters to you</h2>
      <p>Create your own trackers: measurements with units, 1–10 scales, counters or daily yes/no checks.</p>
      <button class="btn primary" data-act="new-tracker">Create a tracker</button>
      <button class="btn" data-act="templates">Start from examples</button>
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
    <div class="cards">
      ${list
        .map((t) => {
          const s = todaySummary(t);
          let quick = '';
          if (t.type === 'count') quick = `<button class="quick" data-act="quick-count" data-id="${t.id}" aria-label="Add 1 to ${esc(t.name)}">+1</button>`;
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
    <p class="hint">Tap a tracker to log a value with date, time and note.</p>`;
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
    html += `
      <button class="row" data-act="edit-entry" data-id="${e.id}" style="--c:${t.color}">
        <span class="ticon sm">${esc(t.icon || '•')}</span>
        <span class="rbody">
          <span class="rtop"><span class="rname">${esc(t.name)}</span><span class="rval">${formatEntry(t, e)}</span></span>
          <span class="rnote">${timeOf(d)}${e.note ? ` · ${esc(e.note)}` : ''}</span>
        </span>
      </button>`;
  }
  html += '</div></div>';
  if (all.length > shown.length) html += `<button class="btn block" data-act="more-history">Show more (${all.length - shown.length} older)</button>`;
  view.innerHTML = html;
}

const RANGES = [
  [7, '7D'],
  [30, '30D'],
  [90, '90D'],
  [365, '1Y'],
  ['all', 'All'],
];

function tile(label, value, sub = '') {
  return `<div class="tile"><span class="tl">${label}</span><span class="tv">${value}</span>${sub ? `<span class="ts">${sub}</span>` : ''}</div>`;
}

function renderStats() {
  const list = store.trackers();
  setTop('Stats');
  if (!list.length) {
    view.innerHTML = emptyState();
    return;
  }
  let t = store.tracker(ui.statsTracker) || list[0];
  ui.statsTracker = t.id;
  const all = store.entries(t.id);
  // Never start the period before the first entry, so long ranges don't count days before tracking began.
  let start = S.rangeStart(ui.statsRange, all);
  const firstDay = all.length ? S.startOfDay(all[all.length - 1].ts) : null;
  if (firstDay && firstDay > start) start = firstDay < S.addDays(S.startOfDay(new Date()), -6) ? firstDay : S.addDays(S.startOfDay(new Date()), -6);
  const end = S.endOfDay(new Date());
  const period = S.inPeriod(all, start, end);

  let html = `
    <div class="chips" role="tablist">
      ${list.map((x) => `<button class="chip" role="tab" aria-selected="${x.id === t.id}" data-act="stats-tracker" data-id="${x.id}" style="--c:${x.color}">${esc(x.icon)} ${esc(x.name)}</button>`).join('')}
    </div>
    <div class="seg" role="group" aria-label="Period">
      ${RANGES.map(([r, l]) => `<button data-act="stats-range" data-range="${r}" aria-pressed="${String(ui.statsRange) === String(r)}">${l}</button>`).join('')}
    </div>`;

  const days = S.eachDay(start, end);
  const periodLabel = `${start.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })} – today · ${days.length} days · ${period.length} entries`;

  if (t.type === 'number' || t.type === 'scale') {
    const fields = store.fieldsOf(t);
    const series = [];
    const bands = [];
    let sections = '';
    let anyDense = false;
    fields.forEach((f, i) => {
      const pts = S.points(period, f.id);
      const st = S.fieldStats(pts, t.type === 'scale' ? {} : f);
      const color = seriesColor(t, i);
      const dense = pts.length > 120;
      anyDense ||= dense;
      series.push({ name: f.name, color, points: dense ? S.dailyMeans(pts) : pts });
      if (num(f.targetMin) || num(f.targetMax)) bands.push({ min: f.targetMin, max: f.targetMax, color });
      const dp = t.type === 'scale' ? 1 : f.decimals;
      const unit = ''; // unit is shown in the section heading; tiles stay compact
      const change = st && st.n > 1 ? `${st.change > 0 ? '+' : ''}${fmt(st.change, dp)}` : '–';
      sections += `
        <section class="card stat-block">
          <h3><span class="dot" style="background:${color}"></span>${esc(fields.length > 1 || t.type === 'number' ? f.name : 'Score')}${f.unit ? ` <small>(${esc(f.unit)})</small>` : ''}</h3>
          ${
            st
              ? `<div class="tiles">
                  ${tile('Average', fmt(st.mean, dp) + unit, `± ${fmt(st.sd, dp)}`)}
                  ${tile('Latest', fmt(st.latest, dp) + unit, `change ${change}`)}
                  ${tile('Lowest', fmt(st.min, dp) + unit)}
                  ${tile('Highest', fmt(st.max, dp) + unit)}
                  ${st.inTarget != null ? tile('In target', pct(st.inTarget), targetText(f)) : tile('Entries', fmt(st.n))}
                </div>`
              : '<p class="muted">No values in this period.</p>'
          }
        </section>`;
    });
    html += `
      <section class="card chart-card">
        <p class="muted small">${periodLabel}${anyDense ? ' · daily averages' : ''}</p>
        ${lineChart({ series, xStart: start, xEnd: end, bands, label: `${t.name} over time` })}
        ${fields.length > 1 ? `<div class="legend">${series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('')}</div>` : ''}
      </section>
      ${sections}`;
  } else if (t.type === 'count') {
    const daily = S.dailyTotals(period, start, end);
    const st = S.countStats(daily, t.dailyGoal);
    const bars = daily.length > 92 ? S.weekly(daily) : daily;
    const unit = '';
    html += `
      <section class="card chart-card">
        <p class="muted small">${periodLabel}${daily.length > 92 ? ' · weekly totals' : ''}</p>
        ${barChart({ bars, color: t.color, goal: daily.length > 92 ? (t.dailyGoal || 0) * 7 : t.dailyGoal, xStart: start, xEnd: end, label: `${t.name} per day` })}
      </section>
      <section class="card stat-block">
        <h3><span class="dot" style="background:${t.color}"></span>${esc(t.name)}${t.unit ? ` <small>(${esc(t.unit)})</small>` : ''}</h3>
        <div class="tiles">
          ${tile('Per day', fmt(st.perDay, 1) + unit)}
          ${tile('Total', fmt(st.total) + unit)}
          ${tile('Best day', fmt(st.best) + unit)}
          ${tile('Active days', `${st.activeDays}<small> / ${st.days}</small>`)}
          ${st.goalDays != null ? tile('Goal reached', `${st.goalDays}<small> days</small>`, `goal ${fmt(t.dailyGoal)}/day`) : ''}
        </div>
      </section>`;
  } else {
    const st = S.checkStats(all, start, end);
    html += `
      <section class="card chart-card">
        <p class="muted small">${periodLabel}</p>
        ${calendar({ days, doneSet: st.doneSet, keyOf: S.dayKey, color: t.color, label: `${t.name} calendar` })}
      </section>
      <section class="card stat-block">
        <div class="tiles">
          ${tile('Done', pct(st.pct), `${st.done} of ${st.days} days`)}
          ${tile('Current streak', `${st.streak}<small> days</small>`)}
          ${tile('Best streak', `${st.best}<small> days</small>`)}
        </div>
      </section>`;
  }
  view.innerHTML = html;
  $('.chip[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'center' });
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

// ---- log / edit entry ----

function openLog(trackerId, entryId) {
  const e = entryId ? store.entry(entryId) : null;
  const t = store.tracker(e ? e.trackerId : trackerId);
  if (!t) return;
  const vals = e?.values || {};
  const last = store.entries(t.id)[0];
  let inputs = '';
  if (t.type === 'number') {
    inputs = store.fieldsOf(t)
      .map(
        (f, i) => `
        <label class="field">
          <span>${esc(f.name)}${f.unit ? ` <small>(${esc(f.unit)})</small>` : ''}</span>
          <input name="f_${f.id}" type="text" inputmode="decimal" autocomplete="off" ${i === 0 ? 'autofocus' : ''}
            value="${num(vals[f.id]) ? vals[f.id] : ''}" placeholder="${last && num(last.values?.[f.id]) ? 'last: ' + fmt(last.values[f.id], f.decimals) : ''}">
        </label>`
      )
      .join('');
  } else if (t.type === 'scale') {
    const cur = num(vals.v) ? vals.v : null;
    let btns = '';
    for (let v = t.scaleMin; v <= t.scaleMax; v++) {
      btns += `<label class="scale-opt"><input type="radio" name="f_v" value="${v}" ${cur === v ? 'checked' : ''}><span>${v}</span></label>`;
    }
    inputs = `
      <div class="field"><span>${esc(t.name)}</span>
        <div class="scale" style="--n:${t.scaleMax - t.scaleMin + 1}">${btns}</div>
        <div class="scale-labels"><small>${esc(t.lowLabel || '')}</small><small>${esc(t.highLabel || '')}</small></div>
      </div>`;
  } else if (t.type === 'check') {
    const cur = e ? vals.v : 1;
    inputs = `
      <div class="field"><span>${esc(t.name)}</span>
        <div class="seg big">
          <label><input type="radio" name="f_v" value="1" ${cur === 1 ? 'checked' : ''}><span>Yes</span></label>
          <label><input type="radio" name="f_v" value="0" ${cur === 0 ? 'checked' : ''}><span>No</span></label>
        </div>
      </div>`;
  } else {
    inputs = `
      <label class="field"><span>Amount${t.unit ? ` <small>(${esc(t.unit)})</small>` : ''}</span>
        <div class="stepper">
          <button type="button" data-act="step" data-d="-1" aria-label="Less">−</button>
          <input name="f_v" type="text" inputmode="decimal" value="${num(vals.v) ? vals.v : 1}">
          <button type="button" data-act="step" data-d="1" aria-label="More">+</button>
        </div>
      </label>`;
  }

  const when = e ? new Date(e.ts) : new Date();
  const body = `
    <div class="sheet-tracker" style="--c:${t.color}"><span class="ticon">${esc(t.icon || '•')}</span>${esc(t.name)}</div>
    ${inputs}
    <label class="field"><span>When</span><input name="ts" type="datetime-local" value="${toLocalInput(when)}" required></label>
    <label class="field"><span>Note <small>(optional)</small></span><textarea name="note" rows="2" placeholder="e.g. after exercise">${esc(e?.note || '')}</textarea></label>
    <p class="form-error" hidden></p>`;

  openSheet(e ? 'Edit entry' : 'Log', body, {
    footer: e ? `<button type="button" class="btn danger block" data-act="delete-entry" data-id="${e.id}">Delete entry</button>` : '',
    onSubmit(fd, form) {
      const values = {};
      for (const f of store.fieldsOf(t)) {
        const v = parseNum(fd.get('f_' + f.id));
        if (v != null) values[f.id] = v;
      }
      if (!Object.keys(values).length) return formError(form, t.type === 'scale' ? 'Pick a value.' : 'Enter a value.');
      const ts = new Date(fd.get('ts'));
      if (isNaN(ts)) return formError(form, 'Enter a valid date and time.');
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
      </div>`;
  } else if (d.type === 'count') {
    typeBody = `
      <div class="grid2">
        <label class="field"><span>Unit</span><input name="unit" value="${esc(d.unit)}" placeholder="e.g. glasses"></label>
        <label class="field"><span>Daily goal <small>(optional)</small></span><input name="dailyGoal" inputmode="decimal" value="${num(d.dailyGoal) ? d.dailyGoal : ''}" placeholder="–"></label>
      </div>
      <p class="hint left">Counters add up per day. Tap +1 on the Log screen each time.</p>`;
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
  if (fd.has('scaleMin')) d.scaleMin = +fd.get('scaleMin');
  if (fd.has('scaleMax')) d.scaleMax = +fd.get('scaleMax');
  if (fd.has('lowLabel')) d.lowLabel = String(fd.get('lowLabel'));
  if (fd.has('highLabel')) d.highLabel = String(fd.get('highLabel'));
  if (fd.has('unit')) d.unit = String(fd.get('unit')).trim();
  if (fd.has('dailyGoal')) d.dailyGoal = parseNum(fd.get('dailyGoal'));
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

const TEMPLATES = [
  { name: 'Blood pressure', icon: '🩺', color: '#dc2626', type: 'number', fields: [['Systolic', 'mmHg', 0, 90, 120], ['Diastolic', 'mmHg', 0, 60, 80], ['Pulse', 'bpm', 0, null, null]] },
  { name: 'Weight', icon: '⚖️', color: '#2563eb', type: 'number', fields: [['Weight', 'kg', 1, null, null]] },
  { name: 'Blood glucose', icon: '🩸', color: '#d97706', type: 'number', fields: [['Glucose', 'mmol/L', 1, 4, 7.8]] },
  { name: 'Sleep', icon: '😴', color: '#7c3aed', type: 'number', fields: [['Sleep', 'h', 1, 7, 9]] },
  { name: 'Mood', icon: '🙂', color: '#0d9488', type: 'scale', scaleMin: 1, scaleMax: 5, lowLabel: 'Very low', highLabel: 'Great' },
  { name: 'Pain', icon: '🤕', color: '#db2777', type: 'scale', scaleMin: 0, scaleMax: 10, lowLabel: 'None', highLabel: 'Worst' },
  { name: 'Water', icon: '💧', color: '#0891b2', type: 'count', unit: 'glasses', dailyGoal: 8 },
  { name: 'Medication taken', icon: '💊', color: '#059669', type: 'check' },
];

function fromTemplate(tp) {
  const t = { id: store.uid(), name: tp.name, icon: tp.icon, color: tp.color, type: tp.type };
  if (tp.type === 'number') {
    t.fields = tp.fields.map(([name, unit, decimals, targetMin, targetMax]) => ({ ...newField(name, unit), decimals, targetMin, targetMax }));
  }
  if (tp.type === 'scale') Object.assign(t, { scaleMin: tp.scaleMin, scaleMax: tp.scaleMax, lowLabel: tp.lowLabel, highLabel: tp.highLabel });
  if (tp.type === 'count') Object.assign(t, { unit: tp.unit, dailyGoal: tp.dailyGoal });
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
          <input type="checkbox" name="tpl" value="${i}" ${have.has(tp.name) ? 'disabled' : ''}>
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
      store.saveEntry({ id: store.uid(), trackerId: id, ts: new Date().toISOString(), values: { v: 1 }, note: '' });
      return toast(`+1 ${t.unit || t.name}`);
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
    case 'stats-tracker':
      ui.statsTracker = id;
      saveUi();
      return renderStats();
    case 'stats-range':
      ui.statsRange = el.dataset.range === 'all' ? 'all' : Number(el.dataset.range);
      saveUi();
      return renderStats();
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

store.onChange(render);

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

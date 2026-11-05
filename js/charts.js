// Tiny dependency-free SVG charts. Colors come from CSS variables so they follow light/dark mode.

const W = 340;
const H = 190;
const P = { l: 38, r: 10, t: 12, b: 26 };
const PW = W - P.l - P.r;
const PH = H - P.t - P.b;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const shortDate = (d) => `${d.getDate()} ${MONTHS[d.getMonth()]}`;

function niceScale(min, max, count = 4) {
  if (min === max) {
    const pad = Math.abs(min) * 0.1 || 1;
    min -= pad;
    max += pad;
  }
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Number(v.toFixed(10)));
  return { lo, hi, ticks, step };
}

function fmtTick(v, step) {
  const dp = step >= 1 ? 0 : Math.min(3, Math.ceil(-Math.log10(step)));
  return v.toFixed(dp);
}

function frame(inner, label) {
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${label}">${inner}</svg>`;
}

function xAxis(xStart, xEnd, sx) {
  const mid = new Date((xStart.getTime() + xEnd.getTime()) / 2);
  const seen = new Set();
  return [
    [xStart, 'start'],
    [xEnd, 'end'],
    [mid, 'middle'],
  ]
    .filter(([d]) => !seen.has(shortDate(d)) && seen.add(shortDate(d)))
    .map(([d, anchor]) => `<text class="ax" x="${sx(d)}" y="${H - 8}" text-anchor="${anchor}">${shortDate(d)}</text>`)
    .join('');
}

function yAxis(scale, sy) {
  return scale.ticks
    .map(
      (v) =>
        `<line class="grid" x1="${P.l}" x2="${W - P.r}" y1="${sy(v)}" y2="${sy(v)}"/>` +
        `<text class="ax" x="${P.l - 6}" y="${sy(v) + 3.5}" text-anchor="end">${fmtTick(v, scale.step)}</text>`
    )
    .join('');
}

export function emptyChart(msg = 'No data in this period') {
  return `<div class="chart-empty">${msg}</div>`;
}

/**
 * series: [{ name, color, points: [{t: Date, v}] }]
 * bands:  [{ min, max, color }]  shaded target ranges
 */
export function lineChart({ series, xStart, xEnd, bands = [], yRange = [], label = 'Line chart' }) {
  const vals = series.flatMap((s) => s.points.map((p) => p.v));
  if (!vals.length) return emptyChart();
  const bandVals = [...bands.flatMap((b) => [b.min, b.max]), ...yRange].filter(Number.isFinite);
  const scale = niceScale(Math.min(...vals, ...bandVals), Math.max(...vals, ...bandVals));
  const t0 = xStart.getTime();
  const span = Math.max(1, xEnd.getTime() - t0);
  const sx = (d) => +(P.l + ((d.getTime() - t0) / span) * PW).toFixed(1);
  const sy = (v) => +(P.t + PH - ((v - scale.lo) / (scale.hi - scale.lo)) * PH).toFixed(1);

  const bandSvg = bands
    .map((b) => {
      const top = sy(Number.isFinite(b.max) ? b.max : scale.hi);
      const bot = sy(Number.isFinite(b.min) ? b.min : scale.lo);
      return `<rect x="${P.l}" y="${top}" width="${PW}" height="${Math.max(0, bot - top)}" fill="${b.color}" opacity="0.12"/>`;
    })
    .join('');

  const lines = series
    .map((s) => {
      if (!s.points.length) return '';
      const d = s.points.map((p, i) => `${i ? 'L' : 'M'}${sx(p.t)},${sy(p.v)}`).join('');
      const showDots = s.points.length <= 60;
      const dots = showDots
        ? s.points.map((p) => `<circle cx="${sx(p.t)}" cy="${sy(p.v)}" r="2.6" fill="${s.color}"/>`).join('')
        : '';
      const last = s.points[s.points.length - 1];
      return (
        `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>` +
        dots +
        `<circle cx="${sx(last.t)}" cy="${sy(last.v)}" r="4" fill="${s.color}" stroke="var(--surface)" stroke-width="2"/>`
      );
    })
    .join('');

  return frame(bandSvg + yAxis(scale, sy) + xAxis(xStart, xEnd, sx) + lines, label);
}

/** bars: [{t: Date, v}] evenly spaced; goal draws a dashed line. */
export function barChart({ bars, color, goal, xStart, xEnd, label = 'Bar chart' }) {
  if (!bars.some((b) => b.v > 0)) return emptyChart();
  const scale = niceScale(0, Math.max(...bars.map((b) => b.v), goal || 0));
  const sy = (v) => +(P.t + PH - ((v - scale.lo) / (scale.hi - scale.lo)) * PH).toFixed(1);
  const slot = PW / bars.length;
  const bw = Math.max(1, slot * 0.72);
  const rects = bars
    .map((b, i) => {
      const y = sy(b.v);
      const x = P.l + i * slot + (slot - bw) / 2;
      return b.v > 0
        ? `<rect x="${x.toFixed(1)}" y="${y}" width="${bw.toFixed(1)}" height="${(sy(0) - y).toFixed(1)}" rx="${Math.min(3, bw / 3).toFixed(1)}" fill="${color}"/>`
        : '';
    })
    .join('');
  const goalLine = goal > 0 ? `<line class="goal" x1="${P.l}" x2="${W - P.r}" y1="${sy(goal)}" y2="${sy(goal)}"/>` : '';
  const t0 = xStart.getTime();
  const span = Math.max(1, xEnd.getTime() - t0);
  const sx = (d) => +(P.l + ((d.getTime() - t0) / span) * PW).toFixed(1);
  return frame(yAxis(scale, sy) + rects + goalLine + xAxis(xStart, xEnd, sx), label);
}

/** GitHub-style calendar: one square per day, weeks as columns (Mon at top). */
export function calendar({ days, doneSet, keyOf, color, label = 'Calendar' }) {
  if (!days.length) return emptyChart();
  const firstDow = (days[0].getDay() + 6) % 7; // 0 = Monday
  const weeks = Math.ceil((firstDow + days.length) / 7);
  const gap = 3;
  const maxCell = 18;
  const cell = Math.min(maxCell, (W - 24 - gap * (weeks - 1)) / weeks);
  const width = 24 + weeks * (cell + gap);
  const height = 7 * (cell + gap) + 4;
  const labels =
    cell >= 9
      ? ['M', '', 'W', '', 'F', '', 'S']
          .map((l, i) => (l ? `<text class="ax" x="0" y="${i * (cell + gap) + cell / 2 + 3.5}">${l}</text>` : ''))
          .join('')
      : '';
  const cells = days
    .map((d, i) => {
      const idx = firstDow + i;
      const x = 24 + Math.floor(idx / 7) * (cell + gap);
      const y = (idx % 7) * (cell + gap);
      const on = doneSet.has(keyOf(d));
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${cell.toFixed(1)}" height="${cell.toFixed(1)}" rx="${(cell / 4).toFixed(1)}" fill="${on ? color : 'var(--track)'}"><title>${shortDate(d)}: ${on ? 'yes' : 'no'}</title></rect>`;
    })
    .join('');
  return `<svg class="chart calendar" viewBox="0 0 ${width.toFixed(1)} ${height.toFixed(1)}" role="img" aria-label="${label}">${labels}${cells}</svg>`;
}

/**
 * Everything on one chart, one slot per day:
 *  lines  [{ name, color, dash, values: [v|null per day] }]  -> left axis
 *  bars   [{ name, color, values }]                          -> right axis (first one only)
 *  strips [{ name, icon, color, max, values }]               -> colour lanes under the plot (darker = higher)
 */
export function overviewChart({ days, lines = [], bars = [], strips = [], leftUnit = '', rightUnit = '' }) {
  const n = days.length;
  if (!n) return emptyChart();
  const bar = bars[0];
  const pl = 38;
  const pr = bar ? 40 : 10;
  const pw = W - pl - pr;
  const top = 16;
  const ph = 150;
  const lane = 16;
  const laneGap = 4;
  const stripsTop = top + ph + 10;
  const axisY = stripsTop + strips.length * (lane + laneGap) + 14;
  const height = axisY + 4;
  const slot = pw / n;
  const cx = (i) => +(pl + (i + 0.5) * slot).toFixed(1);
  let svg = '';

  // Right axis + bars
  if (bar) {
    const vals = bar.values.filter(Number.isFinite);
    const sc = niceScale(0, Math.max(1, ...vals));
    const sy = (v) => +(top + ph - ((v - sc.lo) / (sc.hi - sc.lo)) * ph).toFixed(1);
    const bw = Math.max(1, slot * 0.7);
    svg += sc.ticks.map((v) => `<text class="ax" x="${W - pr + 5}" y="${sy(v) + 3.5}" text-anchor="start">${fmtTick(v, sc.step)}</text>`).join('');
    svg += `<text class="ax unit" x="${W - pr + 5}" y="9" text-anchor="start">${rightUnit}</text>`;
    svg += bar.values
      .map((v, i) =>
        Number.isFinite(v) && v > 0
          ? `<rect x="${(cx(i) - bw / 2).toFixed(1)}" y="${sy(v)}" width="${bw.toFixed(1)}" height="${(sy(0) - sy(v)).toFixed(1)}" rx="${Math.min(3, bw / 3).toFixed(1)}" fill="${bar.color}" opacity="0.28"/>`
          : ''
      )
      .join('');
  }

  // Left axis + lines
  const lineVals = lines.flatMap((l) => l.values.filter(Number.isFinite));
  if (lineVals.length) {
    const sc = niceScale(Math.min(...lineVals), Math.max(...lineVals));
    const sy = (v) => +(top + ph - ((v - sc.lo) / (sc.hi - sc.lo)) * ph).toFixed(1);
    svg =
      sc.ticks.map((v) => `<line class="grid" x1="${pl}" x2="${W - pr}" y1="${sy(v)}" y2="${sy(v)}"/><text class="ax" x="${pl - 6}" y="${sy(v) + 3.5}" text-anchor="end">${fmtTick(v, sc.step)}</text>`).join('') +
      `<text class="ax unit" x="${pl - 6}" y="9" text-anchor="end">${leftUnit}</text>` +
      svg;
    for (const l of lines) {
      let d = '';
      let pen = false;
      l.values.forEach((v, i) => {
        if (!Number.isFinite(v)) {
          pen = false;
          return;
        }
        d += `${pen ? 'L' : 'M'}${cx(i)},${sy(v)}`;
        pen = true;
      });
      if (!d) continue;
      svg += `<path d="${d}" fill="none" stroke="${l.color}" stroke-width="${l.dash ? 1.5 : 2}" ${l.dash ? 'stroke-dasharray="4 3"' : ''} stroke-linejoin="round" stroke-linecap="round"/>`;
      if (n <= 45) {
        svg += l.values.map((v, i) => (Number.isFinite(v) ? `<circle cx="${cx(i)}" cy="${sy(v)}" r="${l.dash ? 1.8 : 2.4}" fill="${l.color}"/>` : '')).join('');
      }
    }
  } else if (!bar) {
    svg += `<text class="ax" x="${pl + pw / 2}" y="${top + ph / 2}" text-anchor="middle">No measurements in this period</text>`;
  }

  // Strips
  strips.forEach((s, k) => {
    const y = stripsTop + k * (lane + laneGap);
    const gap = slot > 4 ? 1 : 0;
    svg += `<text x="${pl - 6}" y="${y + lane - 4}" text-anchor="end" font-size="12">${s.icon || ''}</text>`;
    svg += s.values
      .map((v, i) => {
        const x = pl + i * slot + gap / 2;
        const has = Number.isFinite(v);
        const op = has && v > 0 ? 0.18 + 0.82 * Math.min(1, v / (s.max || 1)) : 1;
        const fill = has && v > 0 ? s.color : 'var(--track)';
        const label = has && v > 0 && slot >= 13 ? `<text x="${(x + (slot - gap) / 2).toFixed(1)}" y="${y + lane - 4.5}" text-anchor="middle" class="strip-num" fill="${v / (s.max || 1) > 0.45 ? '#fff' : 'currentColor'}">${Math.round(v)}</text>` : '';
        return `<rect x="${x.toFixed(1)}" y="${y}" width="${Math.max(0.6, slot - gap).toFixed(1)}" height="${lane}" rx="2" fill="${fill}" ${has && v > 0 ? `fill-opacity="${op.toFixed(2)}"` : ''}><title>${shortDate(days[i])}: ${has ? v : '–'}</title></rect>${label}`;
      })
      .join('');
  });

  // X axis: first, middle, last day (no duplicates)
  const seen = new Set();
  svg += [
    [0, 'start'],
    [n - 1, 'end'],
    [Math.floor((n - 1) / 2), 'middle'],
  ]
    .filter(([i]) => !seen.has(i) && seen.add(i))
    .map(([i, anchor]) => `<text class="ax" x="${anchor === 'start' ? pl : anchor === 'end' ? W - pr : cx(i)}" y="${axisY}" text-anchor="${anchor}">${shortDate(days[i])}</text>`)
    .join('');

  return `<svg class="chart" viewBox="0 0 ${W} ${height}" role="img" aria-label="All parameters per day">${svg}</svg>`;
}

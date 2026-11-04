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
  return [
    [xStart, 'start'],
    [mid, 'middle'],
    [xEnd, 'end'],
  ]
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
export function lineChart({ series, xStart, xEnd, bands = [], label = 'Line chart' }) {
  const vals = series.flatMap((s) => s.points.map((p) => p.v));
  if (!vals.length) return emptyChart();
  const bandVals = bands.flatMap((b) => [b.min, b.max]).filter(Number.isFinite);
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

// One readable date formatter for every Tinka surface.
// Rules (local time zone, calendar days, first match wins):
//   < 1 min, or in the future      -> "just now"
//   < 60 min                       -> "5 min ago"        (minutes win across midnight)
//   same calendar day              -> "2 hours ago"      ("1 hour ago")
//   previous calendar day          -> "Yesterday, 3:40 PM"
//   2-6 calendar days back         -> "Sat, 9:12 AM"     (7 back would repeat today's weekday)
//   earlier this year              -> "Oct 21"
//   earlier years                  -> "Oct 28, 2025"
// The exact form ("Tuesday, November 3, 2026 at 3:58 PM") goes in title, tooltip and details.
// Safe to import in Node: nothing touches the DOM until a function is called.

const MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR;
const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
// Rounding absorbs 23- and 25-hour daylight-saving days.
export const calendarDaysBetween = (now, d) => Math.round((startOfDay(now) - startOfDay(d)) / DAY);

/** A valid Date from a Date, epoch milliseconds or date string; otherwise null. */
export function toDate(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const d = value instanceof Date ? new Date(value.getTime()) : new Date(typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value);
  return Number.isFinite(d.getTime()) ? d : null;
}

function settings(opts = {}) {
  const locale = opts.locale || (typeof navigator !== 'undefined' && navigator.language) || 'en-US';
  const hc = opts.hourCycle ? { hourCycle: opts.hourCycle }
    : opts.hour12 === true ? { hourCycle: 'h12' } : opts.hour12 === false ? { hourCycle: 'h23' } : {};
  return { locale, hc, en: /^en\b/i.test(locale) };
}
const formatters = new Map();
function fmt(kind, locale, options) {
  const key = kind + '|' + locale + '|' + JSON.stringify(options);
  let f = formatters.get(key);
  if (!f) {
    f = kind === 'rel' ? new Intl.RelativeTimeFormat(locale, options) : new Intl.DateTimeFormat(locale, options);
    formatters.set(key, f);
  }
  return f;
}
// ICU may put a narrow no-break space before AM/PM; keep strings predictable.
const clean = s => s.replace(/[  ]/g, ' ');
const cap = s => s.charAt(0).toLocaleUpperCase() + s.slice(1);

/** { label, rule }; rule is one of now, min, hour, yesterday, weekday, date, year (or invalid). */
export function classify(date, now = new Date(), opts = {}) {
  const d = toDate(date), at = toDate(now) || new Date();
  if (!d) return { rule: 'invalid', label: '' };
  const { locale, hc, en } = settings(opts);
  const rtf = en ? null : fmt('rel', locale, { numeric: 'auto' });
  const diff = at - d;
  if (diff < MIN) return { rule: 'now', label: en ? 'just now' : rtf.format(0, 'second') };
  if (diff < HOUR) { const m = Math.floor(diff / MIN); return { rule: 'min', label: en ? `${m} min ago` : rtf.format(-m, 'minute') }; }
  const days = calendarDaysBetween(at, d);
  if (days <= 0) { const h = Math.floor(diff / HOUR); return { rule: 'hour', label: en ? (h === 1 ? '1 hour ago' : `${h} hours ago`) : rtf.format(-h, 'hour') }; }
  const time = () => clean(fmt('dt', locale, { hour: 'numeric', minute: '2-digit', ...hc }).format(d));
  if (days === 1) return { rule: 'yesterday', label: `${en ? 'Yesterday' : cap(rtf.format(-1, 'day'))}, ${time()}` };
  if (days < 7) return { rule: 'weekday', label: `${fmt('dt', locale, { weekday: 'short' }).format(d)}, ${time()}` };
  if (d.getFullYear() === at.getFullYear()) return { rule: 'date', label: clean(fmt('dt', locale, { month: 'short', day: 'numeric' }).format(d)) };
  return { rule: 'year', label: clean(fmt('dt', locale, { month: 'short', day: 'numeric', year: 'numeric' }).format(d)) };
}
export const relDate = (date, now, opts) => classify(date, now, opts).label;

/** Mid-sentence form: "Created yesterday, 3:40 PM". */
export function inline(label) { return String(label).startsWith('Yesterday') ? 'y' + String(label).slice(1) : String(label); }

/** "Tuesday, November 3, 2026 at 3:58 PM" in the user's locale; '' for an invalid date. */
export function exactDate(date, opts = {}) {
  const d = toDate(date);
  if (!d) return '';
  const { locale, hc } = settings(opts);
  return clean(fmt('dt', locale, { dateStyle: 'full', timeStyle: 'short', ...hc }).format(d));
}

const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const prefixed = (prefix, label) => prefix + (prefix ? inline(label) : label);
const titled = (verb, exact) => (verb ? verb + ' ' : '') + exact;

/** Escaped <time data-rel> markup for a date, or '' when the date is missing or invalid.
 *  focusable adds tabindex="0" so keyboard users can reach the exact-time tooltip;
 *  leave it off inside links and other controls. */
export function timeHTML(value, { prefix = '', verb = '', now = new Date(), focusable = false, ...opts } = {}) {
  const d = toDate(value);
  if (!d) return '';
  const title = titled(verb, exactDate(d, opts));
  return `<time data-rel datetime="${escapeHTML(d.toISOString())}"${prefix ? ` data-prefix="${escapeHTML(prefix)}"` : ''}${verb ? ` data-verb="${escapeHTML(verb)}"` : ''} title="${escapeHTML(title)}"${focusable ? ' tabindex="0"' : ''}>${escapeHTML(prefixed(prefix, relDate(d, now, opts)))}</time>`;
}

/** Refresh every time[data-rel] under root. */
export function renderTimes(root, now = new Date(), opts = {}) {
  if (!root?.querySelectorAll) return;
  for (const t of root.querySelectorAll('time[data-rel]')) {
    const d = toDate(t.getAttribute('datetime'));
    if (!d) continue;
    const label = prefixed(t.dataset.prefix || '', relDate(d, now, opts));
    if (t.textContent !== label) t.textContent = label;
    const exact = titled(t.dataset.verb || '', exactDate(d, opts));
    t.dataset.exact = exact;
    if (!t.dataset.tipActive && t.getAttribute('title') !== exact) t.setAttribute('title', exact);
  }
}

// One shared timer per page, never one per element.
let live = null;
/** Keep every time[data-rel] under root fresh: on the next minute boundary, then
 *  each minute, and whenever the tab is shown again. Idempotent; returns { refresh }. */
export function startLiveDates(root = typeof document !== 'undefined' ? document : null) {
  if (!live) {
    const roots = new Set();
    const refresh = () => { const now = new Date(); for (const r of roots) renderTimes(r, now); };
    const schedule = () => {
      const n = new Date();
      live.timer = setTimeout(() => { refresh(); schedule(); }, MIN - (n.getSeconds() * 1e3 + n.getMilliseconds()) + 50);
    };
    live = { roots, refresh, timer: null };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
    schedule();
  }
  if (root) { live.roots.add(root); renderTimes(root); }
  return { refresh: live.refresh };
}

/** A styled exact-time tooltip for time[data-rel] on hover or focus. The native
 *  title is parked while it shows so the two never appear together. Idempotent. */
export function installDateTooltip() {
  if (typeof document === 'undefined' || document.querySelector('.tk-date-tip')) return;
  const tip = document.createElement('div');
  tip.className = 'tk-date-tip'; tip.id = 'tk-date-tip'; tip.setAttribute('role', 'tooltip');
  document.body.append(tip);
  let current = null;
  const hide = () => {
    if (!current) return;
    if (current.dataset.exact) current.setAttribute('title', current.dataset.exact);
    delete current.dataset.tipActive;
    current = null;
    tip.classList.remove('on');
  };
  const show = t => {
    if (t === current) return;
    hide();
    const exact = t.dataset.exact || t.getAttribute('title');
    if (!exact) return;
    t.dataset.exact = exact; t.dataset.tipActive = '1'; t.removeAttribute('title');
    current = t;
    tip.textContent = exact;
    const r = t.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - 8)) + 'px';
    tip.style.top = (r.top - h - 8 < 8 ? r.bottom + 8 : r.top - h - 8) + 'px';
    tip.classList.add('on');
  };
  const target = e => e.target?.closest?.('time[data-rel]') || null;
  document.addEventListener('pointerover', e => { const t = target(e); if (t) show(t); else if (current && document.activeElement !== current) hide(); });
  document.addEventListener('pointerout', e => { if (current && !e.relatedTarget && document.activeElement !== current) hide(); });
  document.addEventListener('focusin', e => { const t = target(e); if (t) show(t); else hide(); });
  document.addEventListener('focusout', e => { if (target(e) === current) hide(); });
  document.addEventListener('pointerdown', hide, true);
  addEventListener('scroll', hide, true);
  addEventListener('keydown', e => { if (e.key === 'Escape') hide(); });
}

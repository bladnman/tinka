import test from 'node:test';
import assert from 'node:assert/strict';
import {classify, relDate, inline, exactDate, timeHTML, toDate, calendarDaysBetween} from '../public/relative-dates.js';

// Fixed local times keep every case independent of the machine's clock and zone.
const en = {locale: 'en-US'};
const at = (...a) => new Date(...a);
const NOW = at(2026, 10, 3, 16, 2); // Tuesday, November 3, 2026, 4:02 PM local
const M = 60e3, H = 60 * M;
const rel = (d, now = NOW) => relDate(d, now, en);

test('every ladder row', () => {
  assert.deepEqual(classify(new Date(NOW - 20e3), NOW, en), {rule: 'now', label: 'just now'});
  assert.deepEqual(classify(new Date(NOW - 5 * M), NOW, en), {rule: 'min', label: '5 min ago'});
  assert.deepEqual(classify(new Date(NOW - 2 * H), NOW, en), {rule: 'hour', label: '2 hours ago'});
  assert.equal(rel(new Date(NOW - 61 * M)), '1 hour ago');
  assert.deepEqual(classify(at(2026, 10, 2, 15, 40), NOW, en), {rule: 'yesterday', label: 'Yesterday, 3:40 PM'});
  assert.deepEqual(classify(at(2026, 9, 31, 9, 12), NOW, en), {rule: 'weekday', label: 'Sat, 9:12 AM'});
  assert.deepEqual(classify(at(2026, 9, 21, 10, 5), NOW, en), {rule: 'date', label: 'Oct 21'});
  assert.deepEqual(classify(at(2025, 9, 28, 11, 30), NOW, en), {rule: 'year', label: 'Oct 28, 2025'});
});

test('row boundaries', () => {
  assert.equal(rel(new Date(NOW - 59e3)), 'just now');
  assert.equal(rel(new Date(NOW - 60e3)), '1 min ago');
  assert.equal(rel(new Date(NOW - 59 * M - 59e3)), '59 min ago');
  assert.equal(rel(new Date(NOW - 60 * M)), '1 hour ago');
  assert.equal(rel(at(2026, 10, 3, 0, 0)), '16 hours ago', 'midnight today is still today');
  assert.equal(rel(at(2026, 10, 2, 23, 59)), 'Yesterday, 11:59 PM');
  assert.equal(rel(at(2026, 10, 1, 23, 59)), 'Sun, 11:59 PM', 'two calendar days back is a weekday');
  assert.equal(rel(at(2026, 9, 28, 0, 0)), 'Wed, 12:00 AM', 'six days back is the last weekday');
  assert.equal(rel(at(2026, 0, 1, 0, 0)), 'Jan 1');
  assert.equal(rel(at(2025, 11, 31, 23, 59)), 'Dec 31, 2025');
});

test('minutes win across midnight', () => {
  assert.equal(rel(at(2026, 10, 2, 23, 50), at(2026, 10, 3, 0, 10)), '20 min ago');
  assert.equal(rel(at(2026, 10, 2, 23, 0), at(2026, 10, 3, 0, 10)), 'Yesterday, 11:00 PM', 'over an hour falls to the calendar');
});

test('"today" depends on the clock', () => {
  const fourPM = at(2026, 10, 3, 16, 0), nineAM = at(2026, 10, 3, 9, 0);
  assert.equal(rel(new Date(fourPM - 13 * H), fourPM), '13 hours ago');
  assert.equal(rel(new Date(nineAM - 13 * H), nineAM), 'Yesterday, 8:00 PM');
});

test('stops at six days: seven days back shows the date', () => {
  assert.equal(rel(at(2026, 9, 28, 16, 2)), 'Wed, 4:02 PM');
  assert.deepEqual(classify(at(2026, 9, 27, 16, 2), NOW, en), {rule: 'date', label: 'Oct 27'});
  assert.equal(calendarDaysBetween(NOW, at(2026, 9, 27, 23, 59)), 7);
});

test('future and clock-skewed times show just now', () => {
  assert.equal(rel(new Date(NOW.getTime() + 3 * M)), 'just now');
  assert.equal(rel(new Date(NOW.getTime() + 400 * 24 * H)), 'just now');
});

test('inline lowercases a leading Yesterday only', () => {
  assert.equal(inline('Yesterday, 3:40 PM'), 'yesterday, 3:40 PM');
  assert.equal(inline('Sat, 9:12 AM'), 'Sat, 9:12 AM');
  assert.equal(inline('2 hours ago'), '2 hours ago');
});

test('exact date shape', () => {
  assert.equal(exactDate(at(2026, 10, 3, 15, 58), en), 'Tuesday, November 3, 2026 at 3:58 PM');
  assert.equal(exactDate(at(2026, 10, 3, 15, 58), {locale: 'en-US', hour12: false}), 'Tuesday, November 3, 2026 at 15:58');
  assert.equal(exactDate('not a date', en), '');
});

test('12/24-hour preference and other locales', () => {
  assert.equal(relDate(at(2026, 10, 2, 15, 40), NOW, {locale: 'en-US', hour12: false}), 'Yesterday, 15:40');
  assert.equal(relDate(new Date(NOW - 5 * M), NOW, {locale: 'fr-FR'}), new Intl.RelativeTimeFormat('fr-FR', {numeric: 'auto'}).format(-5, 'minute'));
  assert.match(relDate(at(2026, 10, 2, 15, 40), NOW, {locale: 'fr-FR'}), /^Hier, 15:40$/);
});

test('timeHTML markup, escaping and invalid input', () => {
  const created = new Date(NOW - 2 * H);
  const html = timeHTML(created, {prefix: 'Created ', verb: 'Created', now: NOW, ...en});
  assert.equal(html, `<time data-rel datetime="${created.toISOString()}" data-prefix="Created " data-verb="Created" title="Created Tuesday, November 3, 2026 at 2:02 PM">Created 2 hours ago</time>`);
  assert.match(timeHTML(at(2026, 10, 2, 15, 40), {prefix: 'Created ', now: NOW, ...en}), />Created yesterday, 3:40 PM<\/time>$/);
  assert.match(timeHTML(created, {now: NOW, focusable: true, ...en}), / tabindex="0">2 hours ago</);
  assert.match(timeHTML(created, {prefix: '<b>"', now: NOW, ...en}), /data-prefix="&lt;b&gt;&quot;"/);
  assert.equal(timeHTML(created.getTime(), {now: NOW, ...en}).includes('2 hours ago'), true, 'epoch milliseconds work');
  for (const bad of [undefined, null, '', 'invalid', NaN, new Date(NaN), true]) assert.equal(timeHTML(bad), '');
  assert.equal(toDate('2026-11-03T21:02:00.000Z').toISOString(), '2026-11-03T21:02:00.000Z');
  assert.equal(classify('nope', NOW, en).rule, 'invalid');
});

const KEY = 'tinka/appearance';
const system = matchMedia('(prefers-color-scheme: dark)');
const CHOICES = [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']];
let preference = 'system';
try { const value = localStorage.getItem(KEY); if (['system','light','dark'].includes(value)) preference = value; } catch {}
function apply() {
  document.documentElement.dataset.appearance = preference === 'system' ? (system.matches ? 'dark' : 'light') : preference;
}
apply();
system.addEventListener('change', () => { if (preference === 'system') apply(); });
function choose(value) {
  if (!CHOICES.some(([choice]) => choice === value)) return;
  preference = value;
  try { localStorage.setItem(KEY, preference); } catch {}
  apply();
  // Home, the board's and an opened Tinka's Inspector each carry one; keep them in step.
  document.querySelectorAll('.appearance-control select').forEach(other => { other.value = preference; });
  document.querySelectorAll('[data-appearance-set]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.appearanceSet === preference)));
}
// Inspectors use Tinka's own segmented control (System / Light / Dark); Home's
// masthead keeps the compact select ({control:'select'}).
export function mountAppearance(host, { control = 'segmented' } = {}) {
  if (!host) return;
  if (control === 'select') {
    const label = document.createElement('label');
    label.className = 'appearance-control';
    label.innerHTML = `<span>Appearance</span><select aria-label="Appearance">${CHOICES.map(([value, name]) => `<option value="${value}">${name}</option>`).join('')}</select>`;
    const select = label.querySelector('select');
    select.value = preference;
    select.addEventListener('change', () => choose(select.value));
    host.append(label);
    return;
  }
  const wrap = document.createElement('div');
  wrap.className = 'appearance-control appearance-segmented';
  wrap.innerHTML = `<span class="appearance-label" aria-hidden="true">Appearance</span><div class="tk-seg" role="group" aria-label="Appearance">${CHOICES.map(([value, name]) => `<button type="button" data-appearance-set="${value}" aria-pressed="${value === preference}">${name}</button>`).join('')}</div>`;
  wrap.addEventListener('click', event => { const button = event.target.closest('[data-appearance-set]'); if (button) choose(button.dataset.appearanceSet); });
  host.append(wrap);
}

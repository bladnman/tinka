const KEY = 'tinka/appearance';
const system = matchMedia('(prefers-color-scheme: dark)');
let preference = 'system';
try { const value = localStorage.getItem(KEY); if (['system','light','dark'].includes(value)) preference = value; } catch {}
function apply() {
  document.documentElement.dataset.appearance = preference === 'system' ? (system.matches ? 'dark' : 'light') : preference;
}
apply();
system.addEventListener('change', () => { if (preference === 'system') apply(); });
export function mountAppearance(host) {
  if (!host) return;
  const label = document.createElement('label');
  label.className = 'appearance-control';
  label.innerHTML = '<span>Appearance</span><select aria-label="Appearance"><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select>';
  const select = label.querySelector('select');
  select.value = preference;
  select.addEventListener('change', () => {
    preference = select.value;
    try { localStorage.setItem(KEY,preference); } catch {}
    apply();
    // The board's and an opened Tinka's Inspector each carry one; keep them in step.
    document.querySelectorAll('.appearance-control select').forEach(other => { other.value = preference; });
  });
  host.append(label);
}

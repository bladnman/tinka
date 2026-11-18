import { EMOJI_STICKER_MIME, emojiSticker, favoriteEmoji } from './emoji-stickers.js';
import { makeEmojiSearch } from './emoji-search.js';

const categoryIcons = {
  Favorites: '☆', 'Smileys & Emotion': '😀', 'People & Body': '👋', Component: '🧩',
  'Animals & Nature': '🐾', 'Food & Drink': '🍎', 'Travel & Places': '🚗',
  Activities: '⚽', Objects: '💡', Symbols: '🔣', Flags: '🏳️',
};
const pageSize = 108;
let catalogue;

function loadCatalogue() {
  return catalogue ??= import('./emoji-repertoire.js').then(({ emojiEntries, emojiGroups }) => ({
    groups: emojiGroups,
    find: makeEmojiSearch(emojiEntries, emojiGroups),
  })).catch(error => {
    catalogue = undefined;
    throw error;
  });
}

export function mountEmojiPicker(popup, { choose, close }) {
  const doc = popup.ownerDocument;
  const picker = doc.createElement('div');
  picker.className = 'emoji-picker';
  const search = doc.createElement('input');
  search.type = 'search';
  search.className = 'tk-field emoji-picker-search';
  search.placeholder = 'Search emoji';
  search.setAttribute('aria-label', 'Search emoji');
  search.autocomplete = 'off';
  search.spellcheck = false;
  search.maxLength = 120;
  const categories = doc.createElement('div');
  categories.className = 'emoji-picker-categories';
  categories.setAttribute('role', 'group');
  categories.setAttribute('aria-label', 'Emoji categories');
  const view = doc.createElement('div');
  view.className = 'emoji-picker-view';
  const title = doc.createElement('span');
  const tones = doc.createElement('button');
  tones.className = 'emoji-picker-link';
  tones.type = 'button';
  tones.textContent = 'Skin tones';
  tones.hidden = true;
  view.append(title, tones);
  const results = doc.createElement('div');
  results.className = 'emoji-picker-results';
  results.setAttribute('role', 'group');
  results.setAttribute('aria-label', 'Emoji results');
  const status = doc.createElement('div');
  status.className = 'emoji-picker-status';
  status.setAttribute('role', 'status');
  const pagination = doc.createElement('div');
  pagination.className = 'emoji-picker-pages';
  const count = doc.createElement('span');
  count.setAttribute('aria-live', 'polite');
  const pageButton = (label, icon) => {
    const button = doc.createElement('button');
    button.className = 'emoji-picker-link';
    button.type = 'button';
    button.setAttribute('aria-label', label);
    button.title = label;
    button.textContent = icon;
    return button;
  };
  const previous = pageButton('Previous emoji page', '‹');
  const next = pageButton('Next emoji page', '›');
  pagination.append(previous, count, next);
  picker.append(search, categories, view, results, pagination, status);
  popup.setAttribute('role', 'dialog');
  popup.setAttribute('aria-label', 'Emoji stickers');
  popup.replaceChildren(picker);

  let options = [];
  let active = 0;
  let categoryButtons = [];
  let group = -1;
  let includeTones = false;
  let entries = favoriteEmoji;
  let page = 0;
  let groups = [];
  let find;
  let loadFailed = false;
  let pending = false;
  let destroyed = false;

  function focusOption(index) {
    const button = options[index];
    if (!button) return;
    options[active].tabIndex = -1;
    button.tabIndex = 0;
    active = index;
    button.focus();
  }

  function renderPage() {
    active = 0;
    const start = page * pageSize;
    options = entries.slice(start, start + pageSize).map(([emoji, name], index) => {
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'emoji-picker-option';
      button.draggable = true;
      button.dataset.emoji = emoji;
      button.title = name;
      button.setAttribute('aria-label', name);
      button.tabIndex = index === 0 ? 0 : -1;
      button.textContent = emoji;
      return button;
    });
    results.replaceChildren(...options);
    results.scrollTop = 0;
    pagination.hidden = entries.length <= pageSize;
    count.textContent = `${start + 1}–${Math.min(entries.length, start + pageSize)} of ${entries.length}`;
    previous.disabled = page === 0;
    next.disabled = start + pageSize >= entries.length;
  }

  function renderResults() {
    const query = search.value;
    const searching = Boolean(query.trim());
    title.textContent = searching ? 'Search results' : (group === -1 ? 'Favorites' : groups[group]);
    categoryButtons.forEach(button => button.setAttribute('aria-pressed', String(!searching && Number(button.dataset.group) === group)));
    let canShowTones = false;
    if (find) ({ entries, canShowTones } = find(query, group, includeTones));
    else {
      const pasted = emojiSticker(query);
      entries = pasted ? [[pasted, 'Pasted emoji']] : (searching ? [] : favoriteEmoji);
    }
    tones.hidden = !canShowTones;
    tones.setAttribute('aria-pressed', String(includeTones));
    if (!pending) {
      status.textContent = loadFailed ? 'The emoji catalog didn’t load. Reopen Sticker to try again.'
        : find && !entries.length ? 'No matching emoji'
          : !find && searching && !entries.length ? 'Loading emoji…' : '';
    }
    page = 0;
    renderPage();
  }

  function renderCategories() {
    const groupOrder = groups.map((_, index) => index);
    const component = groups.indexOf('Component');
    if (component >= 0) groupOrder.push(...groupOrder.splice(component, 1));
    categoryButtons = [-1, ...groupOrder].map((index, position) => {
      const label = index === -1 ? 'Favorites' : groups[index];
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'emoji-picker-category';
      button.dataset.group = index;
      button.setAttribute('aria-label', label === 'Component' ? 'Emoji components' : label);
      button.setAttribute('aria-pressed', String(!search.value.trim() && group === index));
      button.title = button.getAttribute('aria-label');
      button.textContent = categoryIcons[label] || label[0];
      button.tabIndex = position === 0 ? 0 : -1;
      return button;
    });
    categories.replaceChildren(...categoryButtons);
  }

  function turnPage(step, focus) {
    const desired = page + step;
    if (desired < 0 || desired * pageSize >= entries.length) return;
    page = desired;
    renderPage();
    if (focus === 'results') focusOption(step > 0 ? 0 : options.length - 1);
    else if (focus?.disabled) (step > 0 ? previous : next).focus({ preventScroll: true });
  }

  async function add(button) {
    if (pending || !button) return;
    pending = true;
    results.setAttribute('aria-disabled', 'true');
    status.textContent = 'Adding sticker…';
    try {
      if (await choose(button.dataset.emoji) === false) throw new Error('Try again.');
    } catch (error) {
      if (destroyed) return;
      pending = false;
      results.removeAttribute('aria-disabled');
      status.textContent = `Couldn’t add sticker. ${error?.message || 'Try again.'}`;
      return;
    }
    if (!destroyed) close();
  }

  search.addEventListener('input', renderResults);
  categories.addEventListener('click', event => {
    const button = event.target.closest('.emoji-picker-category');
    if (!button) return;
    group = Number(button.dataset.group);
    search.value = '';
    renderResults();
  });
  categories.addEventListener('focusin', event => {
    categoryButtons.forEach(button => { button.tabIndex = button === event.target ? 0 : -1; });
  });
  tones.addEventListener('click', () => {
    includeTones = !includeTones;
    renderResults();
  });
  previous.addEventListener('click', () => turnPage(-1, previous));
  next.addEventListener('click', () => turnPage(1, next));
  results.addEventListener('click', event => {
    add(event.target.closest('.emoji-picker-option'));
  });
  results.addEventListener('dragstart', event => {
    const button = event.target.closest('.emoji-picker-option');
    if (!button || !event.dataTransfer) return;
    if (pending) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.setData(EMOJI_STICKER_MIME, button.dataset.emoji);
    event.dataTransfer.effectAllowed = 'copy';
  });
  results.addEventListener('focusin', event => {
    const index = options.indexOf(event.target);
    if (index < 0 || index === active) return;
    options[active].tabIndex = -1;
    event.target.tabIndex = 0;
    active = index;
  });
  picker.addEventListener('wheel', event => {
    if (!event.ctrlKey && !event.metaKey) event.stopPropagation();
  }, { passive: true });

  picker.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.isComposing) return;
    const { key, target } = event;
    if (key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (target === search) {
      if (key === 'ArrowDown' && options.length) {
        event.preventDefault();
        focusOption(active);
      } else if (key === 'Enter' && search.value.trim() && options.length) {
        event.preventDefault();
        if (!event.repeat) add(options[0]);
      }
      return;
    }
    if (target.matches('.emoji-picker-category')) {
      const index = categoryButtons.indexOf(target);
      const category = {ArrowLeft:index - 1, ArrowRight:index + 1, Home:0, End:categoryButtons.length - 1}[key];
      if (category !== undefined) {
        event.preventDefault();
        categoryButtons[(category + categoryButtons.length) % categoryButtons.length].focus();
      } else if (key === 'ArrowDown') {
        event.preventDefault();
        focusOption(active);
      }
      return;
    }
    if (key === 'Enter' && event.repeat) {
      event.preventDefault();
      return;
    }
    if (!target.matches('.emoji-picker-option')) return;
    if (key === 'PageDown' || key === 'PageUp') {
      event.preventDefault();
      turnPage(key === 'PageDown' ? 1 : -1, 'results');
      return;
    }
    // Count the first visual row so vertical navigation follows the current width.
    const firstRow = options[0].offsetTop;
    const nextRow = options.findIndex(button => button.offsetTop !== firstRow);
    const columns = nextRow < 0 ? options.length : nextRow;
    const next = {
      ArrowLeft: active - 1,
      ArrowRight: active + 1,
      ArrowUp: active - columns,
      ArrowDown: active + columns,
      Home: 0,
      End: options.length - 1,
    }[key];
    if (next === undefined) return;
    event.preventDefault();
    if (next < 0 && key === 'ArrowUp') search.focus();
    else focusOption(next);
  });

  renderResults();
  loadCatalogue().then(data => {
    if (destroyed) return;
    ({ groups, find } = data);
    renderCategories();
    if (search.value.trim()) renderResults();
  }, () => {
    if (destroyed) return;
    loadFailed = true;
    status.textContent = 'The emoji catalog didn’t load. Reopen Sticker to try again.';
  });
  return {
    focus() { search.focus({ preventScroll: true }); },
    destroy() {
      destroyed = true;
      picker.remove();
    },
  };
}

// Shared mechanics only: each surface owns validation, drafts, dismissal and focus.
export function commitShortcutLabel() {
  const platform = globalThis.navigator?.userAgentData?.platform || globalThis.navigator?.platform || '';
  return /Mac|iPhone|iPad/i.test(platform) ? '⌘ Enter' : 'Ctrl Enter';
}
export function isCommitShortcut(event) {
  return event.key === 'Enter' && (event.metaKey || event.ctrlKey) &&
    !event.altKey && !event.shiftKey && !event.isComposing && event.keyCode !== 229 && !event.repeat;
}
export function restoreFocus(target, {preventScroll = true} = {}) {
  try {
    const element = typeof target === 'function' ? target() : target;
    if (element?.isConnected && typeof element.focus === 'function') {
      element.focus({preventScroll}); return true;
    }
  } catch {}
  return false;
}
export function bindForm(form, {submit, onError, onSuccess, onPendingChange, pending: externalPending = () => false} = {}) {
  let busy = false, composing = false, destroyed = false;
  const pending = () => busy || Boolean(externalPending());
  const primary = () => [...form.elements].find(element => element.type === 'submit' && !element.disabled);
  const requestSubmit = submitter => {
    if (destroyed || composing || pending()) return false;
    const button = submitter || primary();
    if (button?.form === form) form.requestSubmit(button); else form.requestSubmit();
    return true;
  };
  const keydown = event => {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || composing) return;
    if (isCommitShortcut(event)) {
      event.preventDefault(); event.stopPropagation(); requestSubmit();
    } else if (event.key === 'Enter' && event.repeat &&
      ((event.metaKey || event.ctrlKey) || !event.target.closest('textarea,[contenteditable]'))) {
      event.preventDefault(); event.stopPropagation();
    }
  };
  const startComposition = () => { composing = true; };
  const endComposition = () => { composing = false; };
  const handleSubmit = async event => {
    event.preventDefault();
    if (destroyed || composing || pending() || typeof submit !== 'function') return;
    // Required/empty rules belong to the domain's fields. Empty notes are valid.
    if (!form.checkValidity()) { form.reportValidity(); return; }
    busy = true;
    const buttons = [...form.elements].filter(element => element.type === 'submit').map(element => [element, element.disabled]);
    const previousBusy = form.getAttribute('aria-busy');
    for (const [button] of buttons) button.disabled = true;
    form.setAttribute('aria-busy', 'true');
    try {
      onPendingChange?.(true);
      const result = await submit(new FormData(form), form, event);
      await onSuccess?.(result, form, event);
    } catch (error) {
      if (onError) await onError(error, form, event);
      else {
        const status = form.querySelector('[data-form-status],.workspace-form-status,[role=status]');
        if (status) { status.textContent = error.message || 'Change not saved. Try again.'; status.setAttribute('role', 'alert'); }
      }
    } finally {
      busy = false;
      for (const [button, disabled] of buttons) button.disabled = disabled;
      if (previousBusy === null) form.removeAttribute('aria-busy'); else form.setAttribute('aria-busy', previousBusy);
      onPendingChange?.(false);
    }
  };
  form.addEventListener('keydown', keydown);
  form.addEventListener('compositionstart', startComposition);
  form.addEventListener('compositionend', endComposition);
  form.addEventListener('submit', handleSubmit);
  return {
    get pending() { return pending(); },
    requestSubmit,
    destroy() {
      destroyed = true;
      form.removeEventListener('keydown', keydown);
      form.removeEventListener('compositionstart', startComposition);
      form.removeEventListener('compositionend', endComposition);
      form.removeEventListener('submit', handleSubmit);
    },
  };
}
// Existing autosaved note surfaces can flush explicitly without becoming forms.
export function bindCommitShortcut(target, {commit, onError, onPendingChange, accept = () => true} = {}) {
  let busy = false, composing = false;
  const startComposition=()=>{composing=true;},endComposition=()=>{composing=false;};
  const keydown = async event => {
    if (event.defaultPrevented || !accept(event) || composing || event.isComposing || event.keyCode===229) return;
    if (event.repeat && event.key==='Enter' && (event.metaKey || event.ctrlKey)) {event.preventDefault();event.stopPropagation();return;}
    if (!isCommitShortcut(event)) return;
    event.preventDefault(); event.stopPropagation();
    if (busy) return;
    busy = true;
    try { onPendingChange?.(true); await commit(event); }
    catch (error) { await onError?.(error, event); }
    finally { busy = false; onPendingChange?.(false); }
  };
  target.addEventListener('keydown', keydown);
  target.addEventListener('compositionstart',startComposition);target.addEventListener('compositionend',endComposition);
  return {get pending() { return busy; }, destroy() { target.removeEventListener('keydown', keydown);target.removeEventListener('compositionstart',startComposition);target.removeEventListener('compositionend',endComposition); }};
}

/**
 * UI primitives: banners, copy, dialog, inline results, skeletons, empty and
 * gated states, expandables, segmented controls, toggles, combobox, checkbox
 * tree, search field, scroll-to-top.
 *
 * These encode the UX rules the whole app follows (docs/ux-rules.md), in one
 * place:
 *
 * - **Feedback is inline, not in a toast.** `copyButton` swaps its icon for a
 *   tick in place; `inlineResult` puts an action's outcome next to the button
 *   that triggered it. Banners are reserved for system notifications
 *   (connection lost/restored) — never for something the reader just did.
 * - **Dialogs close three ways**: the X, clicking the backdrop, and Escape,
 *   with focus returned to the opener. Destructive confirmations disable the
 *   backdrop click so a stray click cannot end a process.
 * - **Skeletons, not spinners**, for content with a known shape, held for a
 *   minimum time so a fast response does not flash.
 * - **Searchable select for long lists; segmented controls for short ones;
 *   toggles for immediate settings; checkboxes for deferred, grouped ones.**
 */

import { $, $$, el, focusables, frag } from "./util/dom.js";

/* ══ Icons ══════════════════════════════════════════════════════════════ */
export const icons = {
  check: '<svg viewBox="0 0 24 24"><path d="M4 12.5l5 5L20 6.5"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  copy: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg>',
  warn: '<svg viewBox="0 0 24 24"><path d="M12 8v5M12 16.5v.5"/><path d="M10.3 3.6L2.5 18a2 2 0 0 0 1.7 3h15.6a2 2 0 0 0 1.7-3L13.7 3.6a2 2 0 0 0-3.4 0z"/></svg>',
  info: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8v.5"/></svg>',
  ok: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.6 2.6L16 9.6"/></svg>',
  crit: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v6M12 16.5v.5"/></svg>',
  chevron: '<svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>',
  caret: '<svg viewBox="0 0 24 24"><path d="M6 9.5l6 6 6-6"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21"/></svg>',
  lock: '<svg viewBox="0 0 24 24"><rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/></svg>',
  empty: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M8.5 14.5h7"/></svg>',
  refresh: '<svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 0 1-13.7 5.6"/><path d="M4 12a8 8 0 0 1 13.7-5.6"/><path d="M17.5 3.5v3.5H14M6.5 20.5V17H10"/></svg>',
  plug: '<svg viewBox="0 0 24 24"><path d="M9 3v6M15 3v6M6 9h12v3a6 6 0 0 1-12 0z"/><path d="M12 18v3"/></svg>',
  offline: '<svg viewBox="0 0 24 24"><path d="M2 8.5a15 15 0 0 1 20 0M5.5 12a10 10 0 0 1 13 0M9 15.5a5 5 0 0 1 6 0M12 19v.5"/><path d="M3 3l18 18"/></svg>',
};

const toneIcon = (tone) => ({
  ok: icons.ok, error: icons.crit, info: icons.info, warn: icons.warn,
}[tone] || icons.info);

/* ══ Banners (system notifications only) ═══════════════════════════════ */
const activeBanners = new Map();

/**
 * @param {string} key  identity, so a repeated "disconnected" replaces rather
 *                      than stacking.
 */
export function banner(key, message, { tone = "info", sticky = false } = {}) {
  const region = $("#banners");
  if (!region) return;
  dismissBanner(key);
  const node = el("div.banner", { dataset: { tone } });
  node.innerHTML = `${toneIcon(tone)}<span></span>`;
  node.querySelector("span").textContent = message;
  region.append(node);
  const timer = sticky ? null : setTimeout(() => dismissBanner(key), 4000);
  activeBanners.set(key, { node, timer });
}

export function dismissBanner(key) {
  const entry = activeBanners.get(key);
  if (!entry) return;
  activeBanners.delete(key);
  if (entry.timer) clearTimeout(entry.timer);
  entry.node.classList.add("is-out");
  setTimeout(() => entry.node.remove(), 160);
}

/* ══ Copy to clipboard ═════════════════════════════════════════════════ */
async function copy(text, button) {
  let ok = false;
  try {
    await navigator.clipboard.writeText(String(text));
    ok = true;
  } catch {
    // Clipboard API needs a secure context; fall back to the legacy path.
    try {
      const area = el("textarea", { style: { position: "fixed", top: "-1000px", opacity: "0" } });
      area.value = String(text);
      document.body.append(area);
      area.select();
      ok = document.execCommand("copy");
      area.remove();
    } catch {
      ok = false;
    }
  }
  if (button) {
    button.classList.toggle("is-copied", ok);
    if (!ok) button.title = "Could not copy — the browser blocked clipboard access";
    setTimeout(() => button.classList.remove("is-copied"), 2000);
  }
  return ok;
}

/** Wire every `[data-copy]` in a container. Value comes from the attribute. */
export function wireCopy(root) {
  if (root.dataset.copyWired) return;
  root.dataset.copyWired = "1";
  root.addEventListener("click", (event) => {
    const button = event.target.closest("[data-copy]");
    if (!button || !root.contains(button)) return;
    event.preventDefault();
    event.stopPropagation();
    copy(button.dataset.copy, button);
  });
}

/** Inline copy button: the icon becomes a tick on the button itself. */
export function copyButton(text, label = "Copy") {
  const button = el("button.copybtn", { type: "button", dataset: { copy: text }, title: `Copy: ${text}` });
  button.innerHTML = `
    <span class="copyico">
      ${icons.copy.replace("<svg", '<svg class="copyico__copy"')}
      ${icons.check.replace("<svg", '<svg class="copyico__done"')}
    </span>
    <span class="copybtn__text"></span>`;
  // Set as a property, not interpolated into markup: callers pass names that
  // came from a monitored machine (service names, command lines).
  button.querySelector(".copybtn__text").dataset.idle = label;
  return button;
}

/* ══ Dialog ════════════════════════════════════════════════════════════ */
let modalState = null;

/**
 * @param {object} opts
 *   title, body (Node|string), footer (Node|null), narrow: boolean
 *   dismissible: false for destructive confirmations (no backdrop click)
 *   initialFocus: "confirm" | "cancel" | Element | null
 */
export function openModal(opts) {
  const backdrop = $("#modal-backdrop");
  const modal = $("#modal");
  const titleNode = $("#modal-title");
  const bodyNode = $("#modal-body");
  const footNode = $("#modal-foot");
  if (!backdrop) return null;

  closeModal({ silent: true });
  const opener = document.activeElement;

  titleNode.textContent = "";
  if (opts.title instanceof Node) titleNode.append(opts.title);
  else titleNode.textContent = opts.title || "";

  bodyNode.replaceChildren();
  if (opts.body instanceof Node) bodyNode.append(opts.body);
  else if (typeof opts.body === "string") bodyNode.innerHTML = opts.body;

  if (opts.footer) {
    footNode.replaceChildren(opts.footer);
    footNode.hidden = false;
  } else {
    footNode.replaceChildren();
    footNode.hidden = true;
  }

  modal.classList.toggle("dialog--narrow", !!opts.narrow);
  backdrop.hidden = false;
  bodyNode.scrollTop = 0;

  modalState = { opener, dismissible: opts.dismissible !== false, onClose: opts.onClose || null };

  // Focus an input if there is one to type into, otherwise the safest action.
  requestAnimationFrame(() => {
    let target = null;
    if (opts.initialFocus instanceof Element) target = opts.initialFocus;
    else if (opts.initialFocus === "confirm") target = $("[data-role=confirm]", footNode);
    else if (opts.initialFocus === "cancel") target = $("[data-role=cancel]", footNode);
    else target = $("input[data-autofocus]", bodyNode) || $("#modal-close");
    target?.focus();
  });

  return { body: bodyNode, footer: footNode, title: titleNode, close: closeModal };
}

function closeModal({ silent = false } = {}) {
  const backdrop = $("#modal-backdrop");
  if (!backdrop || backdrop.hidden) return;
  backdrop.hidden = true;
  $("#modal-body").replaceChildren();
  $("#modal-foot").replaceChildren();
  const state = modalState;
  modalState = null;
  if (state && !silent) {
    state.onClose?.();
    if (state.opener?.isConnected) state.opener.focus();
  }
}

export function initModal() {
  const backdrop = $("#modal-backdrop");
  $("#modal-close")?.addEventListener("click", () => closeModal());

  // Click outside closes — except for destructive confirmations.
  backdrop?.addEventListener("mousedown", (event) => {
    if (event.target !== backdrop) return;
    if (modalState?.dismissible === false) return;
    closeModal();
  });

  document.addEventListener("keydown", (event) => {
    if (!backdrop || backdrop.hidden) return;
    // Escape closes, always: even a destructive dialog must be escapable.
    if (event.key === "Escape") {
      event.preventDefault();
      closeModal();
      return;
    }
    if (event.key === "Tab") {
      const items = focusables($("#modal"));
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  });
}

/**
 * Destructive confirmation: backdrop click disabled, focus on Cancel, and the
 * confirm button disabled only *while* the action is in flight.
 */
export function confirmAction({
  title, message, detail, confirmLabel = "Confirm", danger = true, onConfirm,
}) {
  const result = el("div.result");
  const cancel = el("button.btn", { type: "button", dataset: { role: "cancel" } }, ["Cancel"]);
  const confirm = el(`button.btn.${danger ? "btn--danger-solid" : "btn--primary"}`,
    { type: "button", dataset: { role: "confirm" } }, [confirmLabel]);
  const footer = el("div", { style: { display: "contents" } }, [result, el("span.spacer"), cancel, confirm]);

  cancel.addEventListener("click", () => closeModal());
  confirm.addEventListener("click", async () => {
    setBusy(confirm, true, confirmLabel);
    result.replaceChildren();
    try {
      const outcome = await onConfirm();
      inlineResult(result, outcome || "Done", "ok");
      setTimeout(() => closeModal(), 900);
    } catch (error) {
      inlineResult(result, error.message, "error");
      setBusy(confirm, false, confirmLabel);
    }
  });

  const body = el("div", {}, [el("p", { text: message })]);
  if (detail) body.append(note("warn", detail, { margin: true }));

  return openModal({
    title, body, footer, narrow: true,
    dismissible: false,
    initialFocus: "cancel",
  });
}

/* ══ Inline result / busy state ════════════════════════════════════════ */
export function inlineResult(node, message, tone = "ok") {
  if (!node) return;
  node.dataset.tone = tone;
  node.innerHTML = `${tone === "ok" ? icons.check : icons.warn}<span></span>`;
  node.querySelector("span").textContent = message;
}

/** Disable a button only while its action runs. Never pre-disabled. */
export function setBusy(button, busy, label) {
  if (!button) return;
  if (busy) {
    button.dataset.label = button.textContent;
    button.disabled = true;
    button.replaceChildren(el("span.btn__spin"), document.createTextNode(label || "Working…"));
  } else {
    button.disabled = false;
    button.replaceChildren(document.createTextNode(label || button.dataset.label || "Done"));
  }
}

/* ══ Skeletons ═════════════════════════════════════════════════════════ */
export function skeletonLines(count = 3, widths = null) {
  const stack = el("div.sk-stack");
  for (let i = 0; i < count; i += 1) {
    const width = widths ? widths[i % widths.length] : `${88 - i * 9}%`;
    stack.append(el("div.sk.sk--text", { style: { width } }));
  }
  return stack;
}

export function skeletonRows(count = 6) {
  const stack = el("div.sk-stack", { style: { padding: "6px 0" } });
  for (let i = 0; i < count; i += 1) stack.append(el("div.sk.sk--row"));
  return stack;
}

export function skeletonMetric() {
  return el("div", { style: { padding: "12px 14px" } }, [
    el("div.sk.sk--text", { style: { width: "34%" } }),
    el("div.sk.sk--num", { style: { margin: "8px 0 10px" } }),
    el("div.sk.sk--chart"),
  ]);
}

/** Hold a skeleton for at least `min` ms so a fast response does not flash. */
export function minDelay(promise, min = 300) {
  return Promise.all([promise, new Promise((r) => setTimeout(r, min))]).then(([v]) => v);
}

/* ══ Empty / gated / note ══════════════════════════════════════════════ */
export function emptyState(title, hint, icon = icons.empty) {
  const node = el("div.empty");
  if (icon) node.append(frag(icon));
  node.append(el("div.empty__title", { text: title }));
  if (hint) node.append(el("div.empty__hint", { text: hint }));
  return node;
}

/**
 * The explicit "requires elevation" state. Never a blank space: it says what
 * is missing, why, and the exact command that fixes it — with a copy button.
 */
export function gatedState({ title, body, command }) {
  const node = el("div.gated");
  node.innerHTML = `<div class="gated__title">${icons.lock}<span></span></div><div class="gated__body"></div>`;
  node.querySelector(".gated__title span").textContent = title;
  node.querySelector(".gated__body").textContent = body;
  if (command) {
    node.append(el("div.gated__cmd", {}, [el("code.code", { text: command }), copyButton(command, "Copy")]));
  }
  return node;
}

/**
 * A short note with a coloured rule. `content` is trusted HTML when given as a
 * string built by the caller (escape interpolated values with fmt.esc), or a
 * Node.
 */
export function note(kind, content, { margin = false } = {}) {
  const node = el(`div.note${kind && kind !== "info" ? `.note--${kind}` : ""}`,
    margin ? { style: { marginTop: "10px" } } : {});
  const icon = { warn: icons.warn, ok: icons.ok, crit: icons.crit }[kind] || icons.info;
  const slot = el("div");
  node.append(frag(icon), slot);
  if (content instanceof Node) slot.append(content);
  else slot.innerHTML = content;
  return node;
}

/* ══ Expandable section ════════════════════════════════════════════════ */
/** `onOpen` runs once, the first time it is expanded — how expensive detail
 *  (open files, per-thread times) is loaded only when actually wanted. */
export function expandable({ label, hint, onOpen, open = false }) {
  const body = el("div.expand__body");
  const toggle = el("button.expand__toggle", { type: "button" });
  toggle.innerHTML = `${icons.chevron}<span></span>`;
  toggle.querySelector("span").textContent = label;
  if (hint) toggle.append(el("span.expand__hint", { text: hint }));
  const wrapper = el("div.expand", {}, [toggle, body]);
  let loaded = false;

  const doOpen = async () => {
    wrapper.classList.add("is-open");
    if (loaded || !onOpen) return;
    loaded = true;
    body.replaceChildren(skeletonLines(3));
    try {
      const content = await minDelay(onOpen(), 240);
      body.replaceChildren(content || emptyState("Nothing to show"));
    } catch (error) {
      body.replaceChildren(emptyState("Could not load", error.message));
    }
  };
  toggle.addEventListener("click", () => {
    if (wrapper.classList.contains("is-open")) wrapper.classList.remove("is-open");
    else doOpen();
  });
  if (open) doOpen();
  return { node: wrapper, body, open: doOpen };
}

/* ══ Segmented control ═════════════════════════════════════════════════ */
/** Visible options for 2–5 mutually exclusive choices, instead of a dropdown. */
export function segmented({ label, options, value, onChange }) {
  const node = el("div.seg", { role: "group", "aria-label": label || "" });
  if (label) node.append(el("span.seg__label", { text: label }));
  const opts = el("span.seg__opts");
  const buttons = new Map();
  for (const option of options) {
    const button = el("button.seg__opt", {
      type: "button", dataset: { value: String(option.value) }, title: option.title || "",
    }, [option.label]);
    if (String(option.value) === String(value)) button.classList.add("is-on");
    button.addEventListener("click", () => {
      for (const other of buttons.values()) other.classList.remove("is-on");
      button.classList.add("is-on");
      onChange(option.value);
    });
    buttons.set(String(option.value), button);
    opts.append(button);
  }
  node.append(opts);
  node.setValue = (next) => {
    for (const [key, button] of buttons) button.classList.toggle("is-on", key === String(next));
  };
  return node;
}

/* ══ Toggle switch ═════════════════════════════════════════════════════ */
/** For independent settings that take effect immediately — no submit step. */
export function switchControl({ label, checked, onChange, title }) {
  const input = el("input", { type: "checkbox" });
  input.checked = !!checked;
  const node = el("label.toggle", { title: title || "" }, [
    input,
    el("span.toggle__track", {}, [el("span.toggle__knob")]),
    el("span", { text: label }),
  ]);
  input.addEventListener("change", () => onChange(input.checked));
  node.setChecked = (next) => { input.checked = !!next; };
  return node;
}

/* ══ Search field ══════════════════════════════════════════════════════ */
/** A search input with a clear button. No maxLength: pasting a path works. */
export function searchField({ placeholder, label, onInput }) {
  const input = el("input", {
    type: "search", placeholder, "aria-label": label || placeholder,
    autocomplete: "off", spellcheck: "false",
  });
  const clear = el("button.input__clear", {
    type: "button", title: "Clear", "aria-label": "Clear filter", hidden: true,
  });
  clear.innerHTML = icons.x;
  const node = el("div.input.input--search", {}, [frag(icons.search), input, clear]);
  input.addEventListener("input", () => {
    clear.hidden = !input.value;
    onInput(input.value);
  });
  clear.addEventListener("click", () => {
    input.value = "";
    clear.hidden = true;
    input.focus();
    onInput("");
  });
  node.input = input;
  return node;
}

/* ══ Searchable select ═════════════════════════════════════════════════ */
/**
 * Combobox for lists of ~10 or more options. Types to filter, shows "No
 * results", clears the search on close, keeps showing the selected value.
 */
export function combobox({ label, options, value, onChange, allLabel = "All" }) {
  const valueNode = el("span.combo__val");
  const button = el("button.combo__btn", { type: "button" });
  button.append(valueNode);
  button.insertAdjacentHTML("beforeend", icons.caret);

  const search = el("input", {
    type: "search", placeholder: "Type to filter…",
    "aria-label": `Filter ${label || "options"}`, autocomplete: "off", spellcheck: "false",
  });
  const list = el("div.combo__list", { role: "listbox" });
  const pop = el("div.combo__pop", { hidden: true }, [
    el("div.combo__search", {}, [el("div.input", {}, [frag(icons.search), search])]),
    list,
  ]);
  const node = el("div.combo", {}, [button, pop]);

  let current = value ?? null;
  let items = options;
  let cursor = 0;

  const labelFor = (val) => (val === null || val === undefined)
    ? allLabel
    : items.find((o) => String(o.value) === String(val))?.label ?? String(val);

  const paint = () => {
    valueNode.replaceChildren();
    if (label) valueNode.append(el("b", { text: `${label} ` }));
    valueNode.append(document.createTextNode(labelFor(current)));
  };

  const renderList = () => {
    const query = search.value.trim().toLowerCase();
    const shown = [{ value: null, label: allLabel, count: null }, ...items]
      .filter((o) => !query || String(o.label).toLowerCase().includes(query));
    list.replaceChildren();
    if (!shown.length) {
      list.append(el("div.combo__empty", { text: `No options match “${search.value.trim()}”` }));
      return;
    }
    shown.forEach((option, index) => {
      const item = el("button.combo__opt", {
        type: "button", role: "option",
        dataset: { value: option.value === null ? "" : String(option.value) },
      });
      item.innerHTML = icons.check.replace("<svg", '<svg class="tick"');
      item.append(el("span", { text: option.label }));
      if (option.count !== null && option.count !== undefined) {
        item.append(el("span.count", { text: String(option.count) }));
      }
      const selected = (option.value === null && current === null)
        || String(option.value) === String(current);
      item.classList.toggle("is-selected", selected);
      item.classList.toggle("is-cursor", index === cursor);
      item.addEventListener("click", () => {
        current = option.value;
        paint();
        close();
        onChange(current);
      });
      list.append(item);
    });
  };

  const outside = (event) => { if (!node.contains(event.target)) close(); };
  const open = () => {
    pop.hidden = false;
    search.value = "";
    cursor = 0;
    renderList();
    requestAnimationFrame(() => search.focus());
    document.addEventListener("mousedown", outside, true);
  };
  const close = () => {
    pop.hidden = true;
    search.value = "";
    document.removeEventListener("mousedown", outside, true);
  };

  button.addEventListener("click", () => (pop.hidden ? open() : close()));
  search.addEventListener("input", () => { cursor = 0; renderList(); });
  search.addEventListener("keydown", (event) => {
    const shown = $$(".combo__opt", list);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      cursor = Math.max(0, Math.min(shown.length - 1, cursor + (event.key === "ArrowDown" ? 1 : -1)));
      shown.forEach((item, i) => item.classList.toggle("is-cursor", i === cursor));
      shown[cursor]?.scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter") {
      event.preventDefault();
      shown[cursor]?.click();
    } else if (event.key === "Escape") {
      event.preventDefault();
      close();
      button.focus();
    }
  });

  node.setOptions = (next) => { items = next; if (!pop.hidden) renderList(); paint(); };
  node.setValue = (next) => { current = next; paint(); };
  paint();
  return node;
}

/* ══ Checkbox tree ═════════════════════════════════════════════════════ */
/**
 * Hierarchical selection with a deferred Apply — checkboxes, not toggles,
 * because parents need an indeterminate state and nothing applies until
 * Apply is pressed.
 */
export function checkTree({ groups, selected, onApply }) {
  const state = new Set(selected);
  const wrapper = el("div");

  for (const group of groups) {
    const parentInput = el("input", { type: "checkbox" });
    const parentLabel = el("label.check", {}, [
      parentInput, el("span.check__box"),
      el("span", { text: group.label }),
      el("span.check__count", { text: String(group.count ?? "") }),
    ]);
    const container = el("div.checkgroup", {}, [parentLabel]);
    const children = [];

    for (const child of group.children) {
      const childInput = el("input", { type: "checkbox" });
      childInput.checked = state.has(child.value);
      container.append(el("label.check.check--child", {}, [
        childInput, el("span.check__box"),
        el("span", { text: child.label }),
        el("span.check__count", { text: String(child.count ?? "") }),
      ]));
      childInput.addEventListener("change", () => {
        if (childInput.checked) state.add(child.value);
        else state.delete(child.value);
        syncParent();
      });
      children.push({ input: childInput, value: child.value });
    }

    const syncParent = () => {
      const on = children.filter((c) => c.input.checked).length;
      parentInput.checked = on === children.length && on > 0;
      parentInput.indeterminate = on > 0 && on < children.length;
    };
    parentInput.addEventListener("change", () => {
      for (const child of children) {
        child.input.checked = parentInput.checked;
        if (parentInput.checked) state.add(child.value);
        else state.delete(child.value);
      }
      parentInput.indeterminate = false;
    });
    syncParent();
    wrapper.append(container);
  }

  const apply = el("button.btn.btn--primary.btn--sm", { type: "button" }, ["Apply"]);
  const reset = el("button.btn.btn--ghost.btn--sm", { type: "button" }, ["Select all"]);
  apply.addEventListener("click", () => onApply(Array.from(state)));
  reset.addEventListener("click", () => {
    for (const group of groups) for (const child of group.children) state.add(child.value);
    for (const input of $$("input[type=checkbox]", wrapper)) {
      input.checked = true;
      input.indeterminate = false;
    }
    onApply(Array.from(state));
  });
  wrapper.append(el("div.row", { style: { marginTop: "10px" } }, [apply, reset]));
  return wrapper;
}

/* ══ Scroll to top ═════════════════════════════════════════════════════ */
export function initScrollTop(scroller) {
  const button = $("#scrolltop");
  if (!button || !scroller) return;
  const update = () => {
    const show = scroller.scrollTop > 400;
    if (show) {
      button.hidden = false;
      requestAnimationFrame(() => button.classList.add("is-in"));
    } else {
      button.classList.remove("is-in");
      setTimeout(() => { if (scroller.scrollTop <= 400) button.hidden = true; }, 160);
    }
  };
  scroller.addEventListener("scroll", update, { passive: true });
  button.addEventListener("click", () => scroller.scrollTo({ top: 0, behavior: "smooth" }));
  update();
}

/* ══ Loading slots ═════════════════════════════════════════════════════ */
/**
 * A slot is a container whose content arrives later (the first tick of a
 * section, a fetch, a node switch). `pendingSlot` shows a skeleton in it and
 * notes when; `readySlot` swaps the real content in, but not before the
 * skeleton has been visible for `min` ms — a sub-100ms response would
 * otherwise flash a placeholder (uxgoodpatterns: skeleton loading).
 * A slot that is not pending is simply rendered, so every tick can call
 * readySlot without caring whether it is the first.
 */
export function pendingSlot(slot, skeleton) {
  if (!slot || slot._pendingSince) return;
  slot._pendingSince = Date.now();
  slot._readyToken = (slot._readyToken || 0) + 1;
  slot.replaceChildren(skeleton);
}

export function readySlot(slot, node, min = 320) {
  if (!slot) return;
  const children = [].concat(node).filter(Boolean);
  if (!slot._pendingSince) {
    const same = slot.childElementCount === children.length
      && children.every((child, i) => slot.children[i] === child);
    if (!same) slot.replaceChildren(...children);
    return;
  }
  const wait = Math.max(0, min - (Date.now() - slot._pendingSince));
  const token = (slot._readyToken = (slot._readyToken || 0) + 1);
  const swap = () => {
    if (slot._readyToken !== token) return;
    slot._pendingSince = 0;
    slot.replaceChildren(...children);
  };
  if (wait === 0) swap();
  else setTimeout(swap, wait);
}

/* Shape-matched skeletons for the app's own layouts. */
export function skeletonFigures(count = 6) {
  return el("div.figs", {}, Array.from({ length: count }, () => el("div.fig", {}, [
    el("div.sk.sk--text", { style: { width: "60%" } }),
    el("div.sk.sk--num", { style: { marginTop: "6px", height: "18px" } }),
  ])));
}

export function skeletonFacts(count = 12) {
  return el("div.facts", {}, Array.from({ length: count }, () => el("div.fact", {}, [
    el("div.sk.sk--text", { style: { width: "55%", height: "9px" } }),
    el("div.sk.sk--text", { style: { width: "80%", marginTop: "7px" } }),
  ])));
}

export function skeletonFleet(count = 3) {
  // Same structure as a real fleet card (head, three meter rows, footer), so
  // the placeholder is the size the card will be and nothing jumps.
  const row = () => el("div.node__row", {}, [
    el("div.sk.sk--text", { style: { height: "14px", width: "26px" } }),
    el("div.sk", { style: { height: "2px" } }),
    el("div.sk.sk--text", { style: { height: "14px", width: "34px", marginLeft: "auto" } }),
  ]);
  return el("div.fleet", {}, Array.from({ length: count }, () => el("div.node", {}, [
    el("div.node__head", {}, [
      el("div.sk.sk--text", { style: { height: "14px", width: "44%" } }),
      el("div.sk", { style: { height: "18px", width: "54px", borderRadius: "3px" } }),
    ]),
    row(), row(), row(),
    el("div.sk.sk--text", { style: { height: "11px", width: "72%", marginTop: "8px" } }),
  ])));
}

export function skeletonSection(title, rows = 6) {
  const head = el("div.sec__head", {}, [
    title ? el("div.sec__title", { text: title }) : el("div.sk.sk--text", { style: { width: "120px", height: "12px" } }),
  ]);
  return el("div.sec", {}, [head, el("div.sec__body", {}, [skeletonRows(rows)])]);
}

export function skeletonStatus() {
  return el("div.status", {}, [
    el("div.status__text", {}, [
      el("div.sk.sk--text", { style: { width: "140px", height: "16px" } }),
      el("div.sk.sk--text", { style: { width: "60%", marginTop: "8px" } }),
    ]),
    el("div.status__gauges", {}, Array.from({ length: 4 }, () => el("div.gauge", {}, [
      el("div.sk", { style: { width: "42px", height: "42px", borderRadius: "50%", margin: "0 auto" } }),
    ]))),
  ]);
}

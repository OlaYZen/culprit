/**
 * DOM helpers.
 *
 * Small on purpose. The one idea worth stating: `patchText` and `patchAttr`
 * write only when the value actually changed. At 1Hz across a few hundred
 * bindings, blind assignment causes continuous layout invalidation and makes
 * text unselectable (every write resets the selection). Comparing first is
 * cheaper than the reflow it avoids.
 */

export function $(selector, root = document) {
  return root.querySelector(selector);
}

export function $$(selector, root = document) {
  return Array.from(root.querySelectorAll(selector));
}

/**
 * Create an element.
 * `el("div.panel", {title: "x"}, [child, "text"])`
 */
export function el(spec, attrs = null, children = null) {
  const [tag, ...classes] = String(spec).split(".");
  const node = document.createElement(tag || "div");
  if (classes.length) node.className = classes.join(" ");
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key === "html") node.innerHTML = value;
      else if (key === "dataset") Object.assign(node.dataset, value);
      else if (key === "style") Object.assign(node.style, value);
      else if (key.startsWith("on") && typeof value === "function") {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (value === true) node.setAttribute(key, "");
      else node.setAttribute(key, value);
    }
  }
  if (children) {
    for (const child of [].concat(children)) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
  }
  return node;
}

/**
 * Build an element from an HTML string.
 *
 * The single definition of this in the codebase. It is how the inline SVG icon
 * strings become nodes, so it is used from `ui.js` (re-exported there as `svg`)
 * and from any view that needs to drop an icon into a container.
 */
export function frag(html) {
  const template = document.createElement("template");
  template.innerHTML = String(html).trim();
  return template.content.firstElementChild;
}

export function patchText(node, value) {
  if (!node) return;
  const text = value === null || value === undefined ? "" : String(value);
  if (node.textContent !== text) node.textContent = text;
}

export function patchAttr(node, name, value) {
  if (!node) return;
  if (value === null || value === undefined || value === false) {
    if (node.hasAttribute(name)) node.removeAttribute(name);
    return;
  }
  const text = value === true ? "" : String(value);
  if (node.getAttribute(name) !== text) node.setAttribute(name, text);
}

export function patchStyle(node, prop, value) {
  if (!node) return;
  if (node.style.getPropertyValue(prop) !== String(value)) {
    node.style.setProperty(prop, value);
  }
}

export function patchClass(node, name, on) {
  if (!node) return;
  if (node.classList.contains(name) !== !!on) node.classList.toggle(name, !!on);
}

export function show(node, visible) {
  if (!node) return;
  if (node.hidden === visible) node.hidden = !visible;
}

/** Event delegation: one listener for a whole list. */
export function delegate(root, type, selector, handler) {
  root.addEventListener(type, (event) => {
    const match = event.target.closest(selector);
    if (match && root.contains(match)) handler(event, match);
  });
}

export function on(node, type, handler, options) {
  node.addEventListener(type, handler, options);
  return () => node.removeEventListener(type, handler, options);
}

/** Replace a node's children in one operation. */
export function render(node, children) {
  if (!node) return;
  node.replaceChildren(...[].concat(children).filter(Boolean));
}

/** All focusable descendants, for modal focus trapping. */
export function focusables(root) {
  return $$(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]),' +
    ' textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    root,
  ).filter((node) => node.offsetParent !== null || node === document.activeElement);
}

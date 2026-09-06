/**
 * Mobile chrome: the bottom tab bar and the "More" sheet. Desktop is untouched
 * (all of this markup is display:none above the mobile breakpoint).
 *
 * Rather than duplicate the session controls and re-wire them, the top bar's
 * tool cluster is physically relocated into the sheet on small screens and
 * moved back on wide ones — the existing event handlers travel with the nodes.
 */

import { $, $$, patchClass } from "./util/dom.js";
import { store } from "./stream.js";

const MOBILE = window.matchMedia("(max-width: 820px)");
const PRIMARY = new Set(["overview", "doctor", "processes", "ports"]);

export function initMobile() {
  const sheet = $("#msheet");
  const moreBtn = $("#botnav-more");
  const slot = $("#msheet-controls");
  const tools = $(".topbar__tools");
  if (!sheet || !moreBtn || !slot) return;

  const open = () => sheet.classList.add("is-open");
  const close = () => sheet.classList.remove("is-open");

  moreBtn.addEventListener("click", () => {
    if (sheet.classList.contains("is-open")) close(); else open();
  });
  for (const node of $$("[data-msheet-close]", sheet)) node.addEventListener("click", close);
  wireGrab(sheet, close);
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") close(); });

  document.addEventListener("culprit:navigate", (event) => {
    close();
    patchClass(moreBtn, "is-active", !PRIMARY.has(event.detail));
  });

  const place = () => {
    if (!tools) return;
    (MOBILE.matches ? slot : $(".topbar")).appendChild(tools);
  };
  place();
  MOBILE.addEventListener("change", () => { place(); if (!MOBILE.matches) close(); });

  store.on(["diagnosis", "outage", "services", "events", "sync", "volumes", "nodes"], (state) => updateBadges(state));
  updateBadges(store.state);
}

/**
 * The grab handle drags the sheet. Pointer events so a finger and a mouse
 * share one path; the panel follows the pointer down (never up), the backdrop
 * fades with it, and on release the sheet finishes closing when it was pulled
 * past a third of its height or flicked, otherwise it springs back. A tap on
 * the handle still closes it, as it did when it was only a button.
 */
function wireGrab(sheet, close) {
  const grab = $(".sheet__grab", sheet);
  const panel = $(".sheet__panel", sheet);
  const backdrop = $(".sheet__backdrop", sheet);
  if (!grab || !panel) return;
  let active = null;   // { startY, lastY, lastT, velocity } while a drag is in progress

  const offset = (event) => Math.max(0, event.clientY - active.startY);
  const reset = () => {
    panel.classList.remove("is-dragging");
    backdrop?.classList.remove("is-dragging");
    // Clearing the inline transform in the same frame as the class change
    // makes the transition start from where the finger left the sheet.
    panel.style.transform = "";
    if (backdrop) backdrop.style.opacity = "";
  };

  grab.addEventListener("pointerdown", (event) => {
    if (!sheet.classList.contains("is-open") || active) return;
    active = { startY: event.clientY, lastY: event.clientY, lastT: event.timeStamp, velocity: 0 };
    grab.setPointerCapture(event.pointerId);
    panel.classList.add("is-dragging");
    backdrop?.classList.add("is-dragging");
  });
  grab.addEventListener("pointermove", (event) => {
    if (!active) return;
    const dt = event.timeStamp - active.lastT;
    if (dt > 0) active.velocity = (event.clientY - active.lastY) / dt;   // px per ms, downwards positive
    active.lastY = event.clientY;
    active.lastT = event.timeStamp;
    const dy = offset(event);
    panel.style.transform = `translateY(${dy}px)`;
    if (backdrop) backdrop.style.opacity = String(Math.max(0, 1 - dy / panel.offsetHeight));
  });
  grab.addEventListener("pointerup", (event) => {
    if (!active) return;
    const dy = offset(event);
    const tap = dy < 6;
    const dismiss = tap || dy > panel.offsetHeight / 3 || active.velocity > 0.6;
    active = null;
    reset();
    if (dismiss) close();
  });
  grab.addEventListener("pointercancel", () => {
    if (!active) return;
    active = null;
    reset();
  });
}

function updateBadges(state) {
  const findings = (state.diagnosis || {}).findings || [];
  const doctorSev = findings.some((f) => f.severity === "critical") ? "crit"
    : findings.some((f) => f.severity === "warn") ? "warn" : findings.length ? "info" : null;
  dot("botnav-doctor-dot", doctorSev);

  const services = (state.services || {}).problems || [];
  const broken = ((state.outage || {}).items || []).filter((i) => i.severity === "warn" || i.severity === "critical");
  const crashes = ((state.events || {}).crashes || {}).events || [];
  const eventsCrit = crashes.filter((e) => e.severity === "critical").length;
  const offline = (state.nodes || []).filter((n) => !n.online && n.enabled !== false).length;
  const sync = (state.sync || {}).problems || [];
  const lowSpace = (((state.volumes || {}).volumes) || []).filter((v) => (100 - v.percent) <= 10).length;

  badge("badge-services-m", services.length);
  badge("badge-outage-m", broken.length);
  badge("badge-events-m", eventsCrit);
  badge("badge-nodes-m", offline);
  dot("botnav-more-dot", (services.length || broken.length || eventsCrit || offline || sync.length || lowSpace) ? "warn" : null);
}

function dot(bind, severity) {
  const node = document.querySelector(`[data-bind="${bind}"]`);
  if (!node) return;
  patchClass(node, "is-on", !!severity);
  if (severity === "warn") node.setAttribute("data-severity", "warn");
  else node.removeAttribute("data-severity");
}

function badge(bind, value) {
  const node = document.querySelector(`[data-bind="${bind}"]`);
  if (!node) return;
  if (!value) { node.hidden = true; return; }
  node.hidden = false;
  node.textContent = String(value);
}

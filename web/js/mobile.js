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

  store.on(["diagnosis", "services", "events", "sync", "volumes", "nodes"], (state) => updateBadges(state));
  updateBadges(store.state);
}

function updateBadges(state) {
  const findings = (state.diagnosis || {}).findings || [];
  const doctorSev = findings.some((f) => f.severity === "critical") ? "crit"
    : findings.some((f) => f.severity === "warn") ? "warn" : findings.length ? "info" : null;
  dot("botnav-doctor-dot", doctorSev);

  const services = (state.services || {}).problems || [];
  const crashes = ((state.events || {}).crashes || {}).events || [];
  const eventsCrit = crashes.filter((e) => e.severity === "critical").length;
  const offline = (state.nodes || []).filter((n) => !n.online && n.enabled !== false).length;
  const sync = (state.sync || {}).problems || [];
  const lowSpace = (((state.volumes || {}).volumes) || []).filter((v) => (100 - v.percent) <= 10).length;

  badge("badge-services-m", services.length);
  badge("badge-events-m", eventsCrit);
  badge("badge-nodes-m", offline);
  dot("botnav-more-dot", (services.length || eventsCrit || offline || sync.length || lowSpace) ? "warn" : null);
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

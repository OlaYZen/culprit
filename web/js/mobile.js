/**
 * Mobile chrome: the bottom tab bar and the "More" sheet. Desktop is untouched
 * (all of this markup is display:none above the mobile breakpoint).
 *
 * The sheet holds the overflow views plus the session controls. Rather than
 * duplicate those controls and re-wire them, the titlebar's action cluster is
 * physically relocated into the sheet on small screens and moved back on wide
 * ones — the existing event handlers travel with the DOM nodes.
 */

import { $, $$, patchClass } from "./util/dom.js";
import { store } from "./stream.js";

const MOBILE = window.matchMedia("(max-width: 820px)");
const PRIMARY = new Set(["overview", "doctor", "processes", "ports"]);

export function initMobile() {
  const sheet = $("#msheet");
  const moreBtn = $("#botnav-more");
  const slot = $("#msheet-controls");
  const actions = $(".titlebar__actions");
  if (!sheet || !moreBtn || !slot) return;

  const open = () => sheet.classList.add("is-open");
  const close = () => sheet.classList.remove("is-open");

  moreBtn.addEventListener("click", () => {
    if (sheet.classList.contains("is-open")) close(); else open();
  });
  for (const el of $$("[data-msheet-close]", sheet)) el.addEventListener("click", close);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });

  // Every navigation (a bottom-nav tab or a sheet view) closes the sheet and
  // lights the More tab when the destination is an overflow view.
  document.addEventListener("culprit:navigate", (event) => {
    close();
    patchClass(moreBtn, "is-active", !PRIMARY.has(event.detail));
  });

  // Relocate the session controls between the titlebar and the sheet as the
  // viewport crosses the breakpoint.
  const place = () => {
    if (!actions) return;
    (MOBILE.matches ? slot : $(".titlebar")).appendChild(actions);
  };
  place();
  MOBILE.addEventListener("change", () => { place(); if (!MOBILE.matches) close(); });

  // Alert dots + sheet badges, mirroring the sidebar's badges for the views the
  // bottom bar can't show a count on.
  store.on(["diagnosis", "services", "events", "sync", "volumes", "nodes"],
    (state) => updateBadges(state));
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
  const lowSpace = (((state.volumes || {}).volumes) || [])
    .filter((v) => (100 - v.percent) <= 10).length;

  badge("badge-services-m", services.length);
  badge("badge-events-m", eventsCrit);
  badge("badge-nodes-m", offline);

  // The More tab carries a dot if anything behind it wants attention.
  dot("botnav-more-dot",
    (services.length || eventsCrit || offline || sync.length || lowSpace) ? "warn" : null);
}

function dot(bind, severity) {
  const el = document.querySelector(`[data-bind="${bind}"]`);
  if (!el) return;
  patchClass(el, "is-on", !!severity);
  if (severity === "warn") el.setAttribute("data-severity", "warn");
  else el.removeAttribute("data-severity");
}

function badge(bind, value) {
  const el = document.querySelector(`[data-bind="${bind}"]`);
  if (!el) return;
  if (!value) { el.hidden = true; return; }
  el.hidden = false;
  el.textContent = String(value);
}

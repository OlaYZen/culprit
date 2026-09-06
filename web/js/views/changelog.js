/**
 * Patch notes: what changed in this host, straight from the checkout's
 * commit history.
 *
 * The host runs from a git checkout, so the commit log is the change log:
 * one fetch per page load, grouped under the version version.json carried
 * after each commit (the host tags every commit with it), newest first. The
 * summary is the commit subject; the body is the commit's own explanation of
 * what changed and why. Nothing is written by hand and nothing can go stale.
 *
 * A host without a checkout (the container image) has no history: the view
 * says so, never an empty list dressed as "nothing changed".
 */

import { el } from "../util/dom.js";
import { api } from "../stream.js";
import { emptyState, icons, pendingSlot, readySlot, segmented, skeletonSection } from "../ui.js";
import { logItem, pill, section, viewHead } from "./shared.js";

const TYPE_WORD = {
  feat: "feature", fix: "fix", perf: "performance", refactor: "refactor", test: "tests",
  docs: "docs", chore: "chore", build: "build", ci: "ci", revert: "revert", style: "style",
};
const TYPE_TONE = { feat: "ok", fix: "info", perf: "info", revert: "warn" };
const FILTERS = {
  all: () => true,
  feat: (c) => c.type === "feat",
  fix: (c) => c.type === "fix" || c.type === "perf" || c.type === "revert",
};

export function createChangelog() {
  const root = el("div.view", { dataset: { view: "changelog" } });
  let payload = null;
  let loading = false;
  let filter = "all";

  const filterControl = segmented({
    label: "Show",
    options: [
      { value: "all", label: "All" },
      { value: "feat", label: "Features" },
      { value: "fix", label: "Fixes" },
    ],
    value: filter,
    onChange: (value) => { filter = value; if (payload) renderAll(); },
  });
  const head = viewHead({
    title: "Patch notes",
    lead: "What changed in this host, from its own commit history: each entry is a commit, grouped under the "
        + "version it shipped in, newest first.",
    tools: [filterControl],
  });
  root.append(head);
  const slot = el("div.stack");
  root.append(slot);

  async function load() {
    if (loading) return;
    if (payload) { renderAll(); return; }
    loading = true;
    head.setPending(true);
    pendingSlot(slot, el("div.stack", {}, [skeletonSection("v0.0.0-b", 4), skeletonSection("v0.0.0-b", 3)]));
    try {
      payload = await api("/api/changelog");
      head.setPending(false);
      renderAll();
    } catch (error) {
      head.setPending(false);
      readySlot(slot, section({ title: "Patch notes", body: emptyState("Could not load", error.message) }));
    } finally {
      loading = false;
    }
  }

  function groups(commits) {
    // Newest first, so a group is opened by the first commit seen at that
    // version; commits without one (a checkout with no version.json history)
    // gather under "unversioned".
    const out = [];
    const byVersion = new Map();
    for (const commit of commits) {
      const key = commit.version || "unversioned";
      let group = byVersion.get(key);
      if (!group) {
        group = { version: key, commits: [] };
        byVersion.set(key, group);
        out.push(group);
      }
      group.commits.push(commit);
    }
    return out;
  }

  function renderAll() {
    if (!payload.available) {
      readySlot(slot, section({
        title: "Patch notes",
        body: emptyState("No commit history here", payload.reason || "This host is not running from a git checkout."),
      }));
      return;
    }
    const keep = FILTERS[filter] || FILTERS.all;
    const shown = (payload.commits || []).filter(keep);
    if (!shown.length) {
      readySlot(slot, section({
        title: "Patch notes",
        body: emptyState("Nothing to show", filter === "all"
          ? "The checkout has no commits."
          : "No commits of that kind among the ones this host carries.", icons.ok),
      }));
      return;
    }
    const sections = groups(shown).map((group) => {
      const newest = group.commits[0];
      const bits = [`${group.commits.length} change${group.commits.length === 1 ? "" : "s"}`];
      if (newest.ts) bits.push(dateOf(newest.ts));
      const meta = el("span", {}, [
        group.version === payload.current ? pill("running now", "ok") : null,
        document.createTextNode(`${group.version === payload.current ? " · " : ""}${bits.join(" · ")}`),
      ]);
      return section({
        title: group.version === "unversioned" ? "Unversioned" : `v${group.version}`,
        meta,
        body: el("div.log", {}, group.commits.map(entry)),
      });
    });
    const foot = el("div.log__text", {
      text: `${shown.length} of ${payload.commits.length} commits on ${payload.branch || "this checkout"}`
        + (payload.commits.length >= (payload.limit || Infinity) ? `; only the newest ${payload.limit} are listed.` : "."),
    });
    readySlot(slot, [...sections, foot]);
  }

  function entry(commit) {
    const tags = [
      commit.type ? pill(TYPE_WORD[commit.type] || commit.type, TYPE_TONE[commit.type] || null) : null,
      commit.scope ? pill(commit.scope, null, { mono: true }) : null,
      commit.breaking ? pill("breaking", "crit") : null,
      commit.bumped_to ? pill(`v${commit.bumped_to}`, "info", { mono: true }) : null,
      pill(commit.short || commit.sha.slice(0, 7), null, { mono: true }),
    ].filter(Boolean);
    const paragraphs = String(commit.body || "").split(/\n\s*\n/)
      .map((p) => p.replace(/\s*\n\s*/g, " ").trim()).filter(Boolean);
    return logItem({
      ts: commit.ts,
      severity: commit.type === "feat" ? "ok" : commit.type === "fix" ? "info" : null,
      title: el("span", { text: sentence(commit.summary || commit.subject) }),
      tags,
      extra: paragraphs.length ? el("div", {}, paragraphs.map((p) => el("div.log__text", { text: p }))) : null,
    });
  }

  root.mount = () => { load(); };
  root.subscriptions = [];
  return root;
}

function sentence(text) {
  const s = String(text || "");
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function dateOf(ts) {
  return new Date(ts * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

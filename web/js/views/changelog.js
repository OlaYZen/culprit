/**
 * Patch notes: what changed in this host and in the agent, straight from
 * their commit histories.
 *
 * Both run from git, so the commit log is the change log: one fetch per
 * component per page load, grouped under the version version.json carried
 * after each commit, newest first. The host's notes are its own checkout;
 * the agent's are a mirror of the agent repository the host keeps and
 * refreshes hourly. The summary is the commit subject; the body is the
 * commit's own explanation. Nothing is written by hand and nothing goes
 * stale.
 *
 * On the agent side each version group also says which enrolled agents run
 * it, so an agent that is behind shows exactly what it is missing.
 *
 * A component without history (the container image, or a host that cannot
 * reach the agent repository) says so, never an empty list.
 */

import { el } from "../util/dom.js";
import * as fmt from "../util/format.js";
import { api, store } from "../stream.js";
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
const REPOS = ["host", "agent"];
const LEAD = {
  host: "What changed in this host, from its own commit history: each entry is a commit, grouped under the "
      + "version it shipped in, newest first.",
  agent: "What changed in the agent, from the agent repository's commit history: each entry is a commit, "
      + "grouped under the version it shipped in, newest first, with the enrolled agents running each version.",
};

export function createChangelog() {
  const root = el("div.view", { dataset: { view: "changelog" } });
  const payloads = {};
  const loading = {};
  let repo = "host";
  let filter = "all";

  // The tabs only write the hash; the router reads it back into setPage, so
  // a reload and the back button land on the same component.
  const repoControl = segmented({
    label: "Component",
    options: [{ value: "host", label: "Host" }, { value: "agent", label: "Agent" }],
    value: repo,
    onChange: (value) => { location.hash = `#changelog/${value}`; },
  });
  const filterControl = segmented({
    label: "Show",
    options: [
      { value: "all", label: "All" },
      { value: "feat", label: "Features" },
      { value: "fix", label: "Fixes" },
    ],
    value: filter,
    onChange: (value) => { filter = value; if (payloads[repo]) renderAll(); },
  });
  const head = viewHead({ title: "Patch notes", lead: LEAD.host, tools: [repoControl, filterControl] });
  root.append(head);
  const slot = el("div.stack");
  root.append(slot);

  root.setPage = (key) => {
    const next = REPOS.includes(key) ? key : "host";
    if (next === repo && payloads[repo]) return;
    repo = next;
    repoControl.setValue(repo);
    head.leadNode.textContent = LEAD[repo];
    load();
  };

  async function load() {
    const which = repo;
    if (payloads[which]) { renderAll(); return; }
    if (loading[which]) return;
    loading[which] = true;
    head.setPending(true);
    pendingSlot(slot, el("div.stack", {}, [skeletonSection("v0.0.0-b", 4), skeletonSection("v0.0.0-b", 3)]));
    try {
      payloads[which] = await api(`/api/changelog?repo=${which}`);
    } catch (error) {
      payloads[which] = { available: false, reason: error.message, error: true, commits: [] };
    } finally {
      loading[which] = false;
    }
    if (which !== repo) return;
    head.setPending(false);
    renderAll();
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

  let renderedRunningKey = null;

  /** A stable fingerprint of who runs which version. */
  function runningKey() {
    return [...runningBy()].map(([version, names]) => `${version}:${names.join(",")}`).sort().join("|");
  }

  /** Enrolled agents by the version they last reported, for the agent side. */
  function runningBy() {
    const map = new Map();
    for (const node of store.state.nodes || []) {
      if (!node.agent_version || node.enabled === false) continue;
      if (!map.has(node.agent_version)) map.set(node.agent_version, []);
      map.get(node.agent_version).push(node.name);
    }
    return map;
  }

  function renderAll() {
    const payload = payloads[repo];
    if (!payload.available) {
      readySlot(slot, section({
        title: repo === "agent" ? "Agent patch notes" : "Patch notes",
        body: emptyState(payload.error ? "Could not load" : "No commit history here",
          payload.reason || (repo === "agent"
            ? "This host could not fetch the agent repository."
            : "This host is not running from a git checkout.")),
      }));
      return;
    }
    const keep = FILTERS[filter] || FILTERS.all;
    const shown = (payload.commits || []).filter(keep);
    if (!shown.length) {
      readySlot(slot, section({
        title: "Patch notes",
        body: emptyState("Nothing to show", filter === "all"
          ? "The repository has no commits."
          : "No commits of that kind among the ones listed.", icons.ok),
      }));
      return;
    }
    const running = repo === "agent" ? runningBy() : null;
    renderedRunningKey = running ? runningKey() : null;
    const behind = running ? [...running.keys()].filter((v) => !(payload.commits || []).some((c) => c.version === v)) : [];
    const sections = groups(shown).map((group, index) => {
      const newest = group.commits[0];
      const marks = [];
      if (repo === "host" && group.version === payload.current) marks.push(pill("running now", "ok"));
      if (repo === "agent" && index === 0 && group.version === payload.current) marks.push(pill("latest", "info"));
      if (running && running.has(group.version)) {
        const names = running.get(group.version);
        marks.push(pill(`running on ${names.join(", ")}`, group.version === payload.current ? "ok" : "warn"));
      }
      const bits = [`${group.commits.length} change${group.commits.length === 1 ? "" : "s"}`];
      if (newest.ts) bits.push(dateOf(newest.ts));
      const meta = el("span", {}, [
        marks.length ? el("span.pills", { style: { display: "inline-flex", verticalAlign: "middle" } }, marks) : null,
        document.createTextNode(`${marks.length ? " · " : ""}${bits.join(" · ")}`),
      ]);
      return section({
        title: group.version === "unversioned" ? "Unversioned" : `v${group.version}`,
        meta,
        body: el("div.log", {}, group.commits.map(entry)),
      });
    });
    const footBits = [`${shown.length} of ${payload.commits.length} commits on ${payload.branch || "this checkout"}`
      + (payload.commits.length >= (payload.limit || Infinity) ? `; only the newest ${payload.limit} are listed` : "")];
    if (repo === "agent") {
      if (payload.fetched_at) footBits.push(`mirror of ${payload.source || "the agent repository"} fetched ${fmt.ago(payload.fetched_at)}`);
      if (payload.stale_reason) footBits.push(`not refreshed: ${payload.stale_reason}`);
      if (behind.length) footBits.push(`agents on a version not in this list: ${behind.map((v) => `v${v} (${running.get(v).join(", ")})`).join("; ")}`);
    }
    readySlot(slot, [...sections, el("div.log__text", { text: `${footBits.join(". ")}.` })]);
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
  // The router hands a page to setPage only when the hash carries one, so
  // the back button landing on a bare "#changelog" would leave the agent
  // side showing: read the hash here and default to the host.
  window.addEventListener("hashchange", () => {
    if (!root.isActive) return;
    const [base, page] = location.hash.slice(1).split("/");
    if (base === "changelog") root.setPage(page || "host");
  });
  root.subscriptions = [
    // The agent side annotates versions with who runs them. The node list
    // arrives with every agent report (once a second), but the annotation
    // only changes when an agent's version does, so re-render only then:
    // rebuilding the entries each second replaced the text under a
    // selection and made the notes impossible to copy.
    store.on("nodes", () => {
      if (!root.isActive || repo !== "agent" || !payloads.agent) return;
      if (runningKey() !== renderedRunningKey) renderAll();
    }),
  ];
  return root;
}

function sentence(text) {
  const s = String(text || "");
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function dateOf(ts) {
  return new Date(ts * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

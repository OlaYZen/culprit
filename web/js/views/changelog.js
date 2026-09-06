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
 * Either side can be read at any branch the repository has (the picker in
 * the head; "#changelog/agent/dev" in the hash): a host on dev can read what
 * main ships and the other way round. The running (host) and configured
 * (agent) branch are the defaults, and a view of another branch says so.
 *
 * A component without history (the container image, or a host that cannot
 * reach the agent repository) says so, never an empty list.
 */

import { el } from "../util/dom.js";
import * as fmt from "../util/format.js";
import { api, store } from "../stream.js";
import { combobox, emptyState, icons, pendingSlot, readySlot, segmented, skeletonSection } from "../ui.js";
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
const BRANCH_WORD = { main: "release line", dev: "unreleased work" };
const LEAD = {
  host: "What changed in this host, from its own commit history: each entry is a commit, grouped under the "
      + "version it shipped in, newest first.",
  agent: "What changed in the agent, from the agent repository's commit history: each entry is a commit, "
      + "grouped under the version it shipped in, newest first, with the enrolled agents running each version.",
};

export function createChangelog() {
  const root = el("div.view", { dataset: { view: "changelog" } });
  const payloads = {};      // `${repo}/${branch}` -> /api/changelog payload
  const listings = {};      // repo -> /api/changelog/branches payload
  const loading = {};
  let repo = "host";
  let branch = { host: null, agent: null };   // null: the repository's default branch
  let filter = "all";

  // The tabs and the picker only write the hash; the router reads it back
  // into setPage, so a reload and the back button land on the same
  // component and branch.
  const repoControl = segmented({
    label: "Component",
    options: [{ value: "host", label: "Host" }, { value: "agent", label: "Agent" }],
    value: repo,
    onChange: (value) => { location.hash = hashFor(value, branch[value]); },
  });
  const branchControl = combobox({
    label: "Branch", allLabel: null, ariaLabel: "Branch to read the patch notes at",
    options: [], value: "…",
    onChange: (value) => { location.hash = hashFor(repo, value); },
  });
  const filterControl = segmented({
    label: "Show",
    options: [
      { value: "all", label: "All" },
      { value: "feat", label: "Features" },
      { value: "fix", label: "Fixes" },
    ],
    value: filter,
    onChange: (value) => { filter = value; if (payloads[keyOf(repo, branch[repo])]) renderAll(); },
  });
  const head = viewHead({ title: "Patch notes", lead: LEAD.host, tools: [repoControl, branchControl, filterControl] });
  root.append(head);
  const slot = el("div.stack");
  root.append(slot);

  function hashFor(component, name) {
    return `#changelog/${component}${name ? `/${encodeURIComponent(name)}` : ""}`;
  }

  /** The cache key of the current choice; a null branch is the default. */
  const keyOf = (component, name) => `${component}/${name || ""}`;

  root.setPage = (key) => {
    const [component, ...rest] = String(key || "").split("/");
    const next = REPOS.includes(component) ? component : "host";
    let name = rest.length ? decodeURIComponent(rest.join("/")) : null;
    // The default branch spelled out in the hash is the same page as no
    // branch at all, so the two never load twice.
    if (name && listings[next]?.default === name) name = null;
    if (next === repo && name === branch[next] && payloads[keyOf(repo, name)]) return;
    repo = next;
    branch[next] = name;
    repoControl.setValue(repo);
    head.leadNode.textContent = LEAD[repo];
    load();
  };

  async function load() {
    const which = repo;
    const name = branch[which];
    const key = keyOf(which, name);
    if (payloads[key] && listings[which]) { paintBranches(); renderAll(); return; }
    if (loading[key]) return;
    loading[key] = true;
    head.setPending(true);
    branchControl.setValue(name || "…");
    pendingSlot(slot, el("div.stack", {}, [skeletonSection("v0.0.0-b", 4), skeletonSection("v0.0.0-b", 3)]));
    try {
      const query = `repo=${which}${name ? `&branch=${encodeURIComponent(name)}` : ""}`;
      const [listing, payload] = await Promise.all([
        listings[which] ? Promise.resolve(listings[which])
          : api(`/api/changelog/branches?repo=${which}&refresh=1`)
            .catch((error) => ({ available: false, reason: error.message, branches: [], default: null })),
        api(`/api/changelog?${query}`),
      ]);
      listings[which] = listing;
      payloads[key] = payload;
    } catch (error) {
      payloads[key] = { available: false, reason: error.message, error: true, commits: [], branch: name };
    } finally {
      loading[key] = false;
    }
    if (which !== repo || name !== branch[which]) return;
    head.setPending(false);
    paintBranches();
    renderAll();
  }

  /** The picker lists what the repository has, the current choice always
   * among them (a branch typed into the hash that the listing lacks is
   * still shown, marked), the default named for what it is. */
  function paintBranches() {
    const listing = listings[repo] || { branches: [], default: null };
    const payload = payloads[keyOf(repo, branch[repo])] || {};
    const names = listing.branches.slice();
    const shown = branch[repo] || listing.default || payload.branch;
    if (shown && !names.includes(shown)) names.push(shown);
    const defaultWord = repo === "host" ? "running now" : "agents follow this";
    branchControl.setOptions(names.map((name) => ({
      value: name,
      label: name
        + (name === listing.default ? ` · ${defaultWord}` : BRANCH_WORD[name] ? ` · ${BRANCH_WORD[name]}` : "")
        + (!listing.branches.includes(name) ? " · not in the repository" : ""),
    })));
    branchControl.setValue(shown || "…");
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
    const payload = payloads[keyOf(repo, branch[repo])];
    const listing = listings[repo] || {};
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
      if (repo === "host" && payload.current && group.version === payload.current) marks.push(pill("running now", "ok"));
      if (index === 0 && payload.tip && group.version === payload.tip && !(repo === "host" && payload.running)) {
        marks.push(pill(`latest on ${payload.branch || "this branch"}`, "info"));
      }
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
    if (repo === "host") {
      if (!payload.running && payload.running_branch) footBits.push(`this host runs from ${payload.running_branch}`);
      if (!payload.running && payload.fetched_at) footBits.push(`origin fetched ${fmt.ago(payload.fetched_at)}`);
      if (payload.stale_reason) footBits.push(`not refreshed: ${payload.stale_reason}`);
    }
    if (repo === "agent") {
      const configured = payload.configured_branch || listing.configured;
      if (configured && payload.branch !== configured) {
        footBits.push(`agents follow ${configured} (Settings › Automatic agent updates)`);
      }
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
    const [base, ...rest] = location.hash.slice(1).split("/");
    if (base === "changelog") root.setPage(rest.join("/") || "host");
  });
  root.subscriptions = [
    // The agent side annotates versions with who runs them. The node list
    // arrives with every agent report (once a second), but the annotation
    // only changes when an agent's version does, so re-render only then:
    // rebuilding the entries each second replaced the text under a
    // selection and made the notes impossible to copy.
    store.on("nodes", () => {
      if (!root.isActive || repo !== "agent" || !payloads[keyOf(repo, branch[repo])]) return;
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

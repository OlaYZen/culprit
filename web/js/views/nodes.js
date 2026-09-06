/**
 * Nodes: enroll agents and manage their tokens, entirely from the dashboard.
 *
 * The one hard rule here is the honesty of secrets: a token exists in
 * plaintext exactly once — in the response that minted it, rendered in the
 * reveal section below — and can never be shown again, because the server
 * only keeps its hash. Enrollment and rotation return a paste-ready deploy
 * command, because the usual failure of these flows is a token copied without
 * its context.
 */

import { el, patchAttr, patchText, render, show } from "../util/dom.js";
import * as fmt from "../util/format.js";
import { api, store } from "../stream.js";
import {
  combobox, confirmAction, emptyState, inlineResult, note, openModal, pendingSlot, readySlot, setBusy,
  skeletonFigures, skeletonSection,
} from "../ui.js";
import { canAdminister, canOperate, codeRow, figures, kv, kvs, pill, section, subhead, viewHead } from "./shared.js";

export function createNodes() {
  const root = el("div.view", { dataset: { view: "nodes" } });
  let built = false;
  // Rows are reconciled by node name, not rebuilt every poll: replacing the
  // tbody each tick (the "Last report" column changes every few seconds)
  // recreated every button, which discarded hover state and closed any
  // tooltip the moment it opened. Only what actually changed is patched.
  const rowsByName = new Map();
  let tableSection = null;
  let tbody = null;

  const head = viewHead({
    title: "Nodes",
    lead: "Enroll agents on other servers and manage their tokens. Agents are outbound-only — they open no port — "
        + "yet act with full parity: process detail, End task, renice and port kills are relayed to them and run locally.",
  });
  root.append(head);

  const figSlot = el("div");
  const revealSlot = el("div");
  const enrollSlot = el("div");
  const tableSlot = el("div");
  const helpSlot = el("div");
  root.append(el("div.stack", {}, [figSlot, revealSlot, enrollSlot, tableSlot, helpSlot]));
  let loaded = false;

  function buildEnroll() {
    if (!canAdminister()) {
      render(enrollSlot, section({
        title: "Enroll a new agent",
        body: emptyState("Admin access required", "Only an admin can enroll agents or manage their tokens."),
      }));
      return;
    }
    const input = el("input", {
      type: "text", placeholder: "node name, e.g. web-01", autocomplete: "off", spellcheck: "false",
      "aria-label": "New node name",
    });
    const button = el("button.btn.btn--primary", { type: "button" }, ["Generate token"]);
    const result = el("div.result");

    async function enroll() {
      const name = input.value.trim();
      if (!name) {
        inlineResult(result, "Give the node a name first.", "error");
        input.focus();
        return;
      }
      setBusy(button, true, "Generating…");
      try {
        const payload = await api("/api/agents", { method: "POST", body: JSON.stringify({ name }) });
        input.value = "";
        result.replaceChildren();
        showToken(payload, "enrolled");
      } catch (error) {
        inlineResult(result, error.message, "error");
      } finally {
        setBusy(button, false, "Generate token");
      }
    }
    button.addEventListener("click", enroll);
    input.addEventListener("keydown", (event) => { if (event.key === "Enter") enroll(); });

    render(enrollSlot, section({
      title: "Enroll a new agent",
      body: el("div.formrow", {}, [el("div.input", { style: { flex: "1 1 220px" } }, [input]), button, result]),
      foot: "Names may use letters, digits, '-' and '_'. The token is generated server-side and stored only as a hash.",
    }));
  }

  function showToken(payload, verb) {
    const dismiss = el("button.btn.btn--sm", { type: "button" }, ["Dismiss"]);
    dismiss.addEventListener("click", () => revealSlot.replaceChildren());
    render(revealSlot, section({
      title: `Agent '${payload.name}' ${verb}`, tone: "warn", meta: dismiss,
      body: el("div", {}, [
        note("warn", "<strong>Copy this now.</strong> The token is shown only this once — the server keeps a hash, "
          + "not the token, so it cannot be displayed again. Losing it means rotating it."),
        subhead("Token"),
        codeRow(payload.token, "Copy token"),
        subhead("Docker host — paste and run"),
        codeRow(payload.docker_command, "Copy command"),
        el("div.faint.small", { style: { marginTop: "8px", lineHeight: "1.5" },
          text: "Runs the agent privileged in the host's namespaces (full port attribution) and auto-updates on "
              + "re-run. Some managed hosts (e.g. TrueNAS SCALE) disallow privileged/host mounts — there, use the native install below." }),
        subhead("Or native (agent.sh bundle)"),
        codeRow("git clone https://github.com/OlaYZen/culprit-agent.git && cd culprit-agent", "Copy clone"),
        codeRow(payload.deploy_command, "Copy command"),
        el("div.faint.small", { style: { marginTop: "8px", lineHeight: "1.5" },
          text: "Clone the agent repo on that server, then run the command inside it. agent.sh creates a venv, "
              + "checks the host accepts the token, saves both to agent.json, and offers to set itself up as a "
              + "systemd service that starts on boot. Run it under sudo for a system service as root (full process "
              + "and port attribution); without sudo it becomes a user service. Adjust the URL if agents reach "
              + "this host by a different address; add --insecure for a self-signed certificate." }),
      ]),
    }));
    revealSlot.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  // Update all: the per-node button fanned out over every agent the host
  // would pick (nodes.update_targets): enabled, online, capable, an update
  // available, never a containerised one. The same rule is applied here only
  // to decide whether the button has anything to do and to list the targets
  // in the confirmation; the host decides for real.
  const CONTAINER_RUNTIMES = ["docker", "containerd", "podman", "cri-o"];
  const updateTargets = (list) => list.filter((n) => n.enabled !== false && n.online
    && n.update_capable === true && n.update_available === true && !n.pinned_version
    && !CONTAINER_RUNTIMES.includes(n.container));
  const updateAll = el("button.btn.btn--sm", { type: "button" }, ["Update all"]);
  const countNode = el("span");
  updateAll.addEventListener("click", () => {
    const targets = updateTargets(store.state.nodes || []);
    if (!targets.length) return;
    const many = targets.length > 1;
    const named = targets.map((n) => n.remote_version && n.agent_version
      ? `${n.name} (v${n.agent_version} → v${n.remote_version})` : n.name);
    confirmAction({
      title: `Update ${many ? `${targets.length} agents` : targets[0].name}?`,
      message: `Updates ${named.join(", ")} and restarts ${many ? "them" : "it"}.`,
      detail: "Every agent updates at once and is offline for the few seconds its restart takes. Docker agents, "
          + "agents already up to date and offline agents are not touched. If a dependency reinstall fails on one, "
          + "that checkout is rolled back and its current process keeps running unchanged.",
      confirmLabel: many ? `Update ${targets.length}` : "Update", danger: false,
      onConfirm: async () => {
        const outcome = await api("/api/nodes/update-all", { method: "POST" });
        const results = outcome.results || [];
        const failed = results.filter((r) => !r.ok);
        const done = results.length - failed.length;
        if (!results.length) return "Nothing to update: no agent qualified by the time the host looked.";
        if (failed.length) {
          return `${done} of ${results.length} updated. Failed: ${failed.map((f) => `${f.name} (${f.error})`).join("; ")}.`;
        }
        return `${done} agent${done === 1 ? "" : "s"} updated and restarting.`;
      },
    });
  });

  function repaint() {
    if (!built) return;
    if (!loaded) {
      head.setPending(true);
      pendingSlot(figSlot, skeletonFigures(4));
      pendingSlot(tableSlot, skeletonSection("Agents", 4));
      return;
    }
    head.setPending(false);
    const list = store.state.nodes || [];
    const offline = list.filter((n) => !n.online && n.enabled !== false).length;
    readySlot(figSlot, figures([
      { label: "Enrolled", value: String(list.length) },
      { label: "Online", value: String(list.filter((n) => n.online).length), tone: "ok" },
      { label: "Offline", value: String(offline), tone: offline ? "warn" : null },
      { label: "Revoked", value: String(list.filter((n) => n.enabled === false).length) },
    ]));

    if (!list.length) {
      tableSection = null; tbody = null; rowsByName.clear();
      readySlot(tableSlot, section({
        title: "Agents",
        body: emptyState("No agents enrolled", "Generate a token above and run the deploy command on any server you want to watch."),
      }));
      return;
    }

    if (!tableSection) {
      const table = el("table.tbl");
      table.innerHTML = `<thead><tr><th>Node</th><th>Status</th><th>Host</th><th>Agent</th><th>Last report</th><th>From</th><th class="r">Actions</th></tr></thead>`;
      tbody = el("tbody");
      table.append(tbody);
      tableSection = section({
        title: "Agents",
        meta: el("span", { style: { display: "inline-flex", alignItems: "center", gap: "10px" } }, [countNode, updateAll]),
        body: el("div.tblwrap", {}, [table]),
        foot: "Revoking rejects reports instantly but leaves the remote process running; rotating a token re-enables "
            + "a revoked node. Tokens are hashed at rest — none of them can be read back, only replaced.",
      });
      readySlot(tableSlot, tableSection);
    }
    patchText(countNode, `${list.length} enrolled`);
    reconcileRows(list);
    const targets = updateTargets(list);
    show(updateAll, canOperate());
    updateAll.disabled = !targets.length;
    patchText(updateAll, targets.length ? `Update all (${targets.length})` : "Update all");
    patchAttr(updateAll, "title", targets.length
      ? `Update ${targets.map((n) => n.name).join(", ")} and restart them`
      : "No agent has an update available. Docker agents update through their image and are never included.");
  }

  function reconcileRows(list) {
    const seen = new Set();
    let previous = null;
    for (const node of list) {
      seen.add(node.name);
      let entry = rowsByName.get(node.name);
      if (!entry) {
        entry = createRow();
        rowsByName.set(node.name, entry);
      }
      updateRow(entry, node);
      const expected = previous ? previous.nextElementSibling : tbody.firstElementChild;
      if (expected !== entry.tr) {
        if (previous) previous.after(entry.tr);
        else tbody.prepend(entry.tr);
      }
      previous = entry.tr;
    }
    for (const [name, entry] of rowsByName) {
      if (!seen.has(name)) { entry.tr.remove(); rowsByName.delete(name); }
    }
  }

  /** Skeleton built once per node; updateRow() patches it in place from then
   * on. Click handlers read `entry.node`, refreshed by updateRow() on every
   * poll, never a value captured when the row was first created. */
  function createRow() {
    const nameLabel = el("span.strong");
    const dockerBadge = el("span");
    const statusCell = el("td");
    const hostCell = el("td.faint");
    const versionText = el("span.mono.faint");
    const versionBadge = el("span");

    const pinBadge = el("span");
    const lastCell = el("td");
    const addrCell = el("td.mono.faint");

    const rotate = el("button.btn.btn--sm", { type: "button" }, [""]);
    const update = el("button.btn.btn--sm", { type: "button" }, ["Update"]);
    const version = el("button.btn.btn--sm", { type: "button" }, ["Version…"]);
    const unpin = el("button.btn.btn--sm", { type: "button", title: "Let the schedule and Update all move this agent again" }, ["Unpin"]);
    const revoke = el("button.btn.btn--sm", { type: "button", title: "Reject this node's reports immediately" }, ["Revoke"]);
    const remove = el("button.btn.btn--danger.btn--sm", { type: "button", title: "Remove this node from the list entirely" }, ["Delete"]);

    const entry = {
      tr: el("tr", {}, [
        el("td", {}, [el("div.row", { style: { gap: "6px" } }, [nameLabel, dockerBadge])]),
        statusCell,
        hostCell,
        el("td", {}, [el("div.row", { style: { gap: "6px" } }, [versionText, versionBadge, pinBadge])]),
        lastCell,
        addrCell,
        el("td", {}, [el("div.actions", {}, [rotate, update, version, unpin, revoke, remove])]),
      ]),
      nameLabel, dockerBadge, statusCell, hostCell, versionText, versionBadge, lastCell, addrCell,
      rotate, update, version, unpin, revoke, remove, pinBadge, node: null, flags: {},
    };

    rotate.addEventListener("click", () => {
      const node = entry.node;
      const revoked = node.enabled === false;
      confirmAction({
        title: `${revoked ? "Re-enable" : "Rotate the token for"} ${node.name}?`,
        message: revoked
          ? `This issues a fresh token and starts accepting ${node.name}'s reports again.`
          : "The current token stops working the moment the new one is minted.",
        detail: "The running agent keeps its old token in agent.json and will log 401s until you run ./agent.sh --configure on it with the new one and restart the service.",
        confirmLabel: revoked ? "Re-enable" : "New token",
        onConfirm: async () => {
          const payload = await api(`/api/agents/${encodeURIComponent(node.name)}/token`, { method: "POST" });
          showToken(payload, revoked ? "re-enabled — new token" : "token rotated");
          return `New token issued for ${node.name}.`;
        },
      });
    });

    update.addEventListener("click", () => {
      const node = entry.node;
      const switching = node.update_branch && node.remote_branch && node.update_branch !== node.remote_branch;
      confirmAction({
        title: `Update ${node.name}?`,
        message: switching
          ? `Switches ${node.name} from the ${node.update_branch} branch to ${node.remote_branch}`
            + `${node.remote_version ? ` (v${node.remote_version})` : ""} and restarts it.`
          : node.update_available && node.remote_version
            ? `Updates ${node.name} from v${node.agent_version} to v${node.remote_version} and restarts it.`
            : `Pulls the latest commit from ${node.name}'s own git checkout and restarts it.`,
        detail: "The agent is offline for the few seconds the restart takes. If a dependency reinstall fails, "
            + "the checkout is rolled back automatically and the current process keeps running unchanged.",
        confirmLabel: "Update", danger: false,
        onConfirm: async () => {
          const outcome = await api(`/api/nodes/${encodeURIComponent(node.name)}/update`, { method: "POST" });
          return outcome && outcome.updated === false
            ? `${node.name} was already up to date.`
            : `${node.name} updated and restarting.`;
        },
      });
    });

    version.addEventListener("click", () => openVersionDialog(entry.node));

    unpin.addEventListener("click", () => {
      const node = entry.node;
      confirmAction({
        title: `Unpin ${node.name}?`,
        message: `${node.name} stays on v${node.agent_version || "?"} for now, but the daily schedule and Update all `
            + "may move it to the published version again.",
        confirmLabel: "Unpin", danger: false,
        onConfirm: async () => {
          await api(`/api/nodes/${encodeURIComponent(node.name)}/pin`, { method: "DELETE" });
          return `${node.name} unpinned.`;
        },
      });
    });

    revoke.addEventListener("click", () => {
      const node = entry.node;
      confirmAction({
        title: `Revoke ${node.name}?`,
        message: `Reports from ${node.name} are rejected the moment you confirm.`,
        detail: "The agent process keeps running on that server and will retry with 401s until you stop it or re-enable the node here. Stored history is kept.",
        confirmLabel: "Revoke",
        onConfirm: async () => {
          await api(`/api/agents/${encodeURIComponent(node.name)}/revoke`, { method: "POST" });
          return `${node.name} revoked.`;
        },
      });
    });

    remove.addEventListener("click", () => {
      const node = entry.node;
      confirmAction({
        title: `Delete ${node.name}?`,
        message: `This removes ${node.name} and invalidates its token.`,
        detail: "Its stored history stays in the database (Trends can still chart it). Enrolling the same name later starts a fresh token.",
        confirmLabel: "Delete",
        onConfirm: async () => {
          await api(`/api/agents/${encodeURIComponent(node.name)}`, { method: "DELETE" });
          return `${node.name} deleted.`;
        },
      });
    });

    return entry;
  }

  function updateRow(entry, node) {
    entry.node = node;
    const revoked = node.enabled === false;
    const isDocker = node.container === "docker" || node.container === "containerd";
    const capable = node.update_capable === true;
    const available = node.update_available === true;

    patchText(entry.nameLabel, node.name);
    if (entry.flags.docker !== isDocker) {
      entry.flags.docker = isDocker;
      entry.dockerBadge.replaceChildren(isDocker ? pill("Docker", "info") : "");
    }

    const statusKey = revoked ? "revoked" : node.online ? "online" : "offline";
    if (entry.flags.status !== statusKey) {
      entry.flags.status = statusKey;
      entry.statusCell.replaceChildren(statusKey === "revoked" ? pill("revoked", "crit")
        : statusKey === "online" ? pill("online", "ok") : pill("offline", "warn"));
    }

    patchText(entry.hostCell, node.hostname || fmt.dash);

    patchText(entry.versionText, node.agent_version ? `v${node.agent_version}` : fmt.dash);
    // Docker updates through the image, not this git-pull path — the badge
    // would just be noise with no action behind it there. An agent on
    // another branch than the configured one is "available" too: the
    // update is what moves it, so say that rather than a version number.
    const wrongBranch = !!(node.update_branch && node.remote_branch && node.update_branch !== node.remote_branch);
    const badge = isDocker ? null
      : wrongBranch ? `on ${node.update_branch} · ${node.remote_branch} configured`
      : available && node.remote_version ? `v${node.remote_version} available` : null;
    if (entry.flags.badge !== badge) {
      entry.flags.badge = badge;
      entry.versionBadge.replaceChildren(badge ? pill(badge, wrongBranch ? "warn" : "info") : "");
      patchAttr(entry.versionBadge, "title", wrongBranch
        ? `This agent's checkout is on the ${node.update_branch} branch; Update moves it to ${node.remote_branch}` : null);
    }

    const pinned = node.pinned_version || null;
    if (entry.flags.pin !== pinned) {
      entry.flags.pin = pinned;
      entry.pinBadge.replaceChildren(pinned ? pill(`pinned v${pinned}`, "warn") : "");
      patchAttr(entry.pinBadge, "title", pinned
        ? "Moved here on purpose: the schedule and Update all leave this agent alone until it is unpinned or updated" : null);
    }

    patchText(entry.lastCell, node.last_seen ? fmt.ago(node.last_seen) : "never");
    patchAttr(entry.lastCell, "title", node.last_seen ? fmt.dateTime(node.last_seen) : null);

    patchText(entry.addrCell, node.last_addr || fmt.dash);

    patchText(entry.rotate, revoked ? "Re-enable" : "New token");
    patchAttr(entry.rotate, "title", revoked
      ? "Issue a new token and re-enable this node"
      : "Issue a new token (the current one stops working immediately)");

    show(entry.rotate, canAdminister());
    show(entry.remove, canAdminister());
    show(entry.update, !revoked && canOperate());
    show(entry.version, !revoked && canOperate());
    show(entry.unpin, !revoked && canOperate() && !!pinned);
    show(entry.revoke, !revoked && canAdminister());
    entry.update.disabled = !(capable && available);
    let updateTitle;
    if (!capable) updateTitle = node.update_reason || "update capability not yet reported";
    else if (node.update_available === false) updateTitle = "already up to date";
    else if (available && node.update_branch && node.remote_branch && node.update_branch !== node.remote_branch) {
      updateTitle = `switch the agent to the ${node.remote_branch} branch, pull its latest commit, reinstall dependencies if they changed, and restart it`;
    } else if (available) updateTitle = `git-pull the agent's latest commit on ${node.remote_branch || "its branch"}, reinstall dependencies if they changed, and restart it`;
    else updateTitle = "update availability not yet known";
    patchAttr(entry.update, "title", updateTitle);

    // A version change needs a capable agent whose build takes a ref; an
    // older one is told to update first rather than sent a ref it ignores.
    const canPick = capable && node.online && node.update_refs === true && !isDocker;
    entry.version.disabled = !canPick;
    patchAttr(entry.version, "title", !node.online ? "offline"
      : isDocker ? "Docker agents change version through their image"
      : !capable ? (node.update_reason || "update capability not yet reported")
      : node.update_refs !== true ? `agent v${node.agent_version || "?"} predates version selection — update it first`
      : "Move this agent to any published version, older ones included, and pin it there");
  }

  /** The picker: every version the agent repository has shipped, from the
   * host's mirror (the same list Patch notes shows), newest first. */
  async function openVersionDialog(node) {
    const result = el("div.result");
    const cancel = el("button.btn", { type: "button", dataset: { role: "cancel" } }, ["Cancel"]);
    const confirm = el("button.btn.btn--primary", { type: "button", dataset: { role: "confirm" }, disabled: true }, ["Change version"]);
    const footer = el("div", { style: { display: "contents" } }, [result, el("span.spacer"), cancel, confirm]);
    // The picker's list opens below its button inside the modal's scroll
    // area, so the slot reserves the room the open list takes (search row
    // plus the list's max height); otherwise the modal body clips it to a
    // couple of rows.
    const pickSlot = el("div", { style: { margin: "10px 0", minHeight: "350px" } });
    const body = el("div", {}, [
      el("p", { text: `${node.name} runs v${node.agent_version || "?"}${node.update_branch ? ` on ${node.update_branch}` : ""}. `
          + `Pick the version to move it to, from the ${node.remote_branch || "configured"} branch; the agent resets its `
          + "checkout to the commit that shipped that version, reinstalls dependencies if they changed, and restarts." }),
      pickSlot,
      note("warn", "Any version other than the published one pins the agent there: the daily schedule and Update all "
          + "leave it alone until you unpin it or update it again. An older agent may lack features this host relies on.",
        { margin: true }),
    ]);
    const modal = openModal({ title: `Change ${node.name}'s version`, body, footer, dismissible: false, initialFocus: "cancel" });
    cancel.addEventListener("click", () => modal.close());
    pickSlot.append(el("div.faint.small", { text: "Loading versions…" }));
    let chosen = null;
    try {
      const notes = await api("/api/changelog?repo=agent");
      if (!notes.available) throw new Error(notes.reason || "the agent repository could not be read");
      const seen = new Map();
      for (const commit of notes.commits || []) {
        if (!commit.version || seen.has(commit.version)) continue;
        seen.set(commit.version, commit.ts);
      }
      const options = [...seen].map(([version, ts]) => {
        const marks = [];
        if (version === node.remote_version) marks.push("latest");
        if (version === node.agent_version) marks.push("current");
        return { value: version, label: `v${version} · ${ts ? fmt.dayTime(ts) : ""}${marks.length ? ` · ${marks.join(", ")}` : ""}` };
      });
      if (!options.length) throw new Error("the mirror lists no versions");
      const picker = combobox({
        label: "Version", options, value: node.agent_version && seen.has(node.agent_version) ? node.agent_version : null,
        allLabel: node.agent_version && seen.has(node.agent_version) ? null : "Choose…", ariaLabel: "Version to install",
        onChange: (value) => {
          chosen = value;
          confirm.disabled = !chosen || chosen === node.agent_version;
          patchText(confirm, chosen && chosen !== node.remote_version ? "Change and pin" : "Change version");
        },
      });
      pickSlot.replaceChildren(picker);
    } catch (error) {
      pickSlot.replaceChildren();
      inlineResult(result, error.message, "error");
      return;
    }
    confirm.addEventListener("click", async () => {
      if (!chosen) return;
      setBusy(confirm, true, "Change version");
      result.replaceChildren();
      try {
        const outcome = await api(`/api/nodes/${encodeURIComponent(node.name)}/version`, {
          method: "POST", body: JSON.stringify({ version: chosen }),
        });
        inlineResult(result, `${node.name} moved to v${outcome.version}${outcome.pinned ? " and pinned there" : ""}; restarting.`, "ok");
        setTimeout(() => modal.close(), 900);
      } catch (error) {
        inlineResult(result, error.message, "error");
        setBusy(confirm, false, "Change version");
      }
    });
  }

  function buildHelp() {
    render(helpSlot, section({
      title: "How agents connect",
      body: kvs([
        kv("Direction", "outbound only — the agent POSTs to this host; nothing listens on the monitored server"),
        kv("Cadence", "1s by default, delta-compressed and gzipped; the top bar Refresh control retunes the selected node live"),
        kv("Auth", "per-node bearer token, SHA-256-hashed at rest, constant-time checked, revocable here"),
        kv("Transport", "use https:// in the deploy command when crossing an untrusted network (self-signed: add --insecure)"),
        kv("Commands", "full parity — process detail, End task, renice and port kills are queued here and run on the agent's next report (~1s), same guards as the host"),
        kv("Updates", "git-pull + restart, native installs only — the Update button is disabled with a reason for Docker nodes, dirty checkouts, or agents not running under systemd, and stays disabled while a node is already up to date; a schedule can also apply these automatically, see Settings"),
        kv("Versions", "Version… moves an agent to any version the agent repository has shipped, older ones included: the host resolves it to the commit that shipped it and the agent resets to that commit. Anything but the published version pins the node, so the schedule and Update all leave it alone until it is unpinned or updated again"),
        kv("Branch", "Settings › Automatic agent updates names the branch of the agent repository agents follow (main by default). Every update moves an agent to that branch; one on another branch shows it here and counts as having an update. The repository is never chosen from here — an agent only pulls from its own origin"),
      ], { wide: true }),
    }));
  }

  root.mount = () => {
    if (!built) {
      built = true;
      buildEnroll();
      buildHelp();
    }
    repaint();
    api("/api/nodes").then((payload) => {
      store.state.nodes = payload.nodes || [];
      loaded = true;
      repaint();
    }).catch(() => { loaded = true; repaint(); });
  };
  root.subscriptions = [store.on("nodes", () => { if (root.isActive) repaint(); })];
  return root;
}

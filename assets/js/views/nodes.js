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

import { el, render } from "../util/dom.js";
import * as fmt from "../util/format.js";
import { api, store } from "../stream.js";
import {
  confirmAction, emptyState, inlineResult, note, pendingSlot, readySlot, setBusy, skeletonFigures, skeletonSection,
} from "../ui.js";
import { codeRow, figures, kv, kvs, pill, section, subhead, viewHead } from "./shared.js";

export function createNodes() {
  const root = el("div.view", { dataset: { view: "nodes" } });
  let built = false;

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
      readySlot(tableSlot, section({
        title: "Agents",
        body: emptyState("No agents enrolled", "Generate a token above and run the deploy command on any server you want to watch."),
      }));
      return;
    }

    const table = el("table.tbl");
    table.innerHTML = `<thead><tr><th>Node</th><th>Status</th><th>Host</th><th>Agent</th><th>Last report</th><th>From</th><th class="r">Actions</th></tr></thead>`;
    const tbody = el("tbody");
    for (const node of list) {
      const revoked = node.enabled === false;
      const status = revoked ? pill("revoked", "crit") : node.online ? pill("online", "ok") : pill("offline", "warn");
      const isDocker = node.container === "docker" || node.container === "containerd";
      const actions = el("div.actions");

      const rotate = el("button.btn.btn--sm", {
        type: "button",
        title: revoked ? "Issue a new token and re-enable this node" : "Issue a new token (the current one stops working immediately)",
      }, [revoked ? "Re-enable" : "New token"]);
      rotate.addEventListener("click", () => confirmAction({
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
      }));
      actions.append(rotate);

      if (!revoked) {
        const revoke = el("button.btn.btn--sm", { type: "button", title: "Reject this node's reports immediately" }, ["Revoke"]);
        revoke.addEventListener("click", () => confirmAction({
          title: `Revoke ${node.name}?`,
          message: `Reports from ${node.name} are rejected the moment you confirm.`,
          detail: "The agent process keeps running on that server and will retry with 401s until you stop it or re-enable the node here. Stored history is kept.",
          confirmLabel: "Revoke",
          onConfirm: async () => {
            await api(`/api/agents/${encodeURIComponent(node.name)}/revoke`, { method: "POST" });
            return `${node.name} revoked.`;
          },
        }));
        actions.append(revoke);
      }

      const remove = el("button.btn.btn--danger.btn--sm", { type: "button", title: "Remove this node from the list entirely" }, ["Delete"]);
      remove.addEventListener("click", () => confirmAction({
        title: `Delete ${node.name}?`,
        message: `This removes ${node.name} and invalidates its token.`,
        detail: "Its stored history stays in the database (Trends can still chart it). Enrolling the same name later starts a fresh token.",
        confirmLabel: "Delete",
        onConfirm: async () => {
          await api(`/api/agents/${encodeURIComponent(node.name)}`, { method: "DELETE" });
          return `${node.name} deleted.`;
        },
      }));
      actions.append(remove);

      tbody.append(el("tr", {}, [
        el("td", {}, [el("div.row", { style: { gap: "6px" } }, [el("span.strong", { text: node.name }), isDocker ? pill("Docker", "info") : null])]),
        el("td", {}, [status]),
        el("td.faint", { text: node.hostname || fmt.dash }),
        el("td.mono.faint", { text: node.agent_version ? `v${node.agent_version}` : fmt.dash }),
        el("td", { text: node.last_seen ? fmt.ago(node.last_seen) : "never", title: node.last_seen ? fmt.dateTime(node.last_seen) : "" }),
        el("td.mono.faint", { text: node.last_addr || fmt.dash }),
        el("td", {}, [actions]),
      ]));
    }
    table.append(tbody);
    readySlot(tableSlot, section({
      title: "Agents", meta: `${list.length} enrolled`,
      body: el("div.tblwrap", {}, [table]),
      foot: "Revoking rejects reports instantly but leaves the remote process running; rotating a token re-enables "
          + "a revoked node. Tokens are hashed at rest — none of them can be read back, only replaced.",
    }));
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

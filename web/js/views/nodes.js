/**
 * Nodes: enroll agents and manage their tokens, entirely from the dashboard.
 *
 * The one hard rule in this view is the honesty of secrets: a token exists in
 * plaintext exactly once — in the response that minted it, rendered in the
 * reveal panel below — and can never be shown again, because the server only
 * keeps its hash. Everything here says so instead of pretending a "show
 * token" button could exist.
 *
 * Enrollment and rotation return a paste-ready deploy command, because the
 * usual failure of these flows is a token copied without its context.
 */

import { el, render } from "../util/dom.js";
import * as fmt from "../util/format.js";
import { api, store } from "../stream.js";
import {
  confirmAction, copyButton, emptyState, icons, inlineResult, setBusy,
  skeletonRows,
} from "../ui.js";
import { kv, panel, statTile, tag } from "./shared.js";

export function createNodes() {
  const root = el("div.view", { dataset: { view: "nodes" } });
  let built = false;

  root.append(el("div.viewhead", {}, [
    el("div.viewhead__titles", {}, [
      el("div.viewhead__title", { text: "Nodes" }),
      el("div.viewhead__sub", {
        text: "Enroll agents on other servers and manage their tokens. "
            + "Agents are outbound-only — they open no port — yet act with "
            + "full parity: process detail, End task, renice and port kills "
            + "are relayed to them and run locally.",
      }),
    ]),
  ]));

  const statsRow = el("div.grid.grid--stats", { style: { marginBottom: "12px" } });
  root.append(statsRow);

  const revealSlot = el("div", { style: { marginBottom: "12px" } });
  root.append(revealSlot);

  const enrollSlot = el("div", { style: { marginBottom: "12px" } });
  root.append(enrollSlot);

  const tableSlot = el("div");
  root.append(tableSlot);

  const helpSlot = el("div", { style: { marginTop: "12px" } });
  root.append(helpSlot);

  /* ── Enroll form ─────────────────────────────────────────────────────── */
  function buildEnroll() {
    const input = el("input", {
      type: "text", placeholder: "node name, e.g. web-01",
      autocomplete: "off", spellcheck: "false", maxLength: "48",
      "aria-label": "New node name",
    });
    const button = el("button.btn.btn--primary", { type: "button" },
      ["Generate token"]);
    const result = el("div.inline-result");

    async function enroll() {
      const name = input.value.trim();
      if (!name) {
        inlineResult(result, "Give the node a name first.", "error");
        input.focus();
        return;
      }
      setBusy(button, true, "Generating…");
      try {
        const payload = await api("/api/agents", {
          method: "POST", body: JSON.stringify({ name }),
        });
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
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") enroll();
    });

    render(enrollSlot, panel({
      title: "Enroll a new agent",
      body: el("div", {}, [
        el("div", {
          style: { display: "flex", gap: "8px", flexWrap: "wrap" },
        }, [
          el("div.field", { style: { flex: "1 1 220px" } }, [input]),
          button,
        ]),
        result,
      ]),
      foot: el("span", {
        text: "Names may use letters, digits, '-' and '_'. The token is "
            + "generated server-side and stored only as a hash.",
      }),
    }));
  }

  /* ── Token reveal (the only time a token is visible) ─────────────────── */
  function showToken(payload, verb) {
    const body = el("div", {}, [
      el("div.hint.hint--warn", {
        html: `${icons.warn}<div><strong>Copy this now.</strong> The token is
          shown only this once — the server keeps a hash, not the token, so
          it cannot be displayed again. Losing it means rotating it.</div>`,
      }),
      el("div.subhead", { text: "Token" }),
      el("div", { style: { display: "flex", gap: "8px", alignItems: "center" } }, [
        el("code.mono", {
          style: {
            flex: "1 1 auto", padding: "8px 10px", fontSize: "12px",
            background: "var(--bg-sunken)", borderRadius: "6px",
            overflowWrap: "anywhere", userSelect: "all",
          },
          text: payload.token,
        }),
        copyButton(payload.token, "Copy token"),
      ]),
      el("div.subhead", { text: "Run on the target server" }),
      el("div", { style: { display: "flex", gap: "8px", alignItems: "center" } }, [
        el("code.mono", {
          style: {
            flex: "1 1 auto", padding: "8px 10px", fontSize: "12px",
            background: "var(--bg-sunken)", borderRadius: "6px",
            overflowWrap: "anywhere", userSelect: "all",
          },
          text: payload.deploy_command,
        }),
        copyButton(payload.deploy_command, "Copy command"),
      ]),
      el("div.faint", {
        style: { fontSize: "11px", marginTop: "8px", lineHeight: "1.5" },
        text: "Copy the culprit-agent/ folder to that server and run the "
            + "command inside it. It saves the config to agent.json; install "
            + "culprit-agent.service afterwards to keep it running. Adjust the "
            + "URL if agents reach this host by a different address.",
      }),
    ]);

    const dismiss = el("button.btn.btn--sm", { type: "button" }, ["Dismiss"]);
    dismiss.addEventListener("click", () => revealSlot.replaceChildren());

    render(revealSlot, panel({
      title: `Agent '${payload.name}' ${verb}`,
      icon: icons.ok,
      meta: dismiss,
      body,
      cls: "panel--warn",
    }));
    revealSlot.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  /* ── Agent table ─────────────────────────────────────────────────────── */
  function repaint() {
    if (!built) return;
    const list = store.state.nodes || [];

    render(statsRow, [
      statTile({ label: "Enrolled", value: String(list.length) }),
      statTile({
        label: "Online",
        value: String(list.filter((n) => n.online).length),
        state: "ok",
      }),
      statTile({
        label: "Offline",
        value: String(list.filter((n) => !n.online && n.enabled !== false).length),
        state: list.some((n) => !n.online && n.enabled !== false) ? "warn" : null,
      }),
      statTile({
        label: "Revoked",
        value: String(list.filter((n) => n.enabled === false).length),
      }),
    ]);

    if (!list.length) {
      render(tableSlot, panel({
        title: "Agents",
        body: emptyState("No agents enrolled",
          "Generate a token above and run the deploy command on any server "
          + "you want to watch."),
      }));
      return;
    }

    const table = el("table.table");
    table.innerHTML = `<thead><tr>
      <th>Node</th><th>Status</th><th>Host</th><th>Agent</th>
      <th>Last report</th><th>From</th><th class="r">Actions</th>
    </tr></thead>`;
    const tbody = el("tbody");

    for (const node of list) {
      const revoked = node.enabled === false;
      const status = revoked ? tag("revoked", "crit")
        : node.online ? tag("online", "ok")
        : tag("offline", "warn");

      const actions = el("div", {
        style: { display: "flex", gap: "5px", justifyContent: "flex-end" },
      });
      const rotate = el("button.btn.btn--sm", {
        type: "button",
        title: revoked ? "Issue a new token and re-enable this node"
          : "Issue a new token (the current one stops working immediately)",
      }, [revoked ? "Re-enable" : "New token"]);
      rotate.addEventListener("click", () => confirmAction({
        title: `${revoked ? "Re-enable" : "Rotate the token for"} ${node.name}?`,
        message: revoked
          ? `This issues a fresh token and starts accepting ${node.name}'s reports again.`
          : `The current token stops working the moment the new one is minted.`,
        detail: "The running agent keeps its old token in agent.json and will "
          + "log 401s until you rerun agent.sh with the new one.",
        confirmLabel: revoked ? "Re-enable" : "New token",
        onConfirm: async () => {
          const payload = await api(
            `/api/agents/${encodeURIComponent(node.name)}/token`,
            { method: "POST" });
          showToken(payload, revoked ? "re-enabled — new token" : "token rotated");
          return `New token issued for ${node.name}.`;
        },
      }));
      actions.append(rotate);

      if (!revoked) {
        const revoke = el("button.btn.btn--sm", {
          type: "button", title: "Reject this node's reports immediately",
        }, ["Revoke"]);
        revoke.addEventListener("click", () => confirmAction({
          title: `Revoke ${node.name}?`,
          message: `Reports from ${node.name} are rejected the moment you confirm.`,
          detail: "The agent process keeps running on that server and will "
            + "retry with 401s until you stop it or re-enable the node here. "
            + "Stored history is kept.",
          confirmLabel: "Revoke",
          onConfirm: async () => {
            await api(`/api/agents/${encodeURIComponent(node.name)}/revoke`,
              { method: "POST" });
            return `${node.name} revoked.`;
          },
        }));
        actions.append(revoke);
      }

      const remove = el("button.btn.btn--danger.btn--sm", {
        type: "button", title: "Remove this node from the list entirely",
      }, ["Delete"]);
      remove.addEventListener("click", () => confirmAction({
        title: `Delete ${node.name}?`,
        message: `This removes ${node.name} and invalidates its token.`,
        detail: "Its stored history stays in the database (Trends can still "
          + "chart it). Enrolling the same name later starts a fresh token.",
        confirmLabel: "Delete",
        onConfirm: async () => {
          await api(`/api/agents/${encodeURIComponent(node.name)}`,
            { method: "DELETE" });
          return `${node.name} deleted.`;
        },
      }));
      actions.append(remove);

      tbody.append(el("tr", {}, [
        el("td", {}, [el("div.strong", { text: node.name })]),
        el("td", {}, [status]),
        el("td.faint", { text: node.hostname || fmt.dash }),
        el("td.mono.faint", {
          text: node.agent_version ? `v${node.agent_version}` : fmt.dash,
        }),
        el("td", {
          text: node.last_seen ? fmt.ago(node.last_seen) : "never",
          title: node.last_seen ? fmt.dateTime(node.last_seen) : "",
        }),
        el("td.mono.faint", { text: node.last_addr || fmt.dash }),
        el("td", {}, [actions]),
      ]));
    }
    table.append(tbody);

    render(tableSlot, panel({
      title: "Agents",
      meta: el("span", { text: `${list.length} enrolled` }),
      body: el("div.tablewrap", {}, [table]),
      flush: true,
      foot: el("span", {
        text: "Revoking rejects reports instantly but leaves the remote "
            + "process running; rotating a token re-enables a revoked node. "
            + "Tokens are hashed at rest — none of them can be read back, "
            + "only replaced.",
      }),
    }));
  }

  function buildHelp() {
    render(helpSlot, panel({
      title: "How agents connect",
      body: el("div.kvlist", {}, [
        kv("Direction", "outbound only — the agent POSTs to this host; "
          + "nothing listens on the monitored server"),
        kv("Cadence", "1s by default, delta-compressed and gzipped; the "
          + "titlebar Refresh control retunes the selected node live"),
        kv("Auth", "per-node bearer token, SHA-256-hashed at rest, "
          + "constant-time checked, revocable here"),
        kv("Transport", "use https:// in the deploy command when crossing "
          + "an untrusted network (self-signed: add --insecure)"),
        kv("Commands", "full parity — process detail, End task, renice and "
          + "port kills are queued here and run on the agent's next report "
          + "(~1s), same guards as the host; agents still open no port"),
      ]),
    }));
  }

  root.mount = () => {
    if (!built) {
      built = true;
      buildEnroll();
      buildHelp();
    }
    // The SSE nodes frames keep this fresh, but a mount deserves live truth.
    api("/api/nodes").then((payload) => {
      store.state.nodes = payload.nodes || [];
      repaint();
    }).catch(() => repaint());
  };
  root.showSkeleton = () => {
    render(tableSlot, panel({ title: "Agents", body: skeletonRows(4) }));
  };
  root.subscriptions = [
    store.on("nodes", () => { if (root.isActive) repaint(); }),
  ];
  return root;
}

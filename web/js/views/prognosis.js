/**
 * The Prognosis: what is wearing out.
 *
 * The other doctors read software. This one reads the layer under the kernel
 * — a disk's own SMART attributes, an SSD's endurance estimate, the memory
 * controller's ECC counts, the PCIe link's error counters, the SATA link's
 * negotiated speed, a battery's design capacity — and says which part is on
 * its way out and how far along it is.
 *
 * Three things shape this page. Every number is quoted with the id the
 * hardware knows it by, so an operator can check the sentence against
 * `smartctl -a`. Every source that could not be read is named in the checks
 * strip rather than rendered as fine — a page with no items and no strip
 * would read as "your disks are healthy", which is the one thing this view
 * must never say without having looked. And there are no verbs: nothing here
 * is fixed by restarting something, so the page offers a fix in words and a
 * command to confirm it, never a button.
 *
 * The wear chart is the only part that fetches: the section itself rides the
 * events tier (two minutes), and the daily history behind the forecast comes
 * from /api/wear on demand.
 */

import { el, on, patchAttr, patchText, render } from "../util/dom.js";
import * as fmt from "../util/format.js";
import { createChart } from "../charts.js";
import { api, store } from "../stream.js";
import {
  combobox, emptyState, expandable, icons, note, pendingSlot, readySlot,
  skeletonFacts, skeletonFigures, skeletonSection, skeletonStatus,
} from "../ui.js";
import {
  changeList, codeRow, figures, kv, kvs, meter, pill, section, viewHead,
} from "./shared.js";

const TONE = { critical: "crit", warn: "warn", info: "info", ok: "ok" };
const KIND_WORD = {
  disk: "disk", link: "SATA link", nic: "interface", memory: "memory",
  pci: "PCIe", power: "battery",
};
// What a wear chart draws, per counter, in the order they are offered.
const SERIES = [
  { key: "percentage_used", label: "Endurance used", token: "--m-queue", unit: "%" },
  { key: "197", label: "Pending sectors (197)", token: "--crit", unit: "" },
  { key: "5", label: "Reallocated sectors (5)", token: "--m-disk", unit: "" },
  { key: "media_errors", label: "Media errors", token: "--crit", unit: "" },
  { key: "199", label: "Interface CRC errors (199)", token: "--m-up", unit: "" },
  { key: "ce_count", label: "Corrected ECC errors", token: "--m-mem", unit: "" },
  { key: "correctable", label: "Corrected PCIe errors", token: "--m-cpu", unit: "" },
  { key: "health_pct", label: "Battery health", token: "--m-gpu", unit: "%" },
];
// Temperature and power-on hours are kept in the record and shown in the
// device table, but they are deliberately not drawn here: one climbs forever
// and the other swings every day, and either would flatten the counters this
// chart exists to show into a line along the bottom.

export function createPrognosis() {
  const root = el("div.view", { dataset: { view: "prognosis" } });
  const nodes = {};
  let built = false;
  let chart = null;
  let picked = null;          // {kind, subject}
  let subjects = [];
  let series = null;          // the /api/wear answer for `picked`

  const head = viewHead({
    title: "The Prognosis",
    lead: "What is wearing out, read from the hardware's own counters — never a self-test, never a "
        + "wake-up, and never a vendor attribute this tool would have to guess the meaning of.",
  });
  root.append(head);
  const stack = el("div.stack");
  root.append(stack);
  const content = el("div.stack");
  const skeleton = () => el("div.stack", {}, [
    skeletonStatus(), skeletonFigures(4), skeletonSection("Wearing out", 2),
    skeletonSection("Devices", 4),
    el("div.sec", {}, [el("div.sec__head", {}, [el("div.sec__title", { text: "Checks" })]),
      skeletonFacts(6)]),
  ]);

  function build() {
    built = true;
    nodes.status = el("div.status", { dataset: { severity: "ok" } });
    nodes.statusWord = el("div.status__word");
    nodes.statusLine = el("div.status__line");
    nodes.status.append(el("div.status__text", {}, [nodes.statusWord, nodes.statusLine]));
    nodes.guest = el("div");
    nodes.figures = el("div");
    nodes.items = el("div");
    nodes.itemsMeta = el("span");
    nodes.devices = el("div");
    nodes.devicesMeta = el("span");
    nodes.picker = el("div");
    nodes.chartCanvas = el("canvas");
    nodes.chartTip = el("div.tip", { hidden: true });
    nodes.chartBox = el("div.chart", {}, [nodes.chartCanvas, nodes.chartTip]);
    on(nodes.chartBox, "mousemove", showChartTip);
    on(nodes.chartBox, "mouseleave", () => { nodes.chartTip.hidden = true; });
    nodes.chartLegend = el("div");
    nodes.chartMeta = el("span");
    nodes.chartNote = el("div");
    nodes.checks = el("div.facts");
    nodes.checksMeta = el("span");

    content.append(
      nodes.status,
      nodes.guest,
      nodes.figures,
      section({
        title: "Wearing out", meta: nodes.itemsMeta, body: nodes.items,
        foot: "A counter that moved since the last read is the finding. A counter that is not zero and "
            + "has not moved is a warning that says since when. A zero is a fact, not a bill of health.",
      }),
      section({
        title: "Devices", meta: nodes.devicesMeta, body: nodes.devices,
        foot: "Identity comes from the kernel; health comes from the device itself. A sleeping disk is "
            + "shown as asleep with the values from its last read — reading it would have spun it up.",
      }),
      section({
        title: "Wear over time", meta: nodes.chartMeta,
        body: el("div", {}, [nodes.picker, nodes.chartBox, nodes.chartLegend, nodes.chartNote]),
        foot: "One row per device per day, kept for over a year. The dashed line is the fit behind a "
            + "forecast, and it is only drawn when there are at least fourteen days behind it.",
      }),
      section({
        title: "Checks", meta: nodes.checksMeta, body: nodes.checks,
        foot: "Each source reports its own availability. A source that could not be read is named here "
            + "rather than rendered as fine, and every reason names the exact thing that would unlock it.",
      }),
    );
    pendingSlot(stack, skeleton());
  }

  /* ── Render ──────────────────────────────────────────────────────── */
  function update(state) {
    if (!built) return;
    const payload = state.prognosis;
    if (!payload) {
      head.setPending(true);
      pendingSlot(stack, skeleton());
      return;
    }
    head.setPending(false);
    readySlot(stack, content);
    if (payload.available === false) {
      patchAttr(nodes.status, "data-severity", "info");
      patchText(nodes.statusWord, "Not available");
      patchText(nodes.statusLine, payload.reason || "");
      render(nodes.items, emptyState("Not available", payload.reason || ""));
      render(nodes.devices, []);
      render(nodes.checks, []);
      render(nodes.guest, []);
      return;
    }
    const items = payload.items || [];
    const failing = items.filter((i) => i.severity === "critical");
    const wearing = items.filter((i) => i.severity === "warn");
    renderStatus(payload, failing, wearing);
    renderGuest(payload.checks || {});
    renderFigures(payload);

    patchText(nodes.itemsMeta, items.length
      ? `${failing.length} failing · ${wearing.length} wearing`
      + (items.length > failing.length + wearing.length
        ? ` · ${items.length - failing.length - wearing.length} for information` : "")
      : "none");
    if (!items.length) {
      render(nodes.items, emptyState(
        payload.status === "unknown"
          ? "Nothing has been read yet"
          : "Nothing is wearing out that this machine can see",
        payload.status === "unknown"
          ? "No disk answered a SMART query, no ECC controller is registered and no battery is exposed. "
          + "The checks below say why for each one."
          : "Every counter the hardware keeps is at zero or has not moved. That is a reading, not an "
          + "assurance — the checks below say what was actually looked at.",
        icons.ok));
    } else {
      render(nodes.items, items.map(itemCard));
    }
    renderDevices(payload);
    renderChecks(payload.checks || {});
    syncPicker(payload);
  }

  function renderStatus(payload, failing, wearing) {
    const severity = failing.length ? "critical" : wearing.length ? "warn"
      : payload.status === "unknown" ? "info" : "ok";
    patchAttr(nodes.status, "data-severity", severity);
    patchText(nodes.statusWord,
      failing.length ? `${failing.length} part${failing.length === 1 ? " is" : "s are"} failing`
        : wearing.length ? `${wearing.length} part${wearing.length === 1 ? " is" : "s are"} wearing`
          : payload.status === "unknown" ? "Nothing readable here"
            : "Nothing is wearing out");
    patchText(nodes.statusLine,
      failing.length || wearing.length
        ? [...failing, ...wearing].slice(0, 3).map((i) => i.title).join(" · ")
        : payload.status === "unknown"
          ? "No hardware counter on this machine could be read; the checks below name each reason."
          : "Every disk, controller and link that could be read is within its own limits.");
  }

  function renderGuest(checks) {
    const guest = checks.guest || {};
    if (!guest.note) { render(nodes.guest, []); return; }
    render(nodes.guest, [note("info", el("span", { text: guest.note }), { margin: true })]);
  }

  function renderFigures(payload) {
    const smart = (payload.checks || {}).smart || {};
    const devices = payload.devices || [];
    const oldest = devices.map((d) => (d.smart || {}).power_on_hours)
      .filter((h) => fmt.isNum(h) && h > 0).sort((a, b) => b - a)[0];
    const worn = devices.map((d) => ((d.smart || {}).nvme || {}).percentage_used)
      .filter((v) => fmt.isNum(v)).sort((a, b) => b - a)[0];
    const items = payload.items || [];
    render(nodes.figures, [figures([
      { label: "Disks read", value: `${fmt.count(smart.read)} of ${fmt.count(smart.devices)}`,
        hint: smart.asleep ? `${smart.asleep} asleep, left asleep` : null,
        tone: smart.devices && !smart.read ? "warn" : null },
      { label: "Wearing out", value: fmt.count(items.filter(
        (i) => i.severity === "warn" || i.severity === "critical").length),
      hint: items.length ? `${items.length} item${items.length === 1 ? "" : "s"} in all` : "none",
      tone: items.some((i) => i.severity === "critical") ? "crit"
        : items.some((i) => i.severity === "warn") ? "warn" : "ok" },
      { label: "Oldest disk", value: fmt.isNum(oldest) ? `${(oldest / 8760).toFixed(1)} y` : fmt.dash,
        hint: fmt.isNum(oldest) ? `${fmt.count(oldest)} hours powered on` : "no power-on hours read" },
      { label: "Most worn SSD", value: fmt.isNum(worn) ? `${worn} %` : fmt.dash,
        hint: fmt.isNum(worn) ? "of its rated endurance" : "no endurance estimate read",
        tone: fmt.isNum(worn) ? (worn >= 100 ? "crit" : worn >= 90 ? "warn" : worn >= 70 ? "info" : "ok") : null },
    ])]);
  }

  function itemCard(item) {
    const node = el("div.finding", { dataset: { severity: item.severity } });
    const held = item.since_start ? "present since the agent started"
      : fmt.isNum(item.since)
        ? `since ${fmt.clock(item.since)} · ${fmt.shortDuration(Math.max(0, Date.now() / 1000 - item.since))}`
        : "just now";
    const device = item.device || {};
    const meta = el("div.finding__meta", {}, [
      pill(KIND_WORD[item.kind] || item.kind || "?"),
      device.serial ? pill(device.serial, "info", { mono: true }) : null,
      item.raid && item.raid.array ? pill(`${item.raid.array} member`, "info", { mono: true }) : null,
      fmt.isNum(item.rising_since) ? pill("rising", "crit") : null,
      pill(held, TONE[item.severity] || null),
    ]);
    node.append(el("div.finding__head", {}, [
      el("div.finding__title", { text: item.title }), meta]));
    node.append(el("div.finding__text", { text: item.detail || "" }));

    const evidence = (item.evidence || []).filter((e) => e && e.value !== null && e.value !== undefined);
    if (evidence.length) {
      node.append(el("div.finding__evidence.pills", {}, evidence.map(
        (entry) => pill(`${entry.label}: ${entry.value}`, null, { mono: true }))));
    }
    if (item.device && (item.device.model || item.device.name)) {
      node.append(el("div.finding__culprits", {}, [
        el("span.label", { text: "The part" }),
        kvs([
          kv("Device", el("span.mono", { text: device.name || fmt.dash })),
          kv("Model", device.model || fmt.dash),
          kv("Serial", el("span.mono", { text: device.serial || fmt.dash })),
          fmt.isNum(device.size) ? kv("Size", fmt.bytes(device.size)) : null,
          device.transport ? kv("Bus", device.transport) : null,
          device.firmware ? kv("Firmware", el("span.mono", { text: device.firmware })) : null,
        ].filter(Boolean)),
      ]));
    }
    if (item.forecast && item.forecast.reaches_at) {
      node.append(el("div.finding__culprits", {}, [
        el("span.label", {}, [
          document.createTextNode("Forecast "),
          el("span.faint", { text: `— fitted over ${item.forecast.fitted_days} days` }),
        ]),
        el("div.faint.small", { text:
          `${rate(item.forecast.per_day)} % a day · reaches ${item.forecast.target} % around `
          + onDay(item.forecast.reaches_at) }),
      ]));
    }
    if (item.fix) {
      node.append(el("div.finding__culprits", {}, [
        el("span.label", { text: "What to do" }),
        el("div.finding__text", { text: item.fix }),
        item.device && item.device.name
          ? codeRow(`smartctl -a /dev/${item.device.name}`, "Copy") : null,
      ].filter(Boolean)));
    }
    const changes = item.changes || [];
    if (changes.length) {
      node.append(el("div.finding__culprits", {}, [
        el("span.label", {}, [
          document.createTextNode("What changed just before "),
          el("span.faint", { text: "— coincides with, not proof of cause" }),
        ]),
        changeList(changes),
      ]));
    }
    return node;
  }

  /* ── Devices ─────────────────────────────────────────────────────── */
  function renderDevices(payload) {
    const blocks = [];
    const disks = payload.devices || [];
    if (disks.length) blocks.push(diskTable(disks));
    const links = (payload.links || []).filter((l) => l.disk || l.speed);
    if (links.length) blocks.push(linkTable(links));
    if ((payload.nics || []).length) blocks.push(nicTable(payload.nics));
    const controllers = (payload.memory || {}).controllers || [];
    if (controllers.length) blocks.push(memoryTable(controllers));
    const pci = (payload.pci || []).filter((d) => d.correctable || d.nonfatal || d.fatal);
    if (pci.length) blocks.push(pciTable(pci));
    if ((payload.power || []).length) blocks.push(powerTable(payload.power));
    patchText(nodes.devicesMeta,
      `${fmt.count(disks.length)} disk${disks.length === 1 ? "" : "s"}`
      + (controllers.length ? ` · ${controllers.length} memory controller${controllers.length === 1 ? "" : "s"}` : "")
      + ((payload.power || []).length ? ` · ${payload.power.length} battery` : ""));
    if (!blocks.length) {
      render(nodes.devices, emptyState("No devices with counters",
        "No whole disk, memory controller, PCIe device or battery on this machine exposes the counters "
        + "this page reads."));
      return;
    }
    render(nodes.devices, blocks);
  }

  function tableOf(title, headings, rows) {
    const table = el("table.tbl.tbl--tight");
    const head = el("thead");
    head.append(el("tr", {}, headings.map(
      (h) => el(h.right ? "th.r" : "th", { text: h.label }))));
    table.append(head, el("tbody", {}, rows));
    return el("div", { style: { marginBottom: "14px" } }, [
      el("div.label", { style: { marginBottom: "6px" }, text: title }),
      el("div.tblwrap", {}, [table]),
    ]);
  }

  function diskTable(disks) {
    const rows = disks.map((device) => {
      const smart = device.smart || {};
      const nvme = smart.nvme || {};
      const used = nvme.percentage_used;
      const health = device.virtual ? pill("virtual", "info")
        : smart.asleep ? pill("asleep", "info")
          : smart.read === false ? pill("not read", "warn")
            : smart.passed === false ? pill("FAILING", "crit")
              : smart.passed === true ? pill("PASSED", "ok") : pill("read", null);
      return el("tr", {}, [
        el("td.mono", { text: device.name || fmt.dash }),
        el("td", { text: device.model || fmt.dash, title: device.serial || "" }),
        el("td", {}, [health]),
        el("td", {}, fmt.isNum(used) ? [barCell(used,
          used >= 100 ? "crit" : used >= 90 ? "warn" : used >= 70 ? "info" : "ok",
          `${used} %`, `${used} % of rated endurance`)]
          : [el("span.faint", { text: fmt.dash })]),
        el("td.n", { text: fmt.isNum(smart.temperature_c) ? `${smart.temperature_c} °C` : fmt.dash }),
        el("td.n", { text: fmt.isNum(smart.power_on_hours)
          ? `${(smart.power_on_hours / 8760).toFixed(1)} y` : fmt.dash,
        title: fmt.isNum(smart.power_on_hours) ? `${smart.power_on_hours} hours` : "" }),
        el("td.faint.small", { text: reasonOf(device) }),
      ]);
    });
    const block = tableOf("Disks", [
      { label: "Device" }, { label: "Model" }, { label: "Health" }, { label: "Endurance" },
      { label: "Temp", right: true }, { label: "Powered on", right: true }, { label: "Note" },
    ], rows);
    const readable = disks.filter((d) => (d.smart || {}).read);
    if (readable.length) {
      block.append(expandable({
        label: "Every attribute these drives report",
        hint: "including the vendor-specific ones this tool does not judge",
        // Rule 2: everything the drive said is here to read; only the ids in
        // the Judged column were used to reach a verdict.
        onOpen: () => el("div", {}, readable.map(rawBlock)),
      }).node);
    }
    return block;
  }

  function reasonOf(device) {
    const smart = device.smart || {};
    if (device.virtual) return "virtual: its counters describe no physical medium";
    if (smart.asleep) {
      return smart.stale_since
        ? `in standby; values from ${fmt.clock(smart.stale_since)}` : "in standby, left asleep";
    }
    if (smart.read === false) return smart.reason || "not read";
    const history = device.history || {};
    return history.days ? `${history.days} day${history.days === 1 ? "" : "s"} on record` : "";
  }

  function rawBlock(device) {
    const smart = device.smart || {};
    const attributes = Object.entries(smart.attributes || {});
    const vendor = ((smart.raw || {}).vendor_attributes || []);
    const rows = [...attributes.map(([id, a]) => ({ id, ...a, judged: true })),
      ...vendor.map((a) => ({ ...a, id: String(a.id), judged: false }))]
      .sort((a, b) => Number(a.id) - Number(b.id));
    const table = el("table.tbl.tbl--tight");
    const head = el("thead");
    head.append(el("tr", {}, [
      el("th.r", { text: "Id" }), el("th", { text: "Attribute" }), el("th.r", { text: "Raw" }),
      el("th.r", { text: "Value" }), el("th.r", { text: "Threshold" }), el("th", { text: "Judged" })]));
    table.append(head, el("tbody", {}, rows.map((a) => el("tr", {}, [
      el("td.n.mono", { text: String(a.id) }),
      el("td", { text: a.name || fmt.dash }),
      el("td.n.mono", { text: fmt.isNum(a.raw) ? String(a.raw) : fmt.dash,
        title: a.packed ? `packed raw field; smartctl read "${a.raw_string}"` : (a.raw_string || "") }),
      el("td.n", { text: fmt.isNum(a.value) ? String(a.value) : fmt.dash }),
      el("td.n", { text: fmt.isNum(a.thresh) ? String(a.thresh) : fmt.dash }),
      el("td", {}, [a.when_failed ? pill(a.when_failed, "crit")
        : a.judged ? pill("yes", "ok") : pill("no", null)]),
    ]))));
    const nvme = smart.nvme;
    return el("div", { style: { marginBottom: "12px" } }, [
      el("div.label", { style: { marginBottom: "6px" },
        text: `${device.name} — ${device.model || "unknown model"}` }),
      nvme ? kvs([
        kv("Critical warning", (nvme.critical_warning_bits || []).length
          ? el("span", {}, [pill(`0x${Number(nvme.critical_warning).toString(16)}`, "crit"),
            el("span.faint.small", { text: ` ${nvme.critical_warning_bits.join("; ")}` })])
          : pill("none", "ok")),
        kv("Spare", fmt.isNum(nvme.available_spare)
          ? `${nvme.available_spare} % (floor ${nvme.available_spare_threshold} %)` : fmt.dash),
        kv("Written", fmt.isNum(nvme.bytes_written) ? fmt.bytes(nvme.bytes_written) : fmt.dash),
        kv("Unsafe shutdowns", fmt.isNum(nvme.unsafe_shutdowns) ? fmt.count(nvme.unsafe_shutdowns) : fmt.dash),
        kv("Media errors", fmt.isNum(nvme.media_errors) ? fmt.count(nvme.media_errors) : fmt.dash),
      ]) : null,
      rows.length ? el("div.tblwrap", {}, [table])
        : note("info", "This drive reports no attribute table (an NVMe drive keeps its health log instead)."),
      smart.selftest ? el("div.faint.small", { style: { marginTop: "6px" },
        text: `Last self-test in the drive's own log: ${smart.selftest}. The Prognosis never starts one.` }) : null,
    ].filter(Boolean));
  }

  function linkTable(links) {
    return tableOf("SATA links", [
      { label: "Link" }, { label: "Disk" }, { label: "Negotiated" }, { label: "Capable of" },
      { label: "Note" },
    ], links.map((link) => el("tr", {}, [
      el("td.mono", { text: link.ata || fmt.dash }),
      el("td.mono", { text: link.disk || fmt.dash }),
      el("td", {}, [link.speed
        ? pill(link.speed, link.downgraded ? "warn" : "ok") : el("span.faint", { text: fmt.dash })]),
      el("td", { text: link.max || fmt.dash }),
      el("td.faint.small", { text: link.note || (link.downgraded ? "below what both ends can do" : "") }),
    ])));
  }

  function nicTable(nics) {
    return tableOf("Interfaces", [
      { label: "Interface" }, { label: "Driver" }, { label: "State" }, { label: "Speed" },
      { label: "Seen at" }, { label: "Note" },
    ], nics.map((nic) => el("tr", {}, [
      el("td.mono", { text: nic.name }),
      el("td.faint", { text: nic.driver || fmt.dash }),
      el("td", {}, [pill(nic.operstate || (nic.up ? "up" : "down"), nic.up ? "ok" : null)]),
      el("td", { text: fmt.isNum(nic.speed_mbps) ? mbit(nic.speed_mbps) : fmt.dash }),
      el("td.faint", { text: fmt.isNum(nic.best_seen_mbps) ? mbit(nic.best_seen_mbps) : fmt.dash }),
      el("td.faint.small", { text: nic.note || "" }),
    ])));
  }

  function memoryTable(controllers) {
    const rows = [];
    for (const controller of controllers) {
      rows.push(el("tr", {}, [
        el("td.mono", { text: controller.name }),
        el("td", { text: controller.mem_type || fmt.dash }),
        el("td.n", { text: fmt.count(controller.ce_count ?? 0) }),
        el("td.n", {}, [controller.ue_count
          ? pill(String(controller.ue_count), "crit") : el("span", { text: "0" })]),
        el("td.faint.small", { text: `${(controller.dimms || []).length} module(s)` }),
      ]));
      for (const dimm of controller.dimms || []) {
        rows.push(el("tr", {}, [
          el("td.faint.mono", { text: `  ${dimm.name}` }),
          el("td.faint", { text: dimm.label || fmt.dash }),
          el("td.n.faint", { text: fmt.count(dimm.ce_count ?? 0) }),
          el("td.n", {}, [dimm.ue_count
            ? pill(String(dimm.ue_count), "crit") : el("span.faint", { text: "0" })]),
          el("td.faint.small", { text: fmt.isNum(dimm.size_mb) ? `${dimm.size_mb} MB` : "" }),
        ]));
      }
    }
    return tableOf("Memory (ECC)", [
      { label: "Controller" }, { label: "Type" }, { label: "Corrected", right: true },
      { label: "Uncorrected", right: true }, { label: "Note" },
    ], rows);
  }

  function pciTable(devices) {
    return tableOf("PCIe error counters", [
      { label: "Address" }, { label: "Device" }, { label: "Driver" },
      { label: "Corrected", right: true }, { label: "Non-fatal", right: true },
      { label: "Fatal", right: true },
    ], devices.map((device) => el("tr", {}, [
      el("td.mono", { text: device.bdf }),
      el("td", { text: device.label || fmt.dash }),
      el("td.faint.mono", { text: device.driver || fmt.dash }),
      el("td.n", { text: fmt.count(device.correctable ?? 0) }),
      el("td.n", {}, [device.nonfatal ? pill(String(device.nonfatal), "warn") : el("span", { text: "0" })]),
      el("td.n", {}, [device.fatal ? pill(String(device.fatal), "crit") : el("span", { text: "0" })]),
    ])));
  }

  function powerTable(supplies) {
    return tableOf("Batteries", [
      { label: "Name" }, { label: "Type" }, { label: "Health" }, { label: "Cycles", right: true },
      { label: "Status" },
    ], supplies.map((supply) => el("tr", {}, [
      el("td.mono", { text: supply.name }),
      el("td", { text: supply.type || fmt.dash }),
      el("td", {}, fmt.isNum(supply.health_pct)
        ? [barCell(supply.health_pct,
          supply.health_pct < 50 ? "crit" : supply.health_pct < 70 ? "warn" : "ok",
          `${supply.health_pct.toFixed(0)} % of design`, "of the capacity it was built with")]
        : [el("span.faint", { text: fmt.dash })]),
      el("td.n", { text: fmt.isNum(supply.cycle_count) ? fmt.count(supply.cycle_count) : fmt.dash }),
      el("td.faint", { text: supply.status || fmt.dash }),
    ])));
  }

  /* ── The wear chart ──────────────────────────────────────────────── */
  function syncPicker(payload) {
    const options = [];
    for (const device of payload.devices || []) {
      if (device.virtual) continue;
      options.push({ value: `disk|${device.subject}`,
        label: `${device.name || device.subject}${device.model ? ` — ${device.model}` : ""}` });
    }
    for (const controller of (payload.memory || {}).controllers || []) {
      options.push({ value: `memory|${controller.name}`, label: `${controller.name} (ECC)` });
    }
    for (const device of payload.pci || []) {
      if (device.correctable || device.nonfatal || device.fatal) {
        options.push({ value: `pci|${device.bdf}`, label: `${device.label || device.bdf}` });
      }
    }
    for (const supply of payload.power || []) {
      options.push({ value: `power|${supply.name}`, label: `${supply.name} (battery)` });
    }
    const signature = options.map((o) => o.value).join(",");
    if (signature === subjects.map((o) => o.value).join(",")) return;
    subjects = options;
    if (!options.length) {
      render(nodes.picker, []);
      render(nodes.chartLegend, []);
      render(nodes.chartNote, [note("info",
        "Nothing on this machine has a wear record yet: the counters are kept once a disk, a memory "
        + "controller or a battery has been read at least once.")]);
      patchText(nodes.chartMeta, "no subjects");
      return;
    }
    const current = picked ? `${picked.kind}|${picked.subject}` : options[0].value;
    render(nodes.picker, [combobox({
      label: "Subject", options, value: current, allLabel: null,
      ariaLabel: "Which device to chart",
      onChange: (value) => { pickSubject(value); },
    })]);
    if (!picked) pickSubject(current);
  }

  function pickSubject(value) {
    const [kind, ...rest] = String(value).split("|");
    picked = { kind, subject: rest.join("|") };
    loadSeries();
  }

  async function loadSeries() {
    const node = store.node;
    if (!node || !picked) return;
    try {
      const fresh = await api(`/api/wear?node=${encodeURIComponent(node)}`
        + `&kind=${encodeURIComponent(picked.kind)}&subject=${encodeURIComponent(picked.subject)}`);
      if (store.node !== node) return;
      series = fresh;
      drawSeries();
    } catch (error) {
      series = null;
      render(nodes.chartNote, [note("warn", el("span", { text: error.message }))]);
    }
  }

  function drawSeries() {
    if (!series) return;
    const rows = series.rows || [];
    const present = SERIES.filter((spec) => rows.some(
      (row) => fmt.isNum((row.counters || {})[spec.key])));
    patchText(nodes.chartMeta, rows.length
      ? `${rows.length} day${rows.length === 1 ? "" : "s"} on record` : "no days on record");
    // One point is not a line. Rather than draw an empty box that reads as a
    // broken chart, the section says how far off the first one is.
    if (rows.length < 2 || !present.length) {
      render(nodes.chartNote, [note("info", rows.length === 1
        ? "One day on record. A line needs two, and a forecast needs fourteen — the next row is "
        + "written after midnight."
        : "No daily rows for this subject yet. The first one is written the first time the host "
        + "receives a reading from it.")]);
      render(nodes.chartLegend, []);
      nodes.chartBox.hidden = true;
      if (chart) chart.setData([], {});
      return;
    }
    nodes.chartBox.hidden = false;
    const forecast = series.forecast;
    const specs = present.map((spec) => ({
      key: spec.key, token: spec.token, label: spec.label, fill: false, dot: false,
    }));
    // The fit, drawn dashed to the day it reaches the target — the same
    // numbers the sentence quotes, so the picture cannot say something else.
    const projected = forecast && forecast.reaches_at
      && present.some((s) => s.key === forecast.key);
    if (projected) specs.push({ key: "_fit", token: "--fg-3", label: "Fit", fill: false, dashed: true, dot: false });

    const ts = rows.map((row) => row.day);
    const data = {};
    for (const spec of present) data[spec.key] = rows.map((row) => {
      const value = (row.counters || {})[spec.key];
      return fmt.isNum(value) ? value : null;
    });
    if (projected) {
      ts.push(forecast.reaches_at);
      for (const spec of present) data[spec.key].push(null);
      data._fit = rows.map(() => null);
      data._fit[Math.max(0, rows.length - forecast.points)] =
        forecast.latest - forecast.per_day * (forecast.points - 1);
      data._fit[rows.length - 1] = forecast.latest;
      data._fit.push(forecast.target);
    }
    if (!chart) {
      chart = createChart(nodes.chartCanvas, {
        series: specs, yMax: "auto", gridLines: 3,
        padding: { top: 4, right: 1, bottom: 1, left: 0 },
      });
    } else {
      chart.options.series = specs;
    }
    chart.setData(ts, data);
    render(nodes.chartLegend, [el("div.legend", {}, specs.map((spec) => {
      const swatch = el("span.legend__swatch");
      swatch.style.background = `var(${spec.token})`;
      return el("span.legend__item", {}, [swatch, el("span", { text: spec.label })]);
    }))]);
    // The fit is only ever of the endurance estimate; a subject without one
    // is not "not enough data", it is a subject there is nothing to forecast
    // for, and saying the wrong one of those is worse than saying neither.
    const forecastable = present.some((spec) => spec.key === "percentage_used");
    render(nodes.chartNote, forecast && forecast.reaches_at
      ? [note("warn", `Fitted over ${forecast.fitted_days} days (${forecast.points} readings): `
        + `${rate(forecast.per_day)} % a day, reaching ${forecast.target} % around `
        + `${onDay(forecast.reaches_at)}.`)]
      : forecast
        ? [note("info", `Fitted over ${forecast.fitted_days} days: `
          + `${forecast.rising ? `${rate(forecast.per_day)} % a day` : "not rising"}, so no date is named.`)]
        : forecastable
          ? [note("info", "Fewer than fourteen daily readings of the endurance estimate, so no line "
            + "is fitted and no date is named.")]
          : [note("info", "Only an SSD's endurance estimate is forecast. Error counters are counted, "
            + "not extrapolated: a disk that reallocated fourteen sectors today says nothing about "
            + "how many it will reallocate tomorrow.")]);
  }

  /** Date and every drawn value under the cursor. Without it the chart is a
   *  shape; with it every point can be read back as the number it came from. */
  function showChartTip(event) {
    if (!chart || !series || !(series.rows || []).length) return;
    const index = chart.indexAt(event.clientX);
    const day = chart.data.ts[index];
    if (!fmt.isNum(day)) { nodes.chartTip.hidden = true; return; }
    const lines = [el("div.tip__when", { text: fmt.dateTime(day) })];
    for (const spec of chart.options.series) {
      if (spec.key === "_fit") continue;
      const value = chart.data.series[spec.key]?.[index];
      if (!fmt.isNum(value)) continue;
      const swatch = el("span.tip__sw");
      swatch.style.background = `var(${spec.token})`;
      const meta = SERIES.find((s) => s.key === spec.key) || {};
      lines.push(el("div.tip__row", {}, [swatch,
        el("span", { text: `${spec.label}: ${value}${meta.unit || ""}` })]));
    }
    nodes.chartTip.replaceChildren(...lines);
    const box = nodes.chartBox.getBoundingClientRect();
    nodes.chartTip.style.left = `${event.clientX - box.left}px`;
    nodes.chartTip.style.top = `${Math.max(24, event.clientY - box.top)}px`;
    nodes.chartTip.hidden = false;
  }

  /* ── Checks ──────────────────────────────────────────────────────── */
  function renderChecks(checks) {
    const smart = checks.smart || {};
    const links = checks.links || {};
    const nics = checks.nics || {};
    const memory = checks.memory || {};
    const pci = checks.pci || {};
    const power = checks.power || {};
    const tiles = [
      tile("SMART", smart.available === false ? "not readable"
        : `${fmt.count(smart.read)} of ${fmt.count(smart.devices)} read`
          + (smart.asleep ? ` · ${smart.asleep} asleep` : "")
          + (smart.virtual ? ` · ${smart.virtual} virtual` : ""),
      smart.available === false ? "warn" : smart.read ? "ok" : "warn", smart.reason),
      tile("Next SMART pass", fmt.isNum(smart.next_pass) ? fmt.clock(smart.next_pass) : "not scheduled",
        null, smart.wake_disks
          ? "sleeping disks are woken to be read (turned on in Settings)"
          : "sleeping disks are reported as asleep and left alone"),
      tile("SATA links", links.available === false ? "none"
        : `${fmt.count(links.links)} · ${fmt.count(links.negotiated)} negotiated`,
      links.available === false ? null : "ok", links.reason || links.note),
      tile("Interfaces", nics.available === false ? "not readable"
        : `${fmt.count(nics.physical)} physical · ${fmt.count(nics.speed_known)} report a speed`,
      nics.available === false ? "warn" : "ok", nics.reason),
      tile("Memory (ECC)", memory.available === false ? "no EDAC"
        : `${fmt.count(memory.controllers)} controller(s) · ${fmt.count(memory.dimms)} module(s)`,
      memory.available === false ? null : "ok", memory.reason),
      tile("PCIe AER", pci.available === false ? "not exposed"
        : `${fmt.count(pci.devices)} device(s)`, pci.available === false ? null : "ok", pci.reason),
      tile("Power", power.available === false ? "none"
        : `${fmt.count(power.supplies)} supply(ies)`, power.available === false ? null : "ok", power.reason),
    ];
    render(nodes.checks, tiles);
    patchText(nodes.checksMeta, `${tiles.length} checks`);
  }

  root.mount = () => { if (!built) build(); update(store.state); if (picked) loadSeries(); };
  root.unmount = () => { if (chart) { chart.destroy(); chart = null; } };
  root.subscriptions = [store.on(["prognosis", "node"], () => {
    if (!root.isActive) return;
    update(store.state);
  }), store.on(["node"], () => { picked = null; subjects = []; series = null; })];
  return root;
}

function tile(label, value, tone, title) {
  return el("div.fact", tone ? { dataset: { tone } } : {}, [
    el("div.fact__k", { text: label, title: label }),
    el("div.fact__v", { text: value, title: title || value }),
  ]);
}

/** A short bar with its number beside it, for a table cell: a meter left to
 *  itself fills the column and reads as a progress bar for the row. */
function barCell(value, tone, label, title) {
  return el("div.row", { style: { gap: "8px", alignItems: "center" }, title: title || "" }, [
    el("div", { style: { width: "72px", flex: "0 0 auto" } },
      [meter(Math.min(100, value), { tone, thin: true, title })]),
    el("span.faint.small", { text: label }),
  ]);
}

/** A slope, at the precision the fit actually has. Four decimals on a
 *  least-squares line over 90 noisy points is a claim, not a number. */
function rate(value) {
  return fmt.isNum(value) ? String(Number(value.toPrecision(2))) : fmt.dash;
}

/** A forecast lands on a day, never at 18:45: the fit has no hour in it. */
function onDay(epochSeconds) {
  return fmt.isNum(epochSeconds)
    ? new Date(epochSeconds * 1000).toLocaleDateString(undefined,
      { day: "numeric", month: "short", year: "numeric" })
    : fmt.dash;
}

function mbit(value) {
  return value >= 1000 ? `${value / 1000} Gbit/s` : `${value} Mbit/s`;
}

import { createContext, Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { UI_CSS, UI_HTML, UI_JS } from "../../src/ui/page.js";
import type { UiGoal, UiSnapshot } from "../../src/ui/types.js";

/** A deliberately small DOM surface: HTML sinks throw, so hostile fixture IDs cannot hide unsafe rendering. */
class Element {
  className = "";
  hidden = false;
  disabled = false;
  checked = false;
  value = "";
  type = "";
  dateTime = "";
  children: Element[] = [];
  attributes: Record<string, string> = {};
  listeners = new Map<string, () => unknown>();
  private text = "";
  constructor(readonly tagName: string) {}
  set textContent(value: string) {
    this.text = value;
    this.children = [];
  }
  get textContent(): string {
    return this.text + this.children.map((child) => child.textContent).join("");
  }
  set innerHTML(_value: string) {
    throw new Error("HTML parsing is forbidden in this client");
  }
  append(...children: Element[]) {
    this.children.push(...children);
  }
  replaceChildren(...children: Element[]) {
    this.text = "";
    this.children = children;
  }
  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }
  addEventListener(name: string, callback: () => unknown) {
    this.listeners.set(name, callback);
  }
  async dispatch(name: string) {
    await this.listeners.get(name)?.();
  }
}

function goal(id = "goal-a"): UiGoal {
  return {
    goal_id: id,
    audit_state: "approved",
    run_state: "running",
    ticks: 2,
    work_counts: {
      ready: 1,
      awaiting_approval: 0,
      in_progress: 0,
      awaiting_review: 0,
      done: 0,
      failed: 0,
      vetoed: 0,
      cancelled: 0,
    },
    gap: null,
    gap_history: [],
    work_items: [{ work_id: "w-a", state: "ready", risk: "normal", evidence: null }],
    needs_human: [],
    warnings: [],
    truncated: false,
  };
}
function snapshot(goals = [goal()]): UiSnapshot {
  return {
    schema_version: 1,
    generated_at: "2026-10-19T10:00:00Z",
    ledger_head: "a".repeat(64),
    status: "ok",
    goals,
    events: [],
    warnings: [],
    truncated: false,
  };
}
async function client(initial: UiSnapshot) {
  const elements = new Map<string, Element>();
  for (const match of UI_HTML.matchAll(/id="([^"]+)"/g)) elements.set(match[1] ?? "", new Element("div"));
  let next: UiSnapshot | Error = initial;
  let requests = 0;
  let interval: (() => unknown) | undefined;
  const document = {
    visibilityState: "visible",
    getElementById: (id: string) => {
      const found = elements.get(id);
      if (!found) throw new Error(`Missing UI element: ${id}`);
      return found;
    },
    createElement: (tag: string) => new Element(tag),
  };
  new Script(UI_JS).runInContext(
    createContext({
      document,
      AbortController,
      setTimeout: () => 1,
      clearTimeout: () => {},
      setInterval: (callback: () => unknown) => {
        interval = callback;
      },
      fetch: async (url: string, options: { cache: string; credentials: string }) => {
        expect(url).toBe("./api/snapshot");
        expect(options.cache).toBe("no-store");
        expect(options.credentials).toBe("same-origin");
        requests += 1;
        if (next instanceof Error) throw next;
        return { ok: true, json: async () => next };
      },
    }),
  );
  const settle = async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  };
  await settle();
  return {
    element: (id: string) => document.getElementById(id),
    next: (value: UiSnapshot | Error) => {
      next = value;
    },
    requests: () => requests,
    poll: async () => {
      interval?.();
      await settle();
    },
    document,
  };
}

describe("read-only dashboard client", () => {
  it("renders hostile IDs literally without parsing HTML or creating executable nodes", async () => {
    const hostile = '<img src=x onerror="globalThis.compromised=true">';
    const ui = await client(snapshot([goal(hostile)]));
    expect(ui.element("selected-goal").textContent).toBe(hostile);
    expect(ui.element("goal-list").textContent).toContain(hostile);
    expect(ui.element("goal-list").children[0]?.children[0]?.tagName).toBe("span");
    expect(ui.element("revision").textContent).toContain("Verified revision");
    expect(ui.element("refresh").disabled).toBe(false);
  });

  it("keeps evidence recommendation, withheld report verification, and approval distinct", async () => {
    const item = goal();
    item.work_items[0] = {
      work_id: "w-a",
      state: "awaiting_review",
      risk: "high",
      evidence: { recommendation: "human_needed" },
    };
    const ui = await client(snapshot([item]));
    const text = ui.element("evidence").textContent;
    expect(text).toContain("Recommendationhuman needed");
    expect(text).toContain("Report verificationDetails withheld · inspect in CLI");
    expect(text).toContain("Human approvalNot established by this view");
    expect(text).toContain("does not independently verify evidence quality");
    expect(ui.element("gap").textContent).toContain("Current disclosure unavailable");
    expect(ui.element("history").textContent).toContain("History unavailable");
  });

  it("retains the last good snapshot with an explicit stale state when refresh fails", async () => {
    const ui = await client(snapshot());
    ui.next(new Error("private filesystem path must never reach the UI"));
    await ui.element("refresh").dispatch("click");
    expect(ui.element("selected-goal").textContent).toBe("goal-a");
    expect(ui.element("refresh-status").textContent).toContain("Stale");
    expect(ui.element("notice").textContent).toContain("previous snapshot retained");
    expect(ui.element("notice").textContent).not.toContain("private filesystem");
    expect(ui.element("refresh").disabled).toBe(false);
  });

  it("withholds overview and goal details for a corrupt ledger", async () => {
    const ui = await client({ ...snapshot([]), status: "corrupt", ledger_head: null, warnings: ["ledger_corrupt"] });
    expect(ui.element("overview").hidden).toBe(true);
    expect(ui.element("goal-section").hidden).toBe(true);
    expect(ui.element("timeline-section").hidden).toBe(true);
    expect(ui.element("revision").textContent).toBe("Revision unavailable");
    expect(ui.element("notice").textContent).toContain("Factory details are withheld");
  });

  it("filters locally, preserves goal selection, and polls only when opted in and visible", async () => {
    const ui = await client(snapshot([goal("one"), goal("two")]));
    await ui.element("goal-list").children[1]?.dispatch("click");
    expect(ui.element("selected-goal").textContent).toBe("two");
    ui.element("goal-filter").value = "one";
    await ui.element("goal-filter").dispatch("input");
    expect(ui.element("goal-list").children).toHaveLength(1);
    expect(ui.element("selected-goal").textContent).toBe("two");
    await ui.poll();
    expect(ui.requests()).toBe(1);
    ui.element("auto-refresh").checked = true;
    await ui.poll();
    expect(ui.requests()).toBe(2);
    expect(ui.element("selected-goal").textContent).toBe("two");
    ui.document.visibilityState = "hidden";
    await ui.poll();
    expect(ui.requests()).toBe(2);
  });

  it("uses local external assets and has no mutation or inline execution surface", () => {
    expect(UI_HTML).toContain('href="./style.css"');
    expect(UI_HTML).toContain('<script src="./app.js" defer></script>');
    expect(UI_HTML).not.toMatch(/<form|\son\w+\s*=|<style|<script(?! src=)/i);
    expect(UI_JS).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
    expect(UI_JS).not.toMatch(/method:\s*["'](?:POST|PUT|PATCH|DELETE)/i);
    expect(UI_CSS).not.toContain("@import");
    expect(UI_CSS).toContain("prefers-color-scheme:dark");
    expect(UI_CSS).toContain("focus-visible");
  });
});

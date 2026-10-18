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
  set outerHTML(_value: string) {
    throw new Error("HTML parsing is forbidden in this client");
  }
  insertAdjacentHTML() {
    throw new Error("HTML parsing is forbidden in this client");
  }
  append(...children: Element[]) {
    this.children.push(...children);
  }
  prepend(...children: Element[]) {
    this.children.unshift(...children);
  }
  replaceChildren(...children: Element[]) {
    this.text = "";
    this.children = children;
  }
  setAttribute(name: string, value: string) {
    if (/^on/i.test(name) || name.toLowerCase() === "srcdoc") throw new Error("Executable attributes are forbidden");
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
    createElement: (tag: string) => {
      if (["script", "iframe", "object", "embed"].includes(tag.toLowerCase())) {
        throw new Error("Executable elements are forbidden");
      }
      return new Element(tag);
    },
    createRange: () => ({
      createContextualFragment: () => {
        throw new Error("HTML parsing is forbidden in this client");
      },
    }),
    write: () => {
      throw new Error("HTML parsing is forbidden in this client");
    },
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
      fetch: async (url: string, options: { cache: string; credentials: string; method?: string }) => {
        expect(url).toBe("./api/snapshot");
        expect(options.cache).toBe("no-store");
        expect(options.credentials).toBe("same-origin");
        expect(options.method ?? "GET").toBe("GET");
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
  it("renders hostile identifiers and enum fields without parsing HTML or creating executable nodes", async () => {
    const hostile = '<img src=x onerror="alert(1)">';
    const input = snapshot([goal(hostile)]);
    const item = input.goals[0];
    if (!item) throw new Error("Goal fixture missing");
    item.work_items[0] = { work_id: hostile, state: "ready", risk: "normal", evidence: null };
    // Attack the browser boundary directly, including values the server's closed projection rejects.
    item.needs_human = [{ code: hostile, work_id: hostile }] as unknown as UiGoal["needs_human"];
    item.warnings = [hostile] as unknown as UiGoal["warnings"];
    input.warnings = [hostile] as unknown as UiSnapshot["warnings"];
    input.events = [
      { seq: 1, at: input.generated_at, type: hostile, goal_id: hostile, work_id: hostile },
    ] as unknown as UiSnapshot["events"];
    const ui = await client(input);
    expect(ui.element("selected-goal").textContent).toBe(hostile);
    expect(ui.element("goal-list").textContent).toContain(hostile);
    expect(ui.element("goal-list").children[0]?.children[0]?.tagName).toBe("span");
    expect(ui.element("workboard").textContent).toContain(hostile);
    expect(ui.element("needs-human").textContent).toContain(hostile);
    expect(ui.element("timeline").textContent).toContain(hostile);
    expect(ui.element("goal-warnings").textContent).toBe("State unavailable.");
    expect(ui.element("notice").textContent).not.toContain(hostile);
    expect(ui.element("revision").textContent).toContain("Verified revision");
    expect(ui.element("notice").textContent).toContain("Snapshot has limits");
    expect(ui.element("notice").textContent).not.toContain("Refresh failed");
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
    expect(text).toContain("Agent recommendationhuman needed");
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

  it.each(["corrupt", "unavailable"] as const)(
    "withholds goal counts and details for a %s snapshot",
    async (status) => {
      const ui = await client({
        ...snapshot([]),
        status,
        ledger_head: null,
        warnings: [status === "corrupt" ? "ledger_corrupt" : "project_unavailable"],
      });
      expect(ui.element("overview").hidden).toBe(true);
      expect(ui.element("goal-section").hidden).toBe(true);
      expect(ui.element("timeline-section").hidden).toBe(true);
      expect(ui.element("revision").textContent).toBe("Revision unavailable");
      expect(ui.element("goal-count").textContent).toBe("—");
      expect(ui.element("goal-list").textContent).toBe("Goal list withheld until verification succeeds.");
      expect(ui.element("goal-list").textContent).not.toContain("No goals");
    },
  );

  it("counts only approved running goals, excluding draft, tampered and re-approval states", async () => {
    const goals = (["approved", "draft", "tampered", "needs_reapproval", "invalid"] as const).map((audit) => ({
      ...goal(audit),
      audit_state: audit,
    }));
    goals.push({ ...goal("finished"), run_state: "finish", audit_state: "approved" });
    const ui = await client(snapshot(goals));
    expect(ui.element("overview").children[1]?.children[1]?.textContent).toBe("1");
    expect(ui.element("goal-list").textContent).toContain("needs re-approval");
  });

  it("labels a finished run as a success candidate awaiting human sign-off", async () => {
    const ui = await client(snapshot([{ ...goal(), run_state: "finish" }]));
    expect(ui.element("goal-status").textContent).toContain("Run · Success candidate · awaiting human sign-off");
    expect(ui.element("overview").children[1]?.children[1]?.textContent).toBe("0");
  });

  it.each([false, true])(
    "marks human attention unknown when projection is unavailable (recorded=%s)",
    async (recorded) => {
      const item = goal();
      item.warnings = ["needs_human_unavailable"];
      if (recorded) item.needs_human = [{ code: "J1", work_id: null }];
      const ui = await client(snapshot([item]));
      expect(ui.element("human-count").textContent).toBe("Unknown");
      expect(ui.element("overview").children[3]?.children[1]?.textContent).toBe("Unknown");
      expect(ui.element("needs-human").textContent).toContain("unknown");
      expect(ui.element("needs-human").textContent).not.toContain("No human-attention");
      if (recorded) expect(ui.element("needs-human").textContent).toContain("J1");
    },
  );

  it.each([
    ["goal_integrity_attention", "Goal integrity needs inspection"],
    ["goal_invalid", "Goal definition needs attention"],
  ] as const)("explains %s without suggesting approval alone repairs it", async (code, text) => {
    const item = goal();
    item.needs_human = [{ code, work_id: null }];
    item.warnings = [code];
    const ui = await client(snapshot([item]));
    expect(ui.element("needs-human").textContent).toContain(text);
    expect(ui.element("needs-human").textContent).toContain("Continue in CLI");
    expect(ui.element("goal-warnings").textContent).toContain("CLI");
    expect(ui.element("needs-human").textContent).not.toContain("No human-attention");
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
    expect(UI_CSS).not.toContain("@import");
    expect(UI_CSS).toContain("prefers-color-scheme:dark");
    expect(UI_CSS).toContain("focus-visible");
  });
});

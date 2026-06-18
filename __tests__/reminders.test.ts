import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  loadRemindersConfig,
  createInitialState,
  evaluateConditions,
  applyCooldowns,
  decrementCooldowns,
  isTestCommand,
  recordToolResult,
  formatReminderMessages,
  type RemindersConfig,
  type ReminderState,
  type ReminderDefinition,
} from "../reminders";

// ── Test Helpers ───────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<RemindersConfig> = {}): RemindersConfig {
  return {
    reminders: [
      { id: "r1", condition: { type: "turns_since_test", threshold: 20 }, message: "Run tests", cooldown: 5 },
      { id: "r2", condition: { type: "uncommitted_files", threshold: 5 }, message: "Commit", cooldown: 10 },
      { id: "r3", condition: { type: "token_usage_pct", threshold: 80 }, message: "Compact", cooldown: 3 },
      { id: "r4", condition: { type: "consecutive_failures", threshold: 3 }, message: "Reassess", cooldown: 10 },
    ],
    ...overrides,
  };
}

/** Create a temp directory with .pi/reminders.json containing the given content. */
function setupTempDir(jsonContent: unknown): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reminders-test-"));
  const piDir = path.join(dir, ".pi");
  fs.mkdirSync(piDir, { recursive: true });
  fs.writeFileSync(path.join(piDir, "reminders.json"), JSON.stringify(jsonContent, null, 2));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** Create a temp directory without .pi/reminders.json (but with .pi dir or not). */
function setupEmptyTempDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reminders-test-"));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function makeState(overrides?: Partial<Omit<ReminderState, "cooldowns">> & {
  cooldowns?: Map<string, number>;
}): ReminderState {
  return {
    turnsSinceLastTest: overrides?.turnsSinceLastTest ?? 0,
    uncommittedFileCount: overrides?.uncommittedFileCount ?? 0,
    currentTokenUsagePct: overrides?.currentTokenUsagePct ?? 0,
    consecutiveFailures: overrides?.consecutiveFailures ?? 0,
    cooldowns: overrides?.cooldowns ?? new Map(),
  };
}

// ── loadRemindersConfig ────────────────────────────────────────────────────

describe("loadRemindersConfig", () => {
  it("returns empty when .pi/reminders.json missing", () => {
    const { dir, cleanup } = setupEmptyTempDir();
    try {
      const config = loadRemindersConfig(dir);
      assert.deepStrictEqual(config, { reminders: [] });
    } finally {
      cleanup();
    }
  });

  it("loads valid config correctly", () => {
    const expected: RemindersConfig = {
      reminders: [
        { id: "test-1", condition: { type: "turns_since_test", threshold: 10 }, message: "Hello", cooldown: 3 },
        { id: "test-2", condition: { type: "uncommitted_files", threshold: 3 }, message: "World", cooldown: 0 },
      ],
    };
    const { dir, cleanup } = setupTempDir(expected);
    try {
      const config = loadRemindersConfig(dir);
      assert.deepStrictEqual(config, expected);
    } finally {
      cleanup();
    }
  });

  it("returns empty for malformed JSON", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reminders-test-"));
    const piDir = path.join(dir, ".pi");
    fs.mkdirSync(piDir, { recursive: true });
    fs.writeFileSync(path.join(piDir, "reminders.json"), "this is not valid json {{{");
    try {
      const config = loadRemindersConfig(dir);
      assert.deepStrictEqual(config, { reminders: [] });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns empty when "reminders" key missing', () => {
    const { dir, cleanup } = setupTempDir({ some_other_key: 42 });
    try {
      const config = loadRemindersConfig(dir);
      assert.deepStrictEqual(config, { reminders: [] });
    } finally {
      cleanup();
    }
  });

  it('returns empty when "reminders" is not array', () => {
    const { dir, cleanup } = setupTempDir({ reminders: "not-an-array" });
    try {
      const config = loadRemindersConfig(dir);
      assert.deepStrictEqual(config, { reminders: [] });
    } finally {
      cleanup();
    }
  });

  it("returns empty for empty reminders array", () => {
    const { dir, cleanup } = setupTempDir({ reminders: [] });
    try {
      const config = loadRemindersConfig(dir);
      assert.deepStrictEqual(config, { reminders: [] });
    } finally {
      cleanup();
    }
  });

  it("filters invalid reminder entries (id as number, missing fields)", () => {
    const mixed = {
      reminders: [
        // valid
        { id: "valid", condition: { type: "turns_since_test", threshold: 5 }, message: "Ok", cooldown: 1 },
        // id as number
        { id: 123, condition: { type: "turns_since_test", threshold: 5 }, message: "Bad", cooldown: 1 },
        // missing message
        { id: "no-msg", condition: { type: "uncommitted_files", threshold: 2 }, cooldown: 3 },
        // missing cooldown
        { id: "no-cooldown", condition: { type: "token_usage_pct", threshold: 50 }, message: "X" },
        // missing condition
        { id: "no-cond", message: "Y", cooldown: 1 },
        // wrong condition type
        { id: "bad-type", condition: { type: "invalid_type", threshold: 1 }, message: "Z", cooldown: 1 },
        // negative cooldown
        { id: "neg-cooldown", condition: { type: "consecutive_failures", threshold: 1 }, message: "W", cooldown: -1 },
        // empty id string
        { id: "", condition: { type: "turns_since_test", threshold: 1 }, message: "Empty", cooldown: 1 },
      ],
    };
    const { dir, cleanup } = setupTempDir(mixed);
    try {
      const config = loadRemindersConfig(dir);
      assert.deepStrictEqual(config, {
        reminders: [
          { id: "valid", condition: { type: "turns_since_test", threshold: 5 }, message: "Ok", cooldown: 1 },
        ],
      });
    } finally {
      cleanup();
    }
  });
});

// ── evaluateConditions ─────────────────────────────────────────────────────

describe("evaluateConditions", () => {
  const config = makeConfig();

  it("returns empty when no conditions met", () => {
    const state = makeState();
    const matched = evaluateConditions(state, config);
    assert.deepStrictEqual(matched, []);
  });

  it("triggers turns_since_test when threshold met", () => {
    const state = makeState({ turnsSinceLastTest: 20 });
    const matched = evaluateConditions(state, config);
    const ids = matched.map((r) => r.id);
    // r1 has threshold 20, so it should match at exactly 20
    assert.ok(ids.includes("r1"));
    // Ensure no other reminders fired
    assert.strictEqual(matched.length, 1);
  });

  it("triggers uncommitted_files when threshold met", () => {
    const state = makeState({ uncommittedFileCount: 10 });
    const matched = evaluateConditions(state, config);
    const ids = matched.map((r) => r.id);
    // r2 has threshold 5
    assert.ok(ids.includes("r2"));
    assert.strictEqual(matched.length, 1);
  });

  it("triggers token_usage_pct when threshold met", () => {
    const state = makeState({ currentTokenUsagePct: 85 });
    const matched = evaluateConditions(state, config);
    const ids = matched.map((r) => r.id);
    // r3 has threshold 80
    assert.ok(ids.includes("r3"));
    assert.strictEqual(matched.length, 1);
  });

  it("triggers consecutive_failures when threshold met", () => {
    const state = makeState({ consecutiveFailures: 5 });
    const matched = evaluateConditions(state, config);
    const ids = matched.map((r) => r.id);
    // r4 has threshold 3
    assert.ok(ids.includes("r4"));
    assert.strictEqual(matched.length, 1);
  });

  it("respects cooldown — skips reminders in cooldown", () => {
    // r1 would normally fire (turns_since_test >= 20), but is in cooldown
    const state = makeState({
      turnsSinceLastTest: 20,
      cooldowns: new Map([["r1", 2]]),
    });
    const matched = evaluateConditions(state, config);
    const ids = matched.map((r) => r.id);
    assert.ok(!ids.includes("r1"));
    assert.strictEqual(matched.length, 0);
  });

  it("triggers multiple reminders when multiple conditions met", () => {
    const state = makeState({
      turnsSinceLastTest: 20,
      uncommittedFileCount: 6,
      currentTokenUsagePct: 90,
      consecutiveFailures: 3,
    });
    const matched = evaluateConditions(state, config);
    const ids = matched.map((r) => r.id).sort();
    assert.deepStrictEqual(ids, ["r1", "r2", "r3", "r4"]);
  });

  it("does not trigger when state is exactly at threshold - 1", () => {
    // r1 threshold is 20, at 19 it should NOT fire
    const state = makeState({ turnsSinceLastTest: 19 });
    const matched = evaluateConditions(state, config);
    const ids = matched.map((r) => r.id);
    assert.ok(!ids.includes("r1"));
    assert.strictEqual(matched.length, 0);
  });
});

// ── createInitialState ─────────────────────────────────────────────────────

describe("createInitialState", () => {
  it("returns all counters at zero with empty cooldowns", () => {
    const state = createInitialState();
    assert.strictEqual(state.turnsSinceLastTest, 0);
    assert.strictEqual(state.uncommittedFileCount, 0);
    assert.strictEqual(state.currentTokenUsagePct, 0);
    assert.strictEqual(state.consecutiveFailures, 0);
    assert.ok(state.cooldowns instanceof Map);
    assert.strictEqual(state.cooldowns.size, 0);
  });
});

// ── Cooldowns ──────────────────────────────────────────────────────────────

describe("cooldowns", () => {
  describe("applyCooldowns", () => {
    it("sets cooldown for matched reminders", () => {
      const state = makeState();
      const matched: ReminderDefinition[] = [
        { id: "r1", condition: { type: "turns_since_test", threshold: 20 }, message: "Run tests", cooldown: 5 },
        { id: "r3", condition: { type: "token_usage_pct", threshold: 80 }, message: "Compact", cooldown: 3 },
      ];
      applyCooldowns(state, matched);
      assert.strictEqual(state.cooldowns.get("r1"), 5);
      assert.strictEqual(state.cooldowns.get("r3"), 3);
      assert.strictEqual(state.cooldowns.size, 2);
    });

    it("does nothing when matched list is empty", () => {
      const state = makeState();
      applyCooldowns(state, []);
      assert.strictEqual(state.cooldowns.size, 0);
    });

    it("overwrites existing cooldown for same id", () => {
      const state = makeState({ cooldowns: new Map([["r1", 10]]) });
      const matched: ReminderDefinition[] = [
        { id: "r1", condition: { type: "turns_since_test", threshold: 20 }, message: "Run tests", cooldown: 3 },
      ];
      applyCooldowns(state, matched);
      assert.strictEqual(state.cooldowns.get("r1"), 3);
    });
  });

  describe("decrementCooldowns", () => {
    it("decreases cooldown and deletes at 1", () => {
      const state = makeState({
        cooldowns: new Map([
          ["a", 3],
          ["b", 1],
        ]),
      });
      decrementCooldowns(state);
      // b was 1 → deleted
      assert.strictEqual(state.cooldowns.get("a"), 2);
      assert.strictEqual(state.cooldowns.has("b"), false);
      assert.strictEqual(state.cooldowns.size, 1);
    });

    it("handles empty cooldowns map", () => {
      const state = makeState({ cooldowns: new Map() });
      decrementCooldowns(state);
      assert.strictEqual(state.cooldowns.size, 0);
    });

    it("deletes entry when cooldown reaches 0 after decrement", () => {
      // remaining === 1 → should delete; ensure we also check remaining > 1 path
      const state = makeState({
        cooldowns: new Map([
          ["x", 2],
          ["y", 5],
        ]),
      });
      decrementCooldowns(state); // x→1, y→4
      decrementCooldowns(state); // x→deleted, y→3
      assert.strictEqual(state.cooldowns.has("x"), false);
      assert.strictEqual(state.cooldowns.get("y"), 3);
      assert.strictEqual(state.cooldowns.size, 1);
    });
  });
});

// ── isTestCommand ──────────────────────────────────────────────────────────

describe("recordToolResult", () => {
  it("resets consecutiveFailures after any successful non-test tool result", () => {
    const state = makeState({ consecutiveFailures: 2 });
    recordToolResult(state, "bash", undefined, false);
    assert.equal(state.consecutiveFailures, 0);
  });

  // Regression for P0#1: index.ts used to read fabricated event.error/event.result
  // (always undefined → failed=false → consecutiveFailures never incremented).
  // This test pins the contract that recordToolResult honors failed=true.
  it("regression: failed=true (from event.isError) increments consecutiveFailures", () => {
    const state = makeState({ consecutiveFailures: 0 });
    recordToolResult(state, "bash", "npm run build", true);
    assert.equal(state.consecutiveFailures, 1);
    recordToolResult(state, "bash", "npm run build", true);
    assert.equal(state.consecutiveFailures, 2);
    // And evaluateConditions now triggers the consecutive_failures reminder.
    const cfg: RemindersConfig = {
      reminders: [{ id: "cf", condition: { type: "consecutive_failures", threshold: 2 }, message: "stop", cooldown: 1 }],
    };
    const matched = evaluateConditions(state, cfg);
    assert.ok(matched.some((r) => r.id === "cf"));
  });

  it("resets turnsSinceLastTest and failures after a successful test command", () => {
    const state = makeState({ turnsSinceLastTest: 12, consecutiveFailures: 2 });
    recordToolResult(state, "bash", "npm test", false);
    assert.equal(state.turnsSinceLastTest, 0);
    assert.equal(state.consecutiveFailures, 0);
  });

  it("increments consecutiveFailures after failed tool result", () => {
    const state = makeState({ consecutiveFailures: 2 });
    recordToolResult(state, "bash", "npm run build", true);
    assert.equal(state.consecutiveFailures, 3);
  });
});

// ── formatReminderMessages ────────────────────────────────────────────────

describe("formatReminderMessages", () => {
  it("aggregates multiple reminders into one current-turn context message", () => {
    const reminders: ReminderDefinition[] = [
      { id: "a", condition: { type: "turns_since_test", threshold: 1 }, message: "Run tests", cooldown: 1 },
      { id: "b", condition: { type: "uncommitted_files", threshold: 1 }, message: "Commit", cooldown: 1 },
    ];
    const message = formatReminderMessages(reminders);
    assert.match(message, /\[Reminder: a\] Run tests/);
    assert.match(message, /\[Reminder: b\] Commit/);
  });
});

// ── isTestCommand ──────────────────────────────────────────────────────────

describe("isTestCommand", () => {
  it('matches "npx jest"', () => {
    assert.strictEqual(isTestCommand("npx jest"), true);
  });

  it('matches "pytest tests/"', () => {
    assert.strictEqual(isTestCommand("pytest tests/"), true);
  });

  it('matches "npm test"', () => {
    assert.strictEqual(isTestCommand("npm test"), true);
  });

  it("matches variations like NPX JEST --coverage (case insensitive)", () => {
    assert.strictEqual(isTestCommand("NPX JEST --coverage"), true);
  });

  it('matches "npm run test -- --watch"', () => {
    assert.strictEqual(isTestCommand("npm run test -- --watch"), true);
  });

  it('matches "npx vitest run"', () => {
    assert.strictEqual(isTestCommand("npx vitest run"), true);
  });

  it('does not match "npm run build"', () => {
    assert.strictEqual(isTestCommand("npm run build"), false);
  });

  it("does not match empty string", () => {
    assert.strictEqual(isTestCommand(""), false);
  });

  it("does not match unrelated commands", () => {
    assert.strictEqual(isTestCommand("git commit -m 'wip'"), false);
    assert.strictEqual(isTestCommand("echo hello"), false);
    assert.strictEqual(isTestCommand("ls -la"), false);
    assert.strictEqual(isTestCommand("npm run build"), false);
    assert.strictEqual(isTestCommand("npm start"), false);
  });
});

describe("recordToolResult — failed test command", () => {
  it("a failed test still resets turnsSinceLastTest (the agent did run a test)", () => {
    const state = makeState({ turnsSinceLastTest: 20, consecutiveFailures: 0 });
    recordToolResult(state, "bash", "npx jest", true);
    assert.strictEqual(state.turnsSinceLastTest, 0, "failed test should reset turnsSinceLastTest");
    assert.strictEqual(state.consecutiveFailures, 1, "failed test should still increment failures");
  });

  it("a failed non-test command does NOT reset turnsSinceLastTest", () => {
    const state = makeState({ turnsSinceLastTest: 20, consecutiveFailures: 0 });
    recordToolResult(state, "bash", "npm run build", true);
    assert.strictEqual(state.turnsSinceLastTest, 20, "non-test failure keeps turnsSinceLastTest");
    assert.strictEqual(state.consecutiveFailures, 1);
  });

  it("a failed edit/write does not affect turnsSinceLastTest", () => {
    const state = makeState({ turnsSinceLastTest: 15, consecutiveFailures: 0 });
    recordToolResult(state, "edit", undefined, true);
    assert.strictEqual(state.turnsSinceLastTest, 15);
    assert.strictEqual(state.consecutiveFailures, 1);
  });
});

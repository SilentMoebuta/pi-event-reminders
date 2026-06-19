import * as fs from "node:fs";
import * as path from "node:path";

// ── Types ──────────────────────────────────────────────────────────────────

export type ConditionType =
  | "turns_since_test"
  | "uncommitted_files"
  | "token_usage_pct"
  | "consecutive_failures";

export interface ReminderCondition {
  type: ConditionType;
  threshold: number;
}

export interface ReminderDefinition {
  id: string;
  condition: ReminderCondition;
  message: string;
  cooldown: number;
}

export interface RemindersConfig {
  reminders: ReminderDefinition[];
}

export interface ReminderState {
  turnsSinceLastTest: number;
  uncommittedFileCount: number;
  currentTokenUsagePct: number;
  consecutiveFailures: number;
  cooldowns: Map<string, number>;
}

// ── Config Validation ─────────────────────────────────────────────────────

const VALID_CONDITION_TYPES = new Set([
  "turns_since_test",
  "uncommitted_files",
  "token_usage_pct",
  "consecutive_failures",
]);

function isValidReminder(r: unknown): r is ReminderDefinition {
  if (!r || typeof r !== "object") return false;
  const d = r as Record<string, unknown>;
  const condition = d.condition as Record<string, unknown> | undefined;

  return (
    typeof d.id === "string" &&
    d.id.length > 0 &&
    typeof d.message === "string" &&
    d.message.length > 0 &&
    typeof d.cooldown === "number" &&
    d.cooldown >= 0 &&
    typeof condition === "object" &&
    condition !== null &&
    typeof condition.type === "string" &&
    VALID_CONDITION_TYPES.has(condition.type) &&
    typeof condition.threshold === "number" &&
    condition.threshold >= 0
  );
}

// ── Config Loading ─────────────────────────────────────────────────────────

/**
 * Load reminders configuration from .pi/reminders.json.
 * Returns empty config if file is missing, malformed, or invalid.
 */
export function loadRemindersConfig(cwd: string): RemindersConfig {
  const configPath = path.join(cwd, ".pi", "reminders.json");

  if (!fs.existsSync(configPath)) {
    return { reminders: [] };
  }

  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed: unknown = JSON.parse(raw);

    if (parsed && typeof parsed === "object" && "reminders" in parsed) {
      const reminders = (parsed as Record<string, unknown>).reminders;
      if (Array.isArray(reminders)) {
        const validated = (reminders as unknown[]).filter(isValidReminder);
        return { reminders: validated as ReminderDefinition[] };
      }
    }

    return { reminders: [] };
  } catch {
    return { reminders: [] };
  }
}

// ── State Management ───────────────────────────────────────────────────────

/**
 * Create a fresh initial reminder state.
 */
export function createInitialState(): ReminderState {
  return {
    turnsSinceLastTest: 0,
    uncommittedFileCount: 0,
    currentTokenUsagePct: 0,
    consecutiveFailures: 0,
    cooldowns: new Map(),
  };
}

// ── Condition Evaluation ───────────────────────────────────────────────────

/**
 * Evaluate all reminder conditions against the current state.
 * Returns reminders whose condition threshold is met AND which are not in cooldown.
 */
export function evaluateConditions(
  state: ReminderState,
  config: RemindersConfig,
): ReminderDefinition[] {
  const matched: ReminderDefinition[] = [];

  for (const reminder of config.reminders) {
    // Skip reminders currently in cooldown
    const cooldownRemaining = state.cooldowns.get(reminder.id) ?? 0;
    if (cooldownRemaining > 0) continue;

    let conditionMet = false;

    switch (reminder.condition.type) {
      case "turns_since_test":
        conditionMet = state.turnsSinceLastTest >= reminder.condition.threshold;
        break;
      case "uncommitted_files":
        conditionMet = state.uncommittedFileCount >= reminder.condition.threshold;
        break;
      case "token_usage_pct":
        conditionMet = state.currentTokenUsagePct >= reminder.condition.threshold;
        break;
      case "consecutive_failures":
        conditionMet = state.consecutiveFailures >= reminder.condition.threshold;
        break;
    }

    if (conditionMet) {
      matched.push(reminder);
    }
  }

  return matched;
}

// ── Cooldown Management ────────────────────────────────────────────────────

/**
 * Apply cooldowns to matched reminders so they won't fire again for N turns.
 */
export function applyCooldowns(
  state: ReminderState,
  matched: ReminderDefinition[],
): void {
  for (const reminder of matched) {
    state.cooldowns.set(reminder.id, reminder.cooldown);
  }
}

/**
 * Decrement all active cooldowns by 1 (called each turn).
 */
export function decrementCooldowns(state: ReminderState): void {
  for (const [id, remaining] of state.cooldowns) {
    if (remaining > 1) {
      state.cooldowns.set(id, remaining - 1);
    } else if (remaining === 1) {
      state.cooldowns.delete(id);
    }
  }
}

// ── Test Command Detection ─────────────────────────────────────────────────

/** Patterns that indicate a test command was run. */
const TEST_PATTERNS = [
  /\btest\b/i,
  /\bjest\b/i,
  /\bpytest\b/i,
  /\bnpm test\b/i,
  /\bnpm run test\b/i,
  /\bnpx jest\b/i,
  /\bnpx vitest\b/i,
  /\bvitest\b/i,
];

/**
 * Check if a shell command looks like a test command.
 */
export function isTestCommand(command: string): boolean {
  return TEST_PATTERNS.some((p) => p.test(command));
}

/**
 * Update state after a tool result. Consecutive failures reset on any success.
 * A failed test command still counts as "the agent ran a test" — it resets
 * turnsSinceLastTest (so the agent isn't nagged to run tests it just ran)
 * while still incrementing consecutiveFailures (a failure is a failure).
 */
export function recordToolResult(
  state: ReminderState,
  toolName: string,
  command: string | undefined,
  failed: boolean,
): void {
  // A failed test is still a test run — reset the turns-since-test counter
  // so the agent isn't reminded to run tests it just executed (and failed).
  // Done before the early return below so failed tests also reset it.
  if (toolName === "bash" && command && isTestCommand(command)) {
    state.turnsSinceLastTest = 0;
  }

  if (failed) {
    state.consecutiveFailures++;
    return;
  }

  state.consecutiveFailures = 0;
}

/**
 * Combine reminders into one message so before_agent_start can inject current-turn context.
 */
export function formatReminderMessages(reminders: ReminderDefinition[]): string {
  return reminders.map((r) => `[Reminder: ${r.id}] ${r.message}`).join("\n");
}

// ── State persistence (survive restart / resume) ────────────────────────────
// Without persistence, `cooldowns` resets to empty on every pi restart or
// /resume, so a reminder that just fired (and was on a 5-turn cooldown) fires
// again immediately on the next turn — nag storm. We persist the durable
// counters (turnsSinceLastTest, consecutiveFailures, cooldowns) to a tiny
// project-local JSON file and rehydrate on session_start when reason is
// "resume" or "startup".
//
// uncommittedFileCount / currentTokenUsagePct are per-turn ephemeral (re-read
// each turn) so they are NOT persisted.

const STATE_RELATIVE_PATH = path.join(".pi", "reminders-state.json");

/** Project-local path for the persisted reminder state. */
export function stateFilePath(cwd: string): string {
  return path.join(cwd, STATE_RELATIVE_PATH);
}

/** Serialize the durable parts of state to a plain JSON object. */
export function serializeState(state: ReminderState): Record<string, unknown> {
  return {
    turnsSinceLastTest: state.turnsSinceLastTest,
    consecutiveFailures: state.consecutiveFailures,
    cooldowns: Object.fromEntries(state.cooldowns),
  };
}

/** Deserialize a previously persisted state object back into ReminderState.
 *  Falls back to initial state for any missing/invalid field. */
export function deserializeState(data: unknown): ReminderState {
  const s = createInitialState();
  if (!data || typeof data !== "object") return s;
  const d = data as Record<string, unknown>;
  if (typeof d.turnsSinceLastTest === "number") s.turnsSinceLastTest = d.turnsSinceLastTest;
  if (typeof d.consecutiveFailures === "number") s.consecutiveFailures = d.consecutiveFailures;
  if (d.cooldowns && typeof d.cooldowns === "object") {
    for (const [k, v] of Object.entries(d.cooldowns as Record<string, unknown>)) {
      if (typeof v === "number" && v > 0) s.cooldowns.set(k, v);
    }
  }
  return s;
}

/** Persist durable state to <cwd>/.pi/reminders-state.json (best-effort). */
export function persistState(cwd: string, state: ReminderState): void {
  try {
    const filePath = stateFilePath(cwd);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(serializeState(state)));
  } catch (err) {
    // ponytail: best-effort persistence; never break the agent turn over state IO
    console.error("[event-reminders] state persist failed:", err);
  }
}

/** Rehydrate durable state from disk, or return a fresh initial state. */
export function rehydrateState(cwd: string): ReminderState {
  try {
    const filePath = stateFilePath(cwd);
    if (!fs.existsSync(filePath)) return createInitialState();
    const raw = fs.readFileSync(filePath, "utf-8");
    return deserializeState(JSON.parse(raw));
  } catch {
    return createInitialState();
  }
}

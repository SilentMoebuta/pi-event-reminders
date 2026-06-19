import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  loadRemindersConfig,
  createInitialState,
  evaluateConditions,
  applyCooldowns,
  decrementCooldowns,
  recordToolResult,
  formatReminderMessages,
  persistState,
  rehydrateState,
  type ReminderState,
  type RemindersConfig,
} from "./reminders";

/**
 * Event-Reminders Extension
 *
 * Passive session-state monitoring with proactive reminders. Tracks test
 * frequency, uncommitted files, token usage, and consecutive failures, then
 * injects reminders (as steering hints) when thresholds are met.
 *
 * Design: "passive monitoring, active reminding" — no forced intervention.
 */
export default function (pi: ExtensionAPI) {
  let config: RemindersConfig = { reminders: [] };
  let state: ReminderState = createInitialState();

  // Load config fresh on each event (per-session, no module-level cache).
  const loadConfigFor = (ctx: ExtensionContext): RemindersConfig =>
    loadRemindersConfig(ctx.cwd);

  function isTrusted(ctx: ExtensionContext): boolean {
    const fn = (ctx as unknown as { isProjectTrusted?: () => boolean }).isProjectTrusted;
    return typeof fn === "function" ? fn.call(ctx) : true;
  }

  // Async (non-blocking) uncommitted-file count via the extension API.
  async function getUncommittedCount(ctx: ExtensionContext): Promise<number> {
    try {
      const result = await pi.exec("git", ["status", "--porcelain"], {
        cwd: ctx.cwd,
        timeout: 5000,
      });
      if (result.code !== 0) return 0;
      return result.stdout.trim().split("\n").filter(Boolean).length;
    } catch {
      return 0;
    }
  }

  // Read current token usage percentage from the context (not from a
  // provider request event, which does not expose token fields).
  function readTokenUsagePct(ctx: ExtensionContext): number {
    const fn = (ctx as unknown as { getContextUsage?: () => { percent: number | null } | undefined }).getContextUsage;
    if (typeof fn !== "function") return 0;
    const usage = fn.call(ctx);
    return usage?.percent ?? 0;
  }

  // ── session_start ──────────────────────────────────────────────────────

  pi.on("session_start", async (event, ctx) => {
    config = loadConfigFor(ctx);
    // Rehydrate durable state (cooldowns + counters) on restart/resume so a
    // reminder that just fired doesn't immediately fire again. Fresh state
    // for "new"/"fork"/"reload" sessions.
    if (event.reason === "resume" || event.reason === "startup") {
      state = rehydrateState(ctx.cwd);
    } else {
      state = createInitialState();
    }
    if (config.reminders.length > 0) {
      ctx.ui.notify(
        `event-reminders: ${config.reminders.length} reminders loaded`,
        "info",
      );
    }
  });

  // ── before_agent_start: evaluate and inject ────────────────────────────

  pi.on("before_agent_start", async (_event, ctx) => {
    config = loadConfigFor(ctx);

    state.turnsSinceLastTest++;
    state.uncommittedFileCount = await getUncommittedCount(ctx);
    state.currentTokenUsagePct = readTokenUsagePct(ctx);
    decrementCooldowns(state);

    const matched = evaluateConditions(state, config);
    applyCooldowns(state, matched);

    // Persist durable state once per turn so cooldowns survive restart/resume.
    persistState(ctx.cwd, state);

    if (matched.length > 0) {
      // Inject as a steering hint for the current turn (does NOT accumulate
      // in session history, unlike a persistent before_agent_start message).
      pi.sendMessage(
        {
          customType: "event-reminder",
          content: formatReminderMessages(matched),
          display: true,
        },
        { deliverAs: "steer" },
      );
    }
  });

  // ── tool_result: track test runs and failures ──────────────────────────

  pi.on("tool_result", async (event) => {
    const input = event.input as Record<string, unknown> | undefined;
    const command = typeof input?.command === "string" ? input.command : undefined;
    // Use the real isError field (not fabricated event.error/event.result).
    const failed = event.isError;
    recordToolResult(state, event.toolName, command, failed);
  });

  // Belt-and-suspenders: persist state on shutdown so a crash after the last
  // turn still captures the latest cooldowns.
  pi.on("session_shutdown", async (_event, ctx) => {
    persistState(ctx.cwd, state);
  });
}

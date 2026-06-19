declare module "@earendil-works/pi-coding-agent" {
  export interface UI {
    notify(message: string, level?: string): void;
  }

  export interface ExtensionContext {
    cwd: string;
    ui: UI;
  }

  export interface SessionStartEvent {
    reason: string;
  }

  export interface ToolResultEvent {
    toolName: string;
    input: Record<string, unknown>;
    isError: boolean;
  }

  export interface BeforeAgentStartEvent {
    // intentionally minimal
  }

  export interface ShutdownEvent {
    // intentionally minimal
  }

  export interface SendMessageOptions {
    deliverAs?: string;
  }

  export interface MessagePayload {
    customType: string;
    content: string;
    display: boolean;
  }

  export interface ExecResult {
    code: number;
    stdout: string;
    stderr: string;
  }

  export interface ExecOptions {
    cwd?: string;
    timeout?: number;
  }

  export interface ExtensionAPI {
    on(
      event: "session_start",
      cb: (event: SessionStartEvent, ctx: ExtensionContext) => void | Promise<void>,
    ): void;
    on(
      event: "before_agent_start",
      cb: (event: BeforeAgentStartEvent, ctx: ExtensionContext) => void | Promise<void>,
    ): void;
    on(
      event: "tool_result",
      cb: (event: ToolResultEvent) => void | Promise<void>,
    ): void;
    on(
      event: "session_shutdown",
      cb: (event: ShutdownEvent, ctx: ExtensionContext) => void | Promise<void>,
    ): void;

    sendMessage(payload: MessagePayload, options?: SendMessageOptions): void;
    exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;
  }
}

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { runHook, type HookInput } from "./hook.ts";

export default function roborev(pi: ExtensionAPI) {
  // This is only a recursive-Stop guard, not a reminder counter or fix owner.
  let stopHookActive = false;
  const reset = () => {
    stopHookActive = false;
  };
  pi.on("session_start", reset);
  pi.on("before_agent_start", reset);
  pi.on("agent_settled", reset);

  async function report(input: HookInput, ctx: ExtensionContext) {
    try {
      const response = await runHook(input, ctx.signal);
      if (response.diagnostic) warn(response.diagnostic, ctx);
      return response;
    } catch (error) {
      if (ctx.signal?.aborted) return;
      warn(error instanceof Error ? error.message : String(error), ctx);
      // A hook transport failure must not block a tool or force continuation.
      return;
    }
  }

  function warn(diagnostic: string, ctx: ExtensionContext) {
    const message = `roborev Pi hook: ${diagnostic}`;
    console.error(message);
    if (ctx.hasUI) ctx.ui.notify(message, "warning");
  }

  function common(ctx: ExtensionContext) {
    return {
      session_id: ctx.sessionManager.getSessionId(),
      transcript_path: ctx.sessionManager.getSessionFile(),
      cwd: ctx.cwd,
    };
  }

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;
    await report(
      {
        ...common(ctx),
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_use_id: event.toolCallId,
        tool_input: event.input,
      },
      ctx,
    );
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "bash") return;
    const response = await report(
      {
        ...common(ctx),
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_use_id: event.toolCallId,
        tool_input: event.input,
        tool_response: {
          content: event.content,
          is_error: event.isError,
          details: event.details,
          structured_content: event.structuredContent,
        },
      },
      ctx,
    );
    if (!response?.context) return;
    if (event.parentToolCallId) {
      // Nested results stay with the calling tool, not in the transcript.
      // Pi inserts context-only messages after the current tool batch.
      pi.sendMessage(
        {
          customType: "roborev-agent-hook",
          content: response.context,
          display: true,
        },
        { triggerTurn: false },
      );
      return;
    }
    // Keep the original result, including errors and machine-readable data.
    return {
      content: [
        ...event.content,
        { type: "text" as const, text: response.context },
      ],
      structuredContent: event.structuredContent,
    };
  });

  pi.on("agent_before_settle", async (event, ctx) => {
    // Automatic retries, user cancellation, and already-queued work are not Stops.
    if (
      event.outcome !== "completed" ||
      event.continue ||
      event.context.pendingMessages.length > 0
    )
      return;
    const response = await report(
      {
        ...common(ctx),
        hook_event_name: "Stop",
        turn_id: ctx.sessionManager.getLeafId() ?? undefined,
        stop_hook_active: stopHookActive,
      },
      ctx,
    );
    if (!response?.context) return;
    stopHookActive = true;
    return {
      entries: [
        ...event.entries,
        {
          type: "custom_message" as const,
          customType: "roborev-agent-hook",
          content: response.context,
          display: true,
        },
      ],
      continue: true,
    };
  });
}

import { spawn } from "node:child_process";

export interface HookInput {
  session_id: string;
  cwd: string;
  transcript_path?: string;
  hook_event_name: "PreToolUse" | "PostToolUse" | "Stop";
  turn_id?: string;
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  stop_hook_active?: boolean;
}

export interface HookOutput {
  context?: string;
  /** A diagnostic emitted on stderr, even when the Go callback fails open. */
  diagnostic?: string;
}

/** Keep daemon discovery, config resolution, and all reminder policy in Go. */
export async function runHook(
  input: HookInput,
  signal?: AbortSignal,
): Promise<HookOutput> {
  const output = await new Promise<{ stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(
        process.env.ROBOREV_PI_BINARY || "roborev",
        ["agent-hook", "run", "--agent", "pi", "--source=roborev-agent-hook"],
        { cwd: input.cwd, signal, stdio: ["pipe", "pipe", "pipe"] },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.stdin.on("error", reject);
      child.on("close", (code, exitSignal) => {
        if (code !== 0) {
          reject(
            new Error(
              `roborev hook exited ${code ?? exitSignal}: ${stderr.trim()}`,
            ),
          );
        } else {
          resolve({ stdout, stderr });
        }
      });
      child.stdin.end(JSON.stringify(input));
    },
  );
  const parsed: unknown = JSON.parse(output.stdout);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    ("context" in parsed && typeof parsed.context !== "string")
  ) {
    throw new Error("Invalid roborev Pi hook response");
  }
  return {
    context: "context" in parsed ? (parsed.context as string) : undefined,
    diagnostic: output.stderr.trim() || undefined,
  };
}

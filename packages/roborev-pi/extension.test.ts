import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DefaultResourceLoader,
  ExtensionRunner,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type BoundaryContextPreview,
  type ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
let temp: string;
let binary: string;
let server: Server;
let address: string;
let registry: ModelRegistry;
let requests: Array<{
  agent: string;
  threshold: number;
  commit_threshold: number;
  failed_review_threshold: number;
  instruction: string;
  event: Record<string, unknown>;
}>;
let response: Record<string, unknown>;
let status = 200;

beforeAll(async () => {
  temp = mkdtempSync(join(tmpdir(), "roborev-pi-test-"));
  binary = join(temp, process.platform === "win32" ? "roborev.exe" : "roborev");
  // Build only into a disposable directory, never PATH or the user's daemon.
  execFileSync("go", ["build", "-o", binary, "./cmd/roborev"], { cwd: root });
  registry = new ModelRegistry(
    await ModelRuntime.create({
      authPath: join(temp, "auth.json"),
      modelsPath: null,
      modelsStorePath: join(temp, "models"),
      refreshOnCreate: false,
    }),
  );
  server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    expect(req.url).toBe("/api/agent-hook/event");
    requests.push(JSON.parse(body));
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(response));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const bound = server.address();
  if (!bound || typeof bound === "string")
    throw new Error("Missing test server address");
  address = `127.0.0.1:${bound.port}`;
}, 120_000);

afterAll(async () => {
  if (server)
    await new Promise<void>((done, reject) =>
      server.close((err) => (err ? reject(err) : done())),
    );
  if (temp) rmSync(temp, { recursive: true, force: true });
});

beforeEach(() => {
  requests = [];
  response = {};
  status = 200;
  // Pi also scans ~/.agents/skills, independently of agentDir.
  vi.stubEnv("HOME", temp);
  vi.stubEnv("ROBOREV_PI_BINARY", binary);
  vi.stubEnv("ROBOREV_DATA_DIR", temp);
  vi.stubEnv("ROBOREV_AGENT_HOOK_ROBOREV_ADDR", address);
  vi.stubEnv("ROBOREV_AGENT_HOOK_TURN_THRESHOLD", "7");
  vi.stubEnv("ROBOREV_AGENT_HOOK_COMMIT_THRESHOLD", "2");
  vi.stubEnv("ROBOREV_AGENT_HOOK_FAILED_REVIEW_THRESHOLD", "3");
  vi.stubEnv(
    "ROBOREV_AGENT_HOOK_INSTRUCTION",
    "Audit only the supplied review IDs.",
  );
  writeFileSync(
    join(temp, "config.toml"),
    'fix_guidelines = "Verify each finding."\n',
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function load(
  manager = SessionManager.inMemory(temp),
  beforeExtension?: string,
) {
  const resources = new DefaultResourceLoader({
    cwd: temp,
    agentDir: join(temp, "pi"),
    settingsManager: SettingsManager.inMemory({ packages: [root] }),
    noContextFiles: true,
    noPromptTemplates: true,
    noThemes: true,
    additionalExtensionPaths: beforeExtension ? [beforeExtension] : [],
  });
  await resources.reload();
  const loaded = resources.getExtensions();
  expect(loaded.errors).toEqual([]);
  expect(loaded.extensions).toHaveLength(beforeExtension ? 2 : 1);
  expect(
    resources.getSkills().skills.find((skill) => skill.name === "roborev-fix")
      ?.filePath,
  ).toBe(join(root, "internal/skills/claude/roborev-fix/SKILL.md"));
  const runner = new ExtensionRunner(
    loaded.extensions,
    loaded.runtime,
    temp,
    manager,
    registry,
  );
  runner.onError((error) => {
    throw new Error(error.error);
  });
  return { runner, manager };
}

function preview(): BoundaryContextPreview {
  return {
    contextEntries: [],
    contextMessages: [],
    llmMessages: [],
    pendingMessages: [],
    canContinue: true,
  };
}

function settle(
  runner: ExtensionRunner,
  outcome: "completed" | "aborted" | "error" = "completed",
) {
  return runner.emitBoundary({ type: "agent_before_settle", outcome }, preview);
}

// Jiti loading plus real CLI subprocesses exceeded Vitest's 5s default while
// the repository-wide Go suite was running. These are external, not virtual-time operations.
describe(
  "Git package lifecycle through the real Pi loader and roborev CLI",
  { timeout: 30_000 },
  () => {
    it("records native shell events, thresholds, and failed results without replacing tool data", async () => {
      const { runner, manager } = await load();
      const input = { command: "git commit -m example" };
      expect(
        await runner.emitToolCall({
          type: "tool_call",
          toolName: "bash",
          toolCallId: "shell-1",
          input,
        }),
      ).toBeUndefined();
      const event: ToolResultEvent = {
        type: "tool_result",
        toolName: "bash",
        toolCallId: "shell-1",
        input,
        content: [{ type: "text", text: "Command failed after committing." }],
        details: { exitCode: 1 },
        structuredContent: { exit_code: 1 },
        isError: true,
      };
      response = { triggered: true, reason: "Inspect reviews 101 and 102." };
      const result = await runner.emitToolResult(event);
      expect(requests.map((req) => req.event.hook_event_name)).toEqual([
        "PreToolUse",
        "PostToolUse",
      ]);
      expect(requests[0]).toMatchObject({
        agent: "pi",
        threshold: 7,
        commit_threshold: 2,
        failed_review_threshold: 3,
        instruction: "Audit only the supplied review IDs.",
        event: {
          session_id: manager.getSessionId(),
          cwd: temp,
          tool_name: "Bash",
          tool_use_id: "shell-1",
          tool_input: input,
        },
      });
      expect(requests[1].event.tool_response).toMatchObject({
        is_error: true,
        structured_content: { exit_code: 1 },
      });
      expect(result?.content?.[0]).toEqual(event.content[0]);
      expect(result?.content?.[1]).toMatchObject({
        type: "text",
        text: expect.stringContaining("Verify each finding."),
      });
      expect(result?.structuredContent).toEqual(event.structuredContent);
      expect(result?.isError).toBe(true);
      expect(result?.details).toEqual(event.details);
    });

    it("ignores non-shell tools and records nested shell calls with their own IDs", async () => {
      const { runner } = await load();
      await runner.emitToolCall({
        type: "tool_call",
        toolName: "read",
        toolCallId: "read-1",
        input: { path: "file.go" },
      });
      await runner.emitToolResult({
        type: "tool_result",
        toolName: "write",
        toolCallId: "write-1",
        input: { path: "file.go", content: "test" },
        content: [],
        details: undefined,
        isError: false,
      });
      expect(requests).toEqual([]);
      await runner.emitToolCall({
        type: "tool_call",
        toolName: "bash",
        toolCallId: "script-1/0",
        parentToolCallId: "script-1",
        input: { command: "git status" },
      });
      expect(requests[0].event.tool_use_id).toBe("script-1/0");
    });

    it("continues a completed run with the exact fix completion command and guards recursive Stops", async () => {
      const { runner, manager } = await load();
      const fixID = "00000000-0000-4000-8000-000000000001";
      response = {
        triggered: true,
        reason: "Inspect reviews 101 and 102.",
        fix_session_id: fixID,
      };
      const first = await settle(runner);
      expect(first.continue).toBe(true);
      expect(first.entries).toEqual([
        {
          type: "custom_message",
          customType: "roborev-agent-hook",
          display: true,
          content: expect.stringContaining(
            `fix-done --roborev-server ${address} ${fixID}`,
          ),
        },
      ]);
      expect(first.entries[0]).toMatchObject({
        content: expect.stringContaining("Inspect reviews 101 and 102."),
      });
      expect(requests[0].event).toMatchObject({
        session_id: manager.getSessionId(),
        hook_event_name: "Stop",
        stop_hook_active: false,
      });
      response = {};
      expect((await settle(runner)).continue).toBe(false);
      expect(requests[1].event.stop_hook_active).toBe(true);
      await runner.emit({ type: "agent_settled" });
      await settle(runner);
      expect(requests[2].event.stop_hook_active).toBe(false);
    });

    it("preserves boundary entries proposed by an earlier extension", async () => {
      const earlier = join(temp, "earlier-extension.ts");
      writeFileSync(
        earlier,
        `export default function(pi) {
      pi.on("agent_before_settle", (event) => ({
        entries: [...event.entries, { type: "custom", customType: "other-extension", data: { retained: true } }],
      }));
    }`,
      );
      const { runner } = await load(undefined, earlier);
      response = { triggered: true, reason: "Inspect reviews 101 and 102." };
      const stopped = await settle(runner);
      expect(stopped.continue).toBe(true);
      expect(stopped.entries[0]).toEqual({
        type: "custom",
        customType: "other-extension",
        data: { retained: true },
      });
      expect(stopped.entries[1]).toMatchObject({
        type: "custom_message",
        customType: "roborev-agent-hook",
      });
    });

    it("keeps the session identity when the extension is reloaded or resumed", async () => {
      const { runner, manager } = await load();
      await settle(runner);
      const { runner: reloaded } = await load(manager);
      await settle(reloaded);
      expect(requests.map((req) => req.event.session_id)).toEqual([
        manager.getSessionId(),
        manager.getSessionId(),
      ]);
      const { runner: forked, manager: forkManager } = await load();
      await settle(forked);
      expect(requests[2].event.session_id).toBe(forkManager.getSessionId());
      expect(forkManager.getSessionId()).not.toBe(manager.getSessionId());
    });

    it("does not record aborted, failed, or already-queued continuations as Stops", async () => {
      const { runner } = await load();
      await settle(runner, "aborted");
      await settle(runner, "error");
      await runner.emitBoundary(
        { type: "agent_before_settle", outcome: "completed" },
        () => ({
          ...preview(),
          pendingMessages: [
            { role: "user", content: "More work", timestamp: 0 },
          ],
        }),
      );
      const earlier = join(temp, "continuing-extension.ts");
      writeFileSync(
        earlier,
        `export default function(pi) {
          pi.on("agent_before_settle", () => ({ continue: true }));
        }`,
      );
      const { runner: continuing } = await load(undefined, earlier);
      expect((await settle(continuing)).continue).toBe(true);
      expect(requests).toEqual([]);
    });

    it.each([
      "missing executable",
      "invalid config",
      "daemon error",
      "invalid daemon JSON",
    ])(
      "reports %s without blocking a shell tool or requesting continuation",
      async (failure) => {
        const { runner } = await load();
        const diagnostic = vi
          .spyOn(console, "error")
          .mockImplementation(() => {});
        const notify = vi.fn();
        runner.setUIContext({ ...runner.getUIContext(), notify }, "tui");
        if (failure === "missing executable")
          vi.stubEnv("ROBOREV_PI_BINARY", resolve(temp, "missing"));
        if (failure === "invalid config")
          writeFileSync(join(temp, "config.toml"), "invalid = [");
        if (failure === "daemon error") {
          status = 503;
          response = { error: "state unavailable" };
        }
        if (failure === "invalid daemon JSON")
          response = { triggered: "not-a-boolean" };
        expect(
          await runner.emitToolCall({
            type: "tool_call",
            toolName: "bash",
            toolCallId: "shell-1",
            input: { command: "git status" },
          }),
        ).toBeUndefined();
        const stopped = await settle(runner);
        expect(stopped.continue).toBe(false);
        expect(stopped.entries).toEqual([]);
        expect(diagnostic).toHaveBeenCalled();
        expect(notify).toHaveBeenCalledWith(
          expect.stringContaining("roborev"),
          "warning",
        );
      },
    );
  },
);

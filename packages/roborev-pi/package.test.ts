import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DefaultPackageManager,
  DefaultResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));

it("installs, loads, updates, pins, and removes the Git package using the documented Bun installer", async () => {
  const temp = mkdtempSync(join(tmpdir(), "roborev-pi-git-"));
  try {
    const repo = join(temp, "source");
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
    vi.stubEnv("GIT_CONFIG_GLOBAL", join(temp, "gitconfig"));
    const git = (args: string[], cwd = repo) =>
      execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    // Test what Git users receive: HEAD only, without staged, untracked, or
    // ignored resources from the developer's working tree.
    git(
      [
        "clone",
        "--no-local",
        "--single-branch",
        "--no-tags",
        "--depth=1",
        root,
        repo,
      ],
      temp,
    );
    // CI can provide a detached HEAD without any local branches. Give only
    // this disposable remote a default branch so Pi can test unpinned updates.
    git(["checkout", "-B", "main"]);
    git(["config", "user.name", "Test Author"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "core.hooksPath", join(temp, "empty-hooks")]);
    git(["tag", "v1"]);
    const pinnedCommit = git(["rev-parse", "HEAD"]);

    // Exercise the supported Git URL syntax with a local remote, never publishing.
    const source = "git:github.com/example/roborev-fixture";
    vi.stubEnv("GIT_CONFIG_COUNT", "1");
    vi.stubEnv("GIT_CONFIG_KEY_0", `url.file://${repo}.insteadOf`);
    vi.stubEnv(
      "GIT_CONFIG_VALUE_0",
      "https://github.com/example/roborev-fixture",
    );
    const agentDir = join(temp, "agent");
    const settings = SettingsManager.inMemory({ npmCommand: ["bun"] });
    const packages = new DefaultPackageManager({
      cwd: temp,
      agentDir,
      settingsManager: settings,
    });
    await packages.installAndPersist(source);

    const resources = new DefaultResourceLoader({
      cwd: temp,
      agentDir,
      settingsManager: settings,
      noContextFiles: true,
    });
    await resources.reload();
    expect(resources.getExtensions().errors).toEqual([]);
    expect(resources.getExtensions().extensions).toHaveLength(1);
    expect(
      resources
        .getSkills()
        .skills.some((skill) => skill.name === "roborev-fix"),
    ).toBe(true);
    const installed = packages.getInstalledPath(source, "user");
    expect(installed).toBeDefined();
    expect(git(["rev-parse", "HEAD"], installed)).toBe(pinnedCommit);

    git(["commit", "--allow-empty", "-m", "Next revision"]);
    const nextCommit = git(["rev-parse", "HEAD"]);
    await packages.update(source);
    expect(git(["rev-parse", "HEAD"], installed)).toBe(nextCommit);

    expect(await packages.removeAndPersist(source)).toBe(true);
    expect(packages.listConfiguredPackages()).toEqual([]);
    await packages.installAndPersist(source + "@v1");
    await packages.update(source + "@v1");
    expect(
      git(
        ["rev-parse", "HEAD"],
        packages.getInstalledPath(source + "@v1", "user"),
      ),
    ).toBe(pinnedCommit);
    expect(await packages.removeAndPersist(source + "@v1")).toBe(true);
    expect(packages.listConfiguredPackages()).toEqual([]);
  } finally {
    vi.unstubAllEnvs();
    rmSync(temp, { recursive: true, force: true });
  }
  // Real git and Bun subprocesses may need to fetch uncached dependencies.
}, 120_000);

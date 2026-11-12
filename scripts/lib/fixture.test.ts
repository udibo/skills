import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { fileBlocks, filePathProblems, packageBin, packagePins, pinProblems, runShell, shellCommands, startProcess } from "./fixture.ts";
import type { SkillDocument } from "./fixture.ts";
import { tempDir } from "./testing.ts";

async function fakePackage(root: string, name: string, manifest: Record<string, unknown>): Promise<void> {
  const dir = path.join(root, "node_modules", name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ name, ...manifest }));
}

function documentOf(markdown: string, targets: SkillDocument["targets"] = []): SkillDocument {
  return { name: "udibo-test", targets, commands: shellCommands(markdown), files: fileBlocks(markdown) };
}

describe("shellCommands", () => {
  test("returns each command in a shell block with its starting line", () => {
    const markdown = "# T\n\n```sh\nnpm init -y\n\n# a comment\nnpm pkg set type=module\n```\n";
    expect(shellCommands(markdown)).toEqual([
      { text: "npm init -y", line: 4 },
      { text: "npm pkg set type=module", line: 7 },
    ]);
  });

  test("joins backslash continuations and drops a prompt marker", () => {
    expect(shellCommands("```bash\n$ npx --package=x@1.0.0 \\\n  x run\n```\n")).toEqual([{ text: "npx --package=x@1.0.0 x run", line: 2 }]);
  });

  test("reads a block indented under a list item", () => {
    expect(shellCommands("1. Check:\n\n   ```sh\n   node --version\n   ```\n")).toEqual([{ text: "node --version", line: 4 }]);
  });

  test("ignores blocks in other languages", () => {
    expect(shellCommands("```ts\nconst x = 1;\n```\n```ini\nA=b\n```\n")).toEqual([]);
  });
});

describe("fileBlocks", () => {
  test("returns titled blocks with their contents, indentation removed", () => {
    expect(fileBlocks('```ts title="app.ts"\nexport {};\n```\n\n- Edit:\n\n  ```ini title=".env.example"\n  A=\n  ```\n')).toEqual([
      { path: "app.ts", contents: "export {};\n", line: 1 },
      { path: ".env.example", contents: "A=\n", line: 7 },
    ]);
  });

  test("skips untitled blocks", () => {
    expect(fileBlocks("```ts\nexport {};\n```\n")).toEqual([]);
  });
});

describe("packagePins", () => {
  test.each([
    ["npm install --save-exact a@1.2.3 @s/b@0.1.0", ["a@1.2.3", "@s/b@0.1.0"]],
    ["pnpm add -D a@1.2.3", ["a@1.2.3"]],
    ["npx --package=@s/b@0.1.0 b-cli run", ["@s/b@0.1.0"]],
    ["npx -p @s/b@0.1.0 b-cli run", ["@s/b@0.1.0"]],
    ["npx --yes create-x@2.0.0 my-app", ["create-x@2.0.0"]],
    ["npm install a@^1.2.3", []],
    ["npm pkg set type=module", []],
  ])("reads %s", (text, expected) => {
    expect(packagePins({ text, line: 1 }).map((pin) => `${pin.name}@${pin.version}`)).toEqual(expected);
  });
});

describe("pinProblems", () => {
  test("accepts a pin installed at its version and named in the targets", async () => {
    await using root = await tempDir();
    await fakePackage(root.path, "a", { version: "1.2.3" });
    const document = documentOf("```sh\nnpm install a@1.2.3\n```\n", [{ target: "a", range: "1.2.3" }]);
    expect(await pinProblems(root.path, document)).toEqual([]);
  });

  test("reports a pin installed at another version, missing, or absent from the targets", async () => {
    await using root = await tempDir();
    await fakePackage(root.path, "a", { version: "1.2.4" });
    const document = documentOf("```sh\nnpm install a@1.2.3 b@2.0.0\n```\n", [{ target: "a", range: "1.2.4" }]);
    expect(await pinProblems(root.path, document)).toEqual([
      "udibo-test/SKILL.md:2: pins a@1.2.3 but this repository has 1.2.4; add it with pnpm add -D --save-exact a@1.2.3",
      "udibo-test/SKILL.md:2: pins a@1.2.3 but metadata.targets names a@1.2.4",
      "udibo-test/SKILL.md:2: pins b@2.0.0 but this repository has no copy; add it with pnpm add -D --save-exact b@2.0.0",
      "udibo-test/SKILL.md:2: b is pinned but missing from metadata.targets",
    ]);
  });

  test("accepts a target given as a range", async () => {
    await using root = await tempDir();
    await fakePackage(root.path, "a", { version: "1.2.3" });
    const document = documentOf("```sh\nnpm install a@1.2.3\n```\n", [{ target: "a", range: ">=1.0.0 <2.0.0" }]);
    expect(await pinProblems(root.path, document)).toEqual([]);
  });
});

describe("filePathProblems", () => {
  test.each(["../outside.ts", "/etc/hosts", "a/../../b.ts", "a\\b.ts"])("rejects %s", (file) => {
    expect(filePathProblems(documentOf(`\`\`\`ts title="${file}"\nx\n\`\`\`\n`))).toHaveLength(1);
  });

  test("accepts a nested relative path", () => {
    expect(filePathProblems(documentOf('```ts title="src/app.ts"\nx\n```\n'))).toEqual([]);
  });
});

describe("packageBin", () => {
  test("resolves a named executable and a package's single executable", async () => {
    await using root = await tempDir();
    await fakePackage(root.path, "@s/b", { version: "1.0.0", bin: { "b-cli": "./cli.js" } });
    await fakePackage(root.path, "c", { version: "1.0.0", bin: "./c.js" });
    expect(await packageBin(root.path, "@s/b", "b-cli")).toBe(path.join(root.path, "node_modules", "@s/b", "cli.js"));
    expect(await packageBin(root.path, "c", "c")).toBe(path.join(root.path, "node_modules", "c", "c.js"));
    await expect(packageBin(root.path, "@s/b", "other")).rejects.toThrow('@s/b has no "other" executable');
  });
});

describe("processes", () => {
  test("runShell returns stdout and rejects a failing command", async () => {
    await using dir = await tempDir();
    expect(await runShell("echo hello", dir.path)).toBe("hello\n");
    await expect(runShell("exit 3", dir.path)).rejects.toThrow();
  });

  test("startProcess resolves once ready and stops the process on dispose", async () => {
    await using dir = await tempDir();
    const script = "console.log('ready'); setInterval(() => {}, 1000);";
    const running = await startProcess(process.execPath, ["-e", script], { cwd: dir.path, ready: (stdout) => stdout.includes("ready") });
    expect(running.stdout()).toBe("ready\n");
    await running[Symbol.asyncDispose]();
    expect(running.child.signalCode).toBe("SIGTERM");
  });

  test("startProcess rejects when the process exits before it is ready", async () => {
    await using dir = await tempDir();
    await expect(
      startProcess(process.execPath, ["-e", "console.error('boom'); process.exit(2)"], { cwd: dir.path, ready: () => false }),
    ).rejects.toThrow(/exited with 2 before it was ready\n[\s\S]*boom/);
  });

  test("startProcess rejects and stops a process that is never ready", async () => {
    await using dir = await tempDir();
    await expect(
      startProcess(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { cwd: dir.path, ready: () => false, timeoutMs: 200 }),
    ).rejects.toThrow("not ready after 200 ms");
  });
});

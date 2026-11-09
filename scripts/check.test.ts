import { appendFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test, vi } from "vitest";

import { build } from "./build.ts";
import { check, main } from "./check.ts";
import { verifyDist } from "./lib/verify.ts";
import { copyPlaceholders, FIXTURES, tempDir } from "./lib/testing.ts";

const REPOSITORY = path.resolve(import.meta.dirname, "..");
const INDEX = ".well-known/agent-skills/index.json";

async function builtPlaceholders(root: string): Promise<string> {
  const outDir = path.join(root, "dist");
  const result = await build({ skillsDir: await copyPlaceholders(root), outDir, rules: {} });
  expect(result.issues).toEqual([]);
  return outDir;
}

async function editIndex(distDir: string, edit: (index: { skills: Record<string, unknown>[] } & Record<string, unknown>) => void): Promise<void> {
  const file = path.join(distDir, INDEX);
  const index = JSON.parse(await readFile(file, "utf8"));
  edit(index);
  await writeFile(file, JSON.stringify(index));
}

describe("verifyDist", () => {
  test("accepts a fresh build of the placeholders", async () => {
    await using dir = await tempDir();
    expect(await verifyDist(await builtPlaceholders(dir.path))).toEqual([]);
  });

  test("rejects an artifact whose bytes no longer match its digest", async () => {
    await using dir = await tempDir();
    const distDir = await builtPlaceholders(dir.path);
    await appendFile(path.join(distDir, ".well-known/agent-skills/placeholder-migration/SKILL.md"), "\nInjected line.\n");
    const problems = await verifyDist(distDir);
    expect(problems).toHaveLength(2);
    expect(problems[1]).toBe("plugin-marketplace/plugins/udibo/skills/placeholder-migration/SKILL.md: not part of any indexed skill");
    expect(problems[0]).toMatch(
      /^\.well-known\/agent-skills\/index\.json: placeholder-migration: digest sha256:[0-9a-f]{64} does not match the artifact's sha256:[0-9a-f]{64}$/,
    );
  });

  test("rejects an archive whose bytes no longer match its digest", async () => {
    await using dir = await tempDir();
    const distDir = await builtPlaceholders(dir.path);
    await appendFile(path.join(distDir, ".well-known/agent-skills/placeholder-existing-project.tar.gz"), Buffer.from([0]));
    expect((await verifyDist(distDir)).join("\n")).toContain("placeholder-existing-project: digest");
  });

  test("rejects an index that breaks the discovery schema", async () => {
    await using dir = await tempDir();
    const distDir = await builtPlaceholders(dir.path);
    await editIndex(distDir, (index) => {
      index["$schema"] = "https://schemas.agentskills.io/discovery/0.1.0/schema.json";
      index.skills[0]!["digest"] = "sha256:ABC";
      delete index.skills[1]!["type"];
    });
    expect(await verifyDist(distDir)).toEqual([
      `${INDEX}: /$schema must be equal to constant`,
      `${INDEX}: /skills/0/digest must match pattern "^sha256:[0-9a-f]{64}$"`,
      `${INDEX}: /skills/1 must have required property 'type'`,
    ]);
  });

  test("rejects a missing index", async () => {
    await using dir = await tempDir();
    const problems = await verifyDist(dir.path);
    expect(problems[0]).toMatch(/^\.well-known\/agent-skills\/index\.json: cannot read the index/);
  });

  test("rejects an index description that differs from SKILL.md", async () => {
    await using dir = await tempDir();
    const distDir = await builtPlaceholders(dir.path);
    await editIndex(distDir, (index) => {
      index.skills[1]!["description"] = "Something else.";
    });
    expect(await verifyDist(distDir)).toEqual([`${INDEX}: placeholder-migration: SKILL.md description differs from the index`]);
  });

  test("rejects a missing artifact, a remote url and an unlisted file", async () => {
    await using dir = await tempDir();
    const distDir = await builtPlaceholders(dir.path);
    await rm(path.join(distDir, ".well-known/agent-skills/placeholder-new-project/SKILL.md"));
    await writeFile(path.join(distDir, ".well-known/agent-skills/stray.md"), "stray");
    await editIndex(distDir, (index) => {
      index.skills[1]!["url"] = "https://cdn.example.com/SKILL.md";
    });
    const problems = await verifyDist(distDir);
    expect(problems).toEqual(
      expect.arrayContaining([
        `${INDEX}: placeholder-migration: url https://cdn.example.com/SKILL.md is not a local path this check can verify`,
        `${INDEX}: placeholder-new-project: artifact /.well-known/agent-skills/placeholder-new-project/SKILL.md does not exist`,
        ".well-known/agent-skills/stray.md: not listed in the index",
      ]),
    );
  });

  test("rejects a plugin copy that differs from the indexed artifact", async () => {
    await using dir = await tempDir();
    const distDir = await builtPlaceholders(dir.path);
    await appendFile(path.join(distDir, "plugin-marketplace/plugins/udibo/skills/placeholder-new-project/SKILL.md"), "extra\n");
    expect(await verifyDist(distDir)).toEqual([
      "plugin-marketplace/plugins/udibo/skills/placeholder-new-project/SKILL.md: differs from the indexed artifact",
    ]);
  });

  test("rejects a marketplace that does not list the plugin", async () => {
    await using dir = await tempDir();
    const distDir = await builtPlaceholders(dir.path);
    const file = path.join(distDir, "plugin-marketplace/.cursor-plugin/marketplace.json");
    const manifest = JSON.parse(await readFile(file, "utf8"));
    manifest.plugins = [];
    await writeFile(file, JSON.stringify(manifest));
    expect(await verifyDist(distDir)).toEqual([
      'plugin-marketplace/.cursor-plugin/marketplace.json: plugins [] should be [{"name":"udibo","source":"plugins/udibo"}]',
    ]);
  });
});

describe("check", () => {
  test("passes over the placeholder fixtures and this repository's workflows", async () => {
    await using dir = await tempDir();
    const problems = await check({
      sources: { skillsDir: await copyPlaceholders(dir.path), rules: {} },
      workflowsDir: path.join(REPOSITORY, ".github", "workflows"),
    });
    expect(problems).toEqual([]);
  });

  test("fails on the unsafe fixture with a message per finding", async () => {
    const problems = await check({ sources: { skillsDir: path.join(FIXTURES, "unsafe-skills"), rules: {} } });
    expect(problems).toEqual([
      "unsafe-example/SKILL.md:11: [secret-in-conversation] asks for a secret to be handed over or shown; secrets stay in files or a secret store the agent never reads back",
      "unsafe-example/SKILL.md:14: [unpinned-or-piped-code] pipes a download into an interpreter",
      "unsafe-example/SKILL.md:15: [unpinned-or-piped-code] runs a package fetched at run time without an exact version: create-example-app",
      "unsafe-example/SKILL.md:16: [secret-in-conversation] prints a secret-bearing variable into the session",
      "unsafe-example/SKILL.md:19: [unpinned-or-piped-code] installs a package without an exact version: @udibo/oauth2",
      "unsafe-example/SKILL.md:19: [unfenced-command] command `pnpm add @udibo/oauth2` is in inline code; put commands the agent runs in a fenced block",
    ]);
  });

  test("verifies an existing build when given one", async () => {
    await using dir = await tempDir();
    const distDir = await builtPlaceholders(dir.path);
    await appendFile(path.join(distDir, ".well-known/agent-skills/placeholder-migration/SKILL.md"), "x");
    const problems = await check({ sources: { skillsDir: path.join(dir.path, "empty") }, distDir });
    expect(problems.join("\n")).toMatch(/^dist: .*placeholder-migration: digest/);
  });
});

describe("main", () => {
  async function checkout(root: string): Promise<void> {
    await mkdir(path.join(root, "skills"));
    await writeFile(path.join(root, "external-skills.json"), '{ "skills": [] }\n');
    await cp(path.join(REPOSITORY, ".github"), path.join(root, ".github"), { recursive: true });
  }

  test("passes on a clean checkout and verifies --dist", async () => {
    await using dir = await tempDir();
    await checkout(dir.path);
    await build({ skillsDir: path.join(dir.path, "skills"), outDir: path.join(dir.path, "dist") });
    using log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await main(["--dist", "dist"], dir.path)).toBe(0);
    expect(log).toHaveBeenCalledWith("All checks passed.");
  });

  test("fails with each problem printed", async () => {
    await using dir = await tempDir();
    await checkout(dir.path);
    await appendFile(path.join(dir.path, ".github/workflows/ci.yml"), "\n# runs-on: self-hosted\n");
    using error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await main([], dir.path)).toBe(1);
    expect(error).toHaveBeenCalledWith("ci.yml: names a self-hosted runner");
    expect(error).toHaveBeenCalledWith("1 problem(s) found.");
  });

  test("rejects --dist without a directory", async () => {
    using error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await main(["--dist"], REPOSITORY)).toBe(2);
    expect(error).toHaveBeenCalledWith("--dist needs a directory");
  });
});

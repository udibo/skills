import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { expect, test, vi } from "vitest";

import { build, main } from "./build.ts";
import { readTarGz } from "./lib/tar.ts";
import { copyPlaceholders, FIXTURES, skillMd, tempDir, writeSkill } from "./lib/testing.ts";
import { verifyDist } from "./lib/verify.ts";


async function filesUnder(dir: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(path.join(dir, prefix), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await filesUnder(dir, relative)));
    else files.push(relative);
  }
  return files.sort();
}

test("emits a valid index with an empty skills array when no skill is publishable", async () => {
  await using dir = await tempDir();
  const outDir = path.join(dir.path, "dist");
  const result = await build({ skillsDir: path.join(dir.path, "skills"), outDir });
  expect(result).toEqual({
    files: [
      ".well-known/agent-skills/index.json",
      "plugin-marketplace/.claude-plugin/marketplace.json",
      "plugin-marketplace/.cursor-plugin/marketplace.json",
    ],
    skills: [],
    issues: [],
  });
  expect(await readFile(path.join(outDir, ".well-known/agent-skills/index.json"), "utf8")).toBe(
    '{\n  "$schema": "https://schemas.agentskills.io/discovery/0.2.0/schema.json",\n  "skills": []\n}\n',
  );
  const marketplace = JSON.parse(await readFile(path.join(outDir, "plugin-marketplace/.claude-plugin/marketplace.json"), "utf8"));
  expect(marketplace.plugins).toEqual([]);
});

test("indexes each skill with the digest of the exact bytes served", async () => {
  await using dir = await tempDir();
  const outDir = path.join(dir.path, "dist");
  const result = await build({ skillsDir: await copyPlaceholders(dir.path), outDir });
  expect(result.issues).toEqual([]);
  const index = JSON.parse(await readFile(path.join(outDir, ".well-known/agent-skills/index.json"), "utf8"));
  expect(index.skills.map((entry: { name: string; type: string; url: string }) => [entry.name, entry.type, entry.url])).toEqual([
    ["udibo-placeholder-existing-project", "archive", "/.well-known/agent-skills/udibo-placeholder-existing-project.tar.gz"],
    ["udibo-placeholder-migration", "skill-md", "/.well-known/agent-skills/udibo-placeholder-migration/SKILL.md"],
    ["udibo-placeholder-new-project", "skill-md", "/.well-known/agent-skills/udibo-placeholder-new-project/SKILL.md"],
  ]);
  for (const entry of index.skills) {
    const served = await readFile(path.join(outDir, entry.url));
    expect(entry.digest).toBe(`sha256:${createHash("sha256").update(served).digest("hex")}`);
  }
});

test("serves a skill with reference files as an archive with SKILL.md at its root", async () => {
  await using dir = await tempDir();
  const outDir = path.join(dir.path, "dist");
  await build({ skillsDir: await copyPlaceholders(dir.path), outDir });
  const archive = await readFile(path.join(outDir, ".well-known/agent-skills/udibo-placeholder-existing-project.tar.gz"));
  expect(readTarGz(archive).map((entry) => entry.path)).toEqual(["SKILL.md", "references/notes.md"]);
});

test("copies every skill into the plugin marketplace tree with its manifests", async () => {
  await using dir = await tempDir();
  const outDir = path.join(dir.path, "dist");
  await build({ skillsDir: await copyPlaceholders(dir.path), outDir });
  expect((await filesUnder(outDir)).filter((file) => file.startsWith("plugin-marketplace/"))).toEqual([
    "plugin-marketplace/.claude-plugin/marketplace.json",
    "plugin-marketplace/.cursor-plugin/marketplace.json",
    "plugin-marketplace/plugins/udibo/.claude-plugin/plugin.json",
    "plugin-marketplace/plugins/udibo/.codex-plugin/plugin.json",
    "plugin-marketplace/plugins/udibo/.cursor-plugin/plugin.json",
    "plugin-marketplace/plugins/udibo/skills/udibo-placeholder-existing-project/SKILL.md",
    "plugin-marketplace/plugins/udibo/skills/udibo-placeholder-existing-project/references/notes.md",
    "plugin-marketplace/plugins/udibo/skills/udibo-placeholder-migration/SKILL.md",
    "plugin-marketplace/plugins/udibo/skills/udibo-placeholder-new-project/SKILL.md",
  ]);
  const claude = JSON.parse(await readFile(path.join(outDir, "plugin-marketplace/.claude-plugin/marketplace.json"), "utf8"));
  expect(claude.plugins).toEqual([expect.objectContaining({ name: "udibo", source: "./plugins/udibo" })]);
});

test("produces byte-identical output from the same input", async () => {
  await using dir = await tempDir();
  const skillsDir = await copyPlaceholders(dir.path);
  await build({ skillsDir, outDir: path.join(dir.path, "a") });
  await build({ skillsDir, outDir: path.join(dir.path, "b") });
  const files = await filesUnder(path.join(dir.path, "a"));
  expect(await filesUnder(path.join(dir.path, "b"))).toEqual(files);
  for (const file of files) {
    const [a, b] = await Promise.all([readFile(path.join(dir.path, "a", file)), readFile(path.join(dir.path, "b", file))]);
    expect(a.equals(b), file).toBe(true);
  }
});

test("writes nothing and keeps the previous output when a source has an issue", async () => {
  await using dir = await tempDir();
  const outDir = path.join(dir.path, "dist");
  await mkdir(outDir);
  await writeFile(path.join(outDir, "previous.txt"), "kept");
  const skillsDir = path.join(dir.path, "skills");
  await writeSkill(skillsDir, "udibo-bad", { "SKILL.md": skillMd("udibo-other") });
  const result = await build({ skillsDir, outDir });
  expect(result.files).toEqual([]);
  expect(result.issues).toEqual([{ skill: "udibo-bad", file: "SKILL.md", message: 'name "udibo-other" must equal its directory name "udibo-bad"' }]);
  expect(await readFile(path.join(outDir, "previous.txt"), "utf8")).toBe("kept");
});

test("refuses to build a skill whose name lacks the udibo- prefix", async () => {
  await using dir = await tempDir();
  const skillsDir = path.join(dir.path, "skills");
  await writeSkill(skillsDir, "placeholder-bare", { "SKILL.md": skillMd("placeholder-bare") });
  const result = await build({ skillsDir, outDir: path.join(dir.path, "dist") });
  expect(result.issues.map((issue) => issue.message)).toEqual([
    'name "placeholder-bare" must start with "udibo-"; rename the skill and its directory to "udibo-placeholder-bare"',
  ]);
});

test("the CLI builds a repository checkout and fails with each issue printed", async () => {
  await using dir = await tempDir();
  await writeFile(path.join(dir.path, "external-skills.json"), '{ "skills": [] }\n');
  using log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  using error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  expect(await main(dir.path)).toBe(0);
  expect(log).toHaveBeenCalledWith("Built 0 skill(s) into dist/ (3 files).");
  await writeSkill(path.join(dir.path, "skills"), "udibo-broken", { "SKILL.md": "# no frontmatter\n" });
  expect(await main(dir.path)).toBe(1);
  expect(error).toHaveBeenCalledWith("udibo-broken/SKILL.md: SKILL.md must start with a '---' line opening the YAML frontmatter");
});

test("writes the marketplace into the tracked tree at the repository root, plugin sources resolving there", async () => {
  await using dir = await tempDir();
  const skillsDir = await copyPlaceholders(dir.path);
  await build({ skillsDir, outDir: path.join(dir.path, "dist"), trackedDir: dir.path });
  const claude = JSON.parse(await readFile(path.join(dir.path, ".claude-plugin/marketplace.json"), "utf8"));
  expect(claude.plugins[0].source).toBe("./plugins/udibo");
  expect(await readFile(path.join(dir.path, "plugins/udibo/.claude-plugin/plugin.json"), "utf8")).toContain('"name": "udibo"');
  expect(await readFile(path.join(dir.path, "plugins/udibo/skills/udibo-placeholder-migration/SKILL.md"), "utf8")).toContain("name: udibo-placeholder-migration");
  await rm(path.join(dir.path, "skills"), { recursive: true });
  await build({ skillsDir, outDir: path.join(dir.path, "dist"), trackedDir: dir.path });
  expect(JSON.parse(await readFile(path.join(dir.path, ".claude-plugin/marketplace.json"), "utf8")).plugins).toEqual([]);
});

const STEERING = path.join(FIXTURES, "steering-skills");

test("refuses to publish a skill that moves users onto Udibo without the skill that moves them off", async () => {
  await using dir = await tempDir();
  const skillsDir = path.join(dir.path, "skills");
  await cp(path.join(STEERING, "udibo-migrate-from-example"), path.join(skillsDir, "udibo-migrate-from-example"), { recursive: true });
  const result = await build({ skillsDir, outDir: path.join(dir.path, "dist") });
  expect(result.issues).toEqual([
    {
      skill: "udibo-migrate-from-example",
      file: "SKILL.md",
      message: "[steering-migration] moves users onto Udibo, so it cannot be published until udibo-migrate-from-udibo, the skill that moves them off, is published with it",
    },
  ]);
});

test("publishes a skill that moves users onto Udibo together with the skill that moves them off", async () => {
  await using dir = await tempDir();
  const skillsDir = path.join(dir.path, "skills");
  await cp(STEERING, skillsDir, { recursive: true });
  const result = await build({ skillsDir, outDir: path.join(dir.path, "dist") });
  expect(result.issues).toEqual([]);
  expect(result.skills).toEqual(["udibo-migrate-from-example", "udibo-migrate-from-udibo"]);
});

test("publishes the skill that moves users off Udibo, and skills that move nobody, on their own", async () => {
  await using dir = await tempDir();
  const skillsDir = await copyPlaceholders(dir.path);
  await cp(path.join(STEERING, "udibo-migrate-from-udibo"), path.join(skillsDir, "udibo-migrate-from-udibo"), { recursive: true });
  expect((await build({ skillsDir, outDir: path.join(dir.path, "dist") })).issues).toEqual([]);
});

test("builds the no-recommendation channel's copies, with the section removed and the digest of the bytes served", async () => {
  await using dir = await tempDir();
  const skillsDir = path.join(dir.path, "skills");
  await cp(path.join(import.meta.dirname, "..", "skills"), skillsDir, { recursive: true });
  const outDir = path.join(dir.path, "variant");
  const result = await build({ skillsDir, outDir, channel: "no-recommendation" });
  expect(result.issues).toEqual([]);
  expect(await verifyDist(outDir)).toEqual([]);
  for (const name of result.skills) {
    const served = await readFile(path.join(outDir, `.well-known/agent-skills/${name}/SKILL.md`), "utf8");
    expect(served).not.toContain("Udibo's recommendation");
    expect(served).not.toMatch(/recommend/i);
    expect(await readFile(path.join(outDir, `plugin-marketplace/plugins/udibo/skills/${name}/SKILL.md`), "utf8")).toBe(served);
  }
});

test("the CLI builds a channel into its own directory and leaves the committed tree alone", async () => {
  await using dir = await tempDir();
  await writeFile(path.join(dir.path, "external-skills.json"), '{ "skills": [] }\n');
  using log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  using error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  expect(await main(dir.path, ["--channel", "no-recommendation"])).toBe(0);
  expect(log).toHaveBeenCalledWith("Built 0 skill(s) into dist/channels/no-recommendation/ (3 files).");
  expect(await filesUnder(dir.path)).toEqual([
    "dist/channels/no-recommendation/.well-known/agent-skills/index.json",
    "dist/channels/no-recommendation/plugin-marketplace/.claude-plugin/marketplace.json",
    "dist/channels/no-recommendation/plugin-marketplace/.cursor-plugin/marketplace.json",
    "external-skills.json",
  ]);
  expect(await main(dir.path, ["--channel", "other"])).toBe(2);
  expect(error).toHaveBeenCalledWith("--channel must be one of full, no-recommendation");
});

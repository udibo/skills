import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { Ajv2020 } from "ajv/dist/2020.js";

import { parseFrontmatter } from "./frontmatter.ts";
import { INDEX_PATH, MARKETPLACE_DIR, PLUGIN_DIR, PLUGIN_NAME, sha256Digest } from "./outputs.ts";
import type { IndexEntry } from "./outputs.ts";
import { compare } from "./skill.ts";
import { readTarGz } from "./tar.ts";

const SCHEMA_FILE = new URL("../../schemas/agent-skills-discovery-0.2.0.schema.json", import.meta.url);
const SKILLS_DIR = ".well-known/agent-skills";
const MANIFEST_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Verifies a built `dist/` directory: the index validates against the vendored
 * discovery schema, every artifact it names exists locally with a matching
 * SHA-256 digest and a SKILL.md that agrees with its entry, no artifact is
 * unlisted, and the plugin marketplace lists exactly the indexed skills.
 * Returns one message per problem; an empty list means the build is sound.
 */
export async function verifyDist(distDir: string): Promise<string[]> {
  const problems: string[] = [];
  let index: unknown;
  try {
    index = JSON.parse(await readFile(path.join(distDir, INDEX_PATH), "utf8"));
  } catch (error) {
    return [`${INDEX_PATH}: cannot read the index: ${(error as Error).message}`];
  }
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate = ajv.compile(JSON.parse(await readFile(SCHEMA_FILE, "utf8")) as object);
  if (!validate(index)) {
    for (const error of validate.errors ?? []) {
      problems.push(`${INDEX_PATH}: ${error.instancePath || "/"} ${error.message ?? "is invalid"}`);
    }
    return problems;
  }
  const entries = (index as { skills: IndexEntry[] }).skills;
  const names = entries.map((entry) => entry.name);
  for (const duplicate of names.filter((name, position) => names.indexOf(name) !== position)) {
    problems.push(`${INDEX_PATH}: skill "${duplicate}" is listed more than once`);
  }

  const referenced = new Set<string>([INDEX_PATH]);
  const artifacts = new Map<string, Map<string, Buffer>>();
  for (const entry of entries) {
    const where = `${INDEX_PATH}: ${entry.name}`;
    const local = localPath(entry.url);
    if (local === undefined) {
      problems.push(`${where}: url ${entry.url} is not a local path this check can verify`);
      continue;
    }
    referenced.add(local);
    let bytes: Buffer;
    try {
      bytes = await readFile(path.join(distDir, local));
    } catch {
      problems.push(`${where}: artifact ${entry.url} does not exist`);
      continue;
    }
    const actual = sha256Digest(bytes);
    if (actual !== entry.digest) {
      problems.push(`${where}: digest ${entry.digest} does not match the artifact's ${actual}`);
      continue;
    }
    let files: Map<string, Buffer>;
    try {
      files = entry.type === "skill-md" ? new Map([["SKILL.md", bytes]]) : archiveFiles(bytes);
    } catch (error) {
      problems.push(`${where}: ${(error as Error).message}`);
      continue;
    }
    if (entry.type === "skill-md" && !local.endsWith("/SKILL.md")) problems.push(`${where}: a skill-md url must end in /SKILL.md`);
    if (entry.type === "archive" && !local.endsWith(".tar.gz")) problems.push(`${where}: an archive url must end in .tar.gz`);
    const skillMd = files.get("SKILL.md");
    if (!skillMd) {
      problems.push(`${where}: the artifact has no SKILL.md at its root`);
      continue;
    }
    try {
      const { data } = parseFrontmatter(skillMd.toString("utf8"));
      if (data["name"] !== entry.name) problems.push(`${where}: SKILL.md name "${String(data["name"])}" differs from the index`);
      if (data["description"] !== entry.description) problems.push(`${where}: SKILL.md description differs from the index`);
    } catch (error) {
      problems.push(`${where}: SKILL.md ${(error as Error).message}`);
    }
    artifacts.set(entry.name, files);
  }

  for (const file of await listFiles(path.join(distDir, SKILLS_DIR))) {
    const relative = `${SKILLS_DIR}/${file}`;
    if (!referenced.has(relative)) problems.push(`${relative}: not listed in the index`);
  }

  problems.push(...(await verifyMarketplace(distDir, artifacts)));
  return problems;
}

async function verifyMarketplace(distDir: string, artifacts: Map<string, Map<string, Buffer>>): Promise<string[]> {
  const problems: string[] = [];
  const root = path.join(distDir, MARKETPLACE_DIR);
  const expectedSources: Record<string, string> = {
    ".claude-plugin/marketplace.json": `./plugins/${PLUGIN_NAME}`,
    ".cursor-plugin/marketplace.json": `plugins/${PLUGIN_NAME}`,
  };
  for (const [manifest, expectedSource] of Object.entries(expectedSources)) {
    const where = `${MARKETPLACE_DIR}/${manifest}`;
    let parsed: { name?: unknown; owner?: { name?: unknown }; plugins?: unknown };
    try {
      parsed = JSON.parse(await readFile(path.join(root, manifest), "utf8")) as typeof parsed;
    } catch (error) {
      problems.push(`${where}: ${(error as Error).message}`);
      continue;
    }
    if (typeof parsed.name !== "string" || !MANIFEST_NAME.test(parsed.name)) problems.push(`${where}: invalid marketplace name`);
    if (typeof parsed.owner?.name !== "string") problems.push(`${where}: owner.name is required`);
    if (!Array.isArray(parsed.plugins)) {
      problems.push(`${where}: plugins must be an array`);
      continue;
    }
    const expected = artifacts.size > 0 ? [{ name: PLUGIN_NAME, source: expectedSource }] : [];
    const actual = (parsed.plugins as { name?: unknown; source?: unknown }[]).map(({ name, source }) => ({ name, source }));
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      problems.push(`${where}: plugins ${JSON.stringify(actual)} should be ${JSON.stringify(expected)}`);
    }
  }

  const pluginRoot = path.join(distDir, PLUGIN_DIR);
  const pluginFiles = await listFiles(pluginRoot);
  if (artifacts.size === 0) {
    if (pluginFiles.length > 0) problems.push(`${PLUGIN_DIR}: exists although no skill is published`);
    return problems;
  }
  for (const manifest of [".claude-plugin/plugin.json", ".cursor-plugin/plugin.json", ".codex-plugin/plugin.json"]) {
    try {
      const parsed = JSON.parse(await readFile(path.join(pluginRoot, manifest), "utf8")) as { name?: unknown };
      if (parsed.name !== PLUGIN_NAME) problems.push(`${PLUGIN_DIR}/${manifest}: name must be "${PLUGIN_NAME}"`);
    } catch (error) {
      problems.push(`${PLUGIN_DIR}/${manifest}: ${(error as Error).message}`);
    }
  }
  const expected = new Map<string, Buffer>();
  for (const [name, files] of artifacts) {
    for (const [file, data] of files) expected.set(`skills/${name}/${file}`, data);
  }
  const shipped = pluginFiles.filter((file) => file.startsWith("skills/"));
  for (const file of shipped) {
    const source = expected.get(file);
    if (!source) {
      problems.push(`${PLUGIN_DIR}/${file}: not part of any indexed skill`);
    } else if (!source.equals(await readFile(path.join(pluginRoot, file)))) {
      problems.push(`${PLUGIN_DIR}/${file}: differs from the indexed artifact`);
    }
  }
  for (const file of expected.keys()) {
    if (!shipped.includes(file)) problems.push(`${PLUGIN_DIR}/${file}: missing from the plugin`);
  }
  return problems;
}

function archiveFiles(bytes: Buffer): Map<string, Buffer> {
  return new Map(readTarGz(bytes).map((entry) => [entry.path, entry.data]));
}

function localPath(url: string): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(url)) return undefined;
  const resolved = url.startsWith("/") ? url.slice(1) : path.posix.join(SKILLS_DIR, url);
  const normal = path.posix.normalize(resolved);
  return normal.startsWith("../") || normal === ".." ? undefined : normal;
}

async function listFiles(dir: string, prefix = ""): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(path.join(dir, prefix), { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await listFiles(dir, relative)));
    else files.push(relative);
  }
  return files.sort(compare);
}

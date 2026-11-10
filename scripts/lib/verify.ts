import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { Ajv2020 } from "ajv/dist/2020.js";

import { parseFrontmatter } from "./frontmatter.ts";
import { INDEX_PATH, PLUGIN_DIR, renderManifests, sha256Digest } from "./outputs.ts";
import type { IndexEntry } from "./outputs.ts";
import { compare } from "./skill.ts";
import { readTarGz } from "./tar.ts";

const SCHEMA_FILE = new URL("../../schemas/agent-skills-discovery-0.2.0.schema.json", import.meta.url);
const SKILLS_DIR = ".well-known/agent-skills";

/**
 * Verifies a built `dist/` directory: the index validates against the vendored
 * discovery schema, every artifact it names exists locally with a matching
 * SHA-256 digest and a SKILL.md that agrees with its entry, every manifest is
 * byte-for-byte what the build writes, the plugin holds exactly the indexed
 * skills' files, and no other file exists anywhere under `distDir`.
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

  problems.push(...(await verifyTree(distDir, referenced, artifacts, entries.length > 0)));
  return problems;
}

async function verifyTree(
  distDir: string,
  referenced: Set<string>,
  artifacts: Map<string, Map<string, Buffer>>,
  listed: boolean,
): Promise<string[]> {
  const problems: string[] = [];
  const expected = new Map<string, Buffer | undefined>([...referenced].map((file) => [file, undefined]));
  for (const [file, data] of renderManifests(listed)) expected.set(file, data);
  for (const [name, files] of artifacts) {
    for (const [file, data] of files) expected.set(`${PLUGIN_DIR}/skills/${name}/${file}`, data);
  }
  const present = await listFiles(distDir);
  for (const file of present) {
    if (!expected.has(file)) {
      problems.push(`${file}: not produced by the build`);
      continue;
    }
    const content = expected.get(file);
    if (content !== undefined && !content.equals(await readFile(path.join(distDir, file)))) {
      problems.push(`${file}: differs from what the build produces`);
    }
  }
  for (const file of expected.keys()) {
    if (!present.includes(file) && !referenced.has(file)) problems.push(`${file}: missing from the build`);
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

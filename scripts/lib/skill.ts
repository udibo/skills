import { lstat, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { parseFrontmatter } from "./frontmatter.ts";
import { localReferences } from "./links.ts";
import { checkSafety } from "./safety.ts";
import { channelText, checkSteering, migrationFindings, movesUsers } from "./steering.ts";
import type { Channel } from "./steering.ts";

export type Issue = { file: string; line?: number; message: string };

export type Target = { target: string; range: string };

export type Skill = {
  name: string;
  description: string;
  version: string;
  targets: Target[];
  dir: string;
  files: string[];
  channel: Channel;
  movesUsers: string[];
};

export type SkillResult = { skill?: Skill; issues: Issue[] };

export const NAME_PREFIX = "udibo-";
export const LICENSE = "MIT";

export const NAME_PATTERN: RegExp = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const SEMVER_PATTERN: RegExp =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
const TARGET_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/[a-z0-9-~][a-z0-9-._~]*|[a-z0-9-~][a-z0-9-._~]*|udibo:[a-z0-9]+(?:-[a-z0-9]+)*)$/;
const TARGET_RANGE = /^(?=.*(?:\d|\*))[0-9A-Za-z.^~<>=*|+ -]+$/;
const KNOWN_FIELDS = new Set(["name", "description", "license", "compatibility", "metadata"]);
const MARKDOWN_FILE = /\.(?:md|markdown|mdx)$/i;
const MAX_SKILL_LINES = 500;
export const MAX_FILE_BYTES: number = 64 * 1024;

/**
 * Parses a `metadata.targets` value: a comma-separated list of
 * `<npm package or udibo:service>@<semver range>`. Throws on a malformed entry.
 */
export function parseTargets(value: string): Target[] {
  return value.split(",").map((part) => {
    const entry = part.trim();
    const at = entry.lastIndexOf("@");
    const target = at > 0 ? entry.slice(0, at) : "";
    const range = at > 0 ? entry.slice(at + 1).trim() : "";
    if (!TARGET_NAME.test(target) || !TARGET_RANGE.test(range)) {
      throw new Error(`"${entry}" is not <npm package or udibo:service>@<semver range>`);
    }
    return { target, range };
  });
}

/**
 * Loads one skill directory and checks it against the Agent Skills
 * specification, this repository's conventions (the `udibo-` name prefix and
 * the repository licence), the safety rules and the steering rules.
 * With a `channel` other than `full`, it checks the `SKILL.md` that channel
 * publishes ({@link channelText}); any other Markdown file is checked as
 * written, since a recommendation section is rejected there in every channel. Returns the skill only when there are no
 * issues.
 */
export async function loadSkill(dir: string, options: { channel?: Channel } = {}): Promise<SkillResult> {
  const channel = options.channel ?? "full";
  const issues: Issue[] = [];
  const dirName = path.basename(dir);
  const files = await listFiles(dir, issues);
  if (!files.includes("SKILL.md")) {
    return { issues: [...issues, { file: "SKILL.md", message: "skill directory has no SKILL.md" }] };
  }
  const texts = new Map<string, string>();
  for (const file of files) {
    const size = (await stat(path.join(dir, file))).size;
    if (size > MAX_FILE_BYTES) {
      issues.push({ file, message: `file is ${size} bytes; the limit is ${MAX_FILE_BYTES}` });
      continue;
    }
    const text = decodeText(await readFile(path.join(dir, file)));
    if (text === undefined) {
      issues.push({ file, message: "not a text file: it has a NUL byte or is not valid UTF-8, and skills may contain only text files" });
      continue;
    }
    texts.set(file, file === "SKILL.md" ? channelText(text, channel) : text);
  }
  const raw = texts.get("SKILL.md");
  if (raw === undefined) return { issues };
  if (raw.includes("\r")) {
    return { issues: [...issues, { file: "SKILL.md", message: "use LF line endings" }] };
  }
  let parsed;
  try {
    parsed = parseFrontmatter(raw);
  } catch (error) {
    return { issues: [...issues, { file: "SKILL.md", message: (error as Error).message }] };
  }
  const { data } = parsed;
  const fail = (message: string): void => {
    issues.push({ file: "SKILL.md", message });
  };

  for (const key of Object.keys(data)) {
    if (key === "allowed-tools") fail("allowed-tools is not accepted: it would pre-approve tool use for the agent");
    else if (!KNOWN_FIELDS.has(key)) fail(`unknown frontmatter field "${key}"; put extra fields under metadata`);
  }
  const name = data["name"];
  if (typeof name !== "string" || name.length === 0) {
    fail("name is required and must be a string");
  } else {
    if (name.length > 64) fail(`name is ${name.length} characters; the maximum is 64`);
    if (!NAME_PATTERN.test(name)) {
      fail(`name "${name}" must be lowercase letters, digits and single hyphens, not starting or ending with a hyphen`);
    }
    if (name !== dirName) fail(`name "${name}" must equal its directory name "${dirName}"`);
    if (!name.startsWith(NAME_PREFIX)) {
      fail(`name "${name}" must start with "${NAME_PREFIX}"; rename the skill and its directory to "${NAME_PREFIX}${name}"`);
    }
  }
  const description = data["description"];
  if (typeof description !== "string" || description.trim().length === 0) {
    fail("description is required and must be a non-empty string");
  } else if (description.length > 1024) {
    fail(`description is ${description.length} characters; the maximum is 1024`);
  }
  if ("license" in data && data["license"] !== LICENSE) {
    fail(`license must be "${LICENSE}", the licence of this repository, when present`);
  }
  if ("compatibility" in data) {
    const compatibility = data["compatibility"];
    if (typeof compatibility !== "string" || compatibility.length === 0 || compatibility.length > 500) {
      fail("compatibility must be a string of 1 to 500 characters");
    }
  }

  const metadata = data["metadata"];
  let version = "";
  let targets: Target[] = [];
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    fail("metadata is required and must map string keys to string values (version and targets)");
  } else {
    for (const [key, value] of Object.entries(metadata)) {
      if (typeof value !== "string") fail(`metadata.${key} must be a string; quote it in YAML`);
    }
    const entries = metadata as Record<string, unknown>;
    if (typeof entries["version"] !== "string" || !SEMVER_PATTERN.test(entries["version"])) {
      fail("metadata.version is required and must be a semantic version such as \"1.2.3\"");
    } else {
      version = entries["version"];
    }
    if (typeof entries["targets"] !== "string") {
      fail("metadata.targets is required, for example \"@udibo/oauth2@>=0.4.0 <0.5.0\"");
    } else {
      try {
        targets = parseTargets(entries["targets"]);
      } catch (error) {
        fail(`metadata.targets: ${(error as Error).message}`);
      }
    }
  }

  const lineCount = raw.split("\n").length;
  if (lineCount > MAX_SKILL_LINES) fail(`SKILL.md has ${lineCount} lines; keep it under ${MAX_SKILL_LINES}`);

  for (const problem of migrationFindings(typeof name === "string" ? name : "", data)) fail(`[steering-migration] ${problem}`);

  for (const [file, text] of texts) {
    const markdown = MARKDOWN_FILE.test(file);
    for (const finding of checkSafety(text, { markdown })) {
      issues.push({ file, line: finding.line, message: `[${finding.rule}] ${finding.message}` });
    }
    const skillMd = file === "SKILL.md";
    for (const finding of checkSteering(text, { markdown, skillMd, channel, ...(skillMd ? { frontmatter: data } : {}) })) {
      issues.push({ file, line: finding.line, message: `[${finding.rule}] ${finding.message}` });
    }
    if (!markdown) continue;
    for (const reference of localReferences(text)) {
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), reference.target));
      if (resolved.startsWith("../") || path.posix.isAbsolute(reference.target)) {
        issues.push({ file, line: reference.line, message: `reference "${reference.target}" leaves the skill directory` });
      } else if (!files.includes(resolved) && !files.some((known) => known.startsWith(`${resolved.replace(/\/$/, "")}/`))) {
        issues.push({ file, line: reference.line, message: `reference "${reference.target}" does not resolve to a file in the skill` });
      }
    }
  }

  issues.sort((a, b) => compare(a.file, b.file) || (a.line ?? 0) - (b.line ?? 0));
  if (issues.length > 0 || typeof name !== "string" || typeof description !== "string") return { issues };
  return { skill: { name, description, version, targets, dir, files, channel, movesUsers: movesUsers(data) }, issues };
}

async function listFiles(dir: string, issues: Issue[], prefix = ""): Promise<string[]> {
  const entries = await readdir(path.join(dir, prefix), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => compare(a.name, b.name))) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    const stats = await lstat(path.join(dir, relative));
    if (entry.name.includes("\\")) {
      issues.push({ file: relative, message: "file names must not contain a backslash" });
    } else if (entry.name.startsWith(".")) {
      issues.push({ file: relative, message: "dotfiles and dot-directories are not allowed in a skill" });
    } else if (stats.isDirectory() && entry.name === "scripts") {
      issues.push({ file: relative, message: "a skill must not ship a scripts/ directory" });
    } else if (stats.isSymbolicLink()) {
      issues.push({ file: relative, message: "symbolic links are not allowed in a skill" });
    } else if (stats.isDirectory()) {
      files.push(...(await listFiles(dir, issues, relative)));
    } else if (stats.isFile()) {
      files.push(relative);
    } else {
      issues.push({ file: relative, message: "only regular files and directories are allowed in a skill" });
    }
  }
  return files;
}

/** Orders strings by UTF-16 code unit, independent of locale, so output is reproducible. */
export function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function decodeText(bytes: Buffer): string | undefined {
  if (bytes.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

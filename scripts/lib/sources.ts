import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { compare, loadSkill, NAME_PATTERN, SEMVER_PATTERN } from "./skill.ts";
import type { Issue, Skill, SkillRules } from "./skill.ts";

export type ExternalPin = {
  name: string;
  package: string;
  version: string;
  integrity: string;
};

export type SourceIssue = Issue & { skill: string };

export type Sources = { skills: Skill[]; issues: SourceIssue[] };

export type SourceOptions = {
  skillsDir: string;
  externalFile?: string;
  externalCacheDir?: string;
  rules?: SkillRules;
};

export const PUBLISHED_RULES: SkillRules = { namePrefix: "udibo-" };

const PACKAGE_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const SRI_SHA512 = /^sha512-[A-Za-z0-9+/]{86}==$/;

/**
 * Reads and validates `external-skills.json`: skills owned by another
 * repository and pulled from its published npm tarball at a pinned version.
 * Throws with every problem found.
 */
export async function readExternalPins(file: string): Promise<ExternalPin[]> {
  const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
  const list = (parsed as { skills?: unknown })?.skills;
  if (!Array.isArray(list)) throw new Error(`${file}: expected an object with a "skills" array`);
  const problems: string[] = [];
  const pins = list.map((entry: unknown, index): ExternalPin => {
    const pin = (entry ?? {}) as Record<string, unknown>;
    const where = `${file}: skills[${index}]`;
    const keys = Object.keys(pin).sort(compare).join(",");
    if (keys !== "integrity,name,package,version") {
      problems.push(`${where} must have exactly name, package, version and integrity`);
    }
    if (typeof pin["name"] !== "string" || !NAME_PATTERN.test(pin["name"])) problems.push(`${where}.name is not a valid skill name`);
    if (typeof pin["package"] !== "string" || !PACKAGE_NAME.test(pin["package"])) problems.push(`${where}.package is not an npm package name`);
    if (typeof pin["version"] !== "string" || !SEMVER_PATTERN.test(pin["version"])) problems.push(`${where}.version must be an exact version`);
    if (typeof pin["integrity"] !== "string" || !SRI_SHA512.test(pin["integrity"])) {
      problems.push(`${where}.integrity must be the tarball's sha512 integrity from the registry`);
    }
    return pin as ExternalPin;
  });
  const names = pins.map((pin) => pin.name);
  for (const duplicate of names.filter((name, index) => names.indexOf(name) !== index)) {
    problems.push(`${file}: skill "${duplicate}" is pinned more than once`);
  }
  if (problems.length > 0) throw new Error(problems.join("\n"));
  return pins;
}

/**
 * Collects every publishable skill: the directories under `skillsDir` and the
 * external skills fetched into `externalCacheDir`. An external skill must have
 * been fetched at exactly its pinned version, and its `metadata.version` must
 * equal that version and its targets must name the package.
 */
export async function collectSources(options: SourceOptions): Promise<Sources> {
  const rules = options.rules ?? PUBLISHED_RULES;
  const skills: Skill[] = [];
  const issues: SourceIssue[] = [];
  const add = (skill: string, items: Issue[]): void => {
    issues.push(...items.map((item) => ({ ...item, skill })));
  };

  for (const name of await skillDirectories(options.skillsDir)) {
    const result = await loadSkill(path.join(options.skillsDir, name), rules);
    add(name, result.issues);
    if (result.skill) skills.push(result.skill);
  }

  if (options.externalFile !== undefined) {
    const pins = await readExternalPins(options.externalFile);
    const cache = options.externalCacheDir ?? "";
    for (const pin of pins) {
      const fetched = await readFetchedPin(cache, pin.name);
      const matches =
        fetched !== undefined &&
        fetched.name === pin.name &&
        fetched.package === pin.package &&
        fetched.version === pin.version &&
        fetched.integrity === pin.integrity;
      if (!matches) {
        add(pin.name, [{ file: "external-skills.json", message: "not fetched at its pinned version; run node scripts/fetch-external.ts" }]);
        continue;
      }
      const result = await loadSkill(path.join(cache, pin.name), rules);
      add(pin.name, result.issues);
      if (!result.skill) continue;
      if (result.skill.version !== pin.version) {
        add(pin.name, [{ file: "SKILL.md", message: `metadata.version ${result.skill.version} must equal the pinned ${pin.package} version ${pin.version}` }]);
        continue;
      }
      if (!result.skill.targets.some(({ target }) => target === pin.package)) {
        add(pin.name, [{ file: "SKILL.md", message: `metadata.targets must name ${pin.package}` }]);
        continue;
      }
      skills.push(result.skill);
    }
  }

  const seen = new Set<string>();
  for (const skill of skills) {
    if (seen.has(skill.name)) add(skill.name, [{ file: "SKILL.md", message: "two sources publish a skill with this name" }]);
    seen.add(skill.name);
  }
  skills.sort((a, b) => compare(a.name, b.name));
  return { skills: issues.length > 0 ? [] : skills, issues };
}

/** Path of the record `fetch-external` writes once a pinned skill is unpacked. */
export function fetchedPinPath(cacheDir: string, name: string): string {
  return path.join(cacheDir, ".pins", `${name}.json`);
}

async function readFetchedPin(cacheDir: string, name: string): Promise<ExternalPin | undefined> {
  try {
    return JSON.parse(await readFile(fetchedPinPath(cacheDir, name), "utf8")) as ExternalPin;
  } catch {
    return undefined;
  }
}

async function skillDirectories(dir: string): Promise<string[]> {
  try {
    await stat(dir);
  } catch {
    return [];
  }
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(compare);
}

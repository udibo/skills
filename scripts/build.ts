import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { renderOutputs } from "./lib/outputs.ts";
import { collectSources } from "./lib/sources.ts";
import type { SourceIssue, SourceOptions } from "./lib/sources.ts";

export type BuildOptions = SourceOptions & { outDir: string };

export type BuildResult = { files: string[]; skills: string[]; issues: SourceIssue[] };

/** The source locations of a checkout of this repository. */
export function repositorySources(root: string): SourceOptions {
  return {
    skillsDir: path.join(root, "skills"),
    externalFile: path.join(root, "external-skills.json"),
    externalCacheDir: path.join(root, ".cache", "external"),
  };
}

/**
 * Validates every source skill and, only when all are valid, replaces
 * `outDir` with the discovery index, the skill artifacts it names and the
 * plugin marketplace tree. Writes nothing when any source has an issue.
 */
export async function build(options: BuildOptions): Promise<BuildResult> {
  const sources = await collectSources(options);
  if (sources.issues.length > 0) return { files: [], skills: [], issues: sources.issues };
  const outputs = await renderOutputs(sources.skills);
  await rm(options.outDir, { recursive: true, force: true });
  for (const [file, data] of outputs) {
    const destination = path.join(options.outDir, file);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, data);
  }
  return { files: [...outputs.keys()], skills: sources.skills.map((skill) => skill.name), issues: [] };
}

/** Formats a source issue as `skill/file:line: message`. */
export function formatIssue(issue: SourceIssue): string {
  return `${issue.skill}/${issue.file}${issue.line === undefined ? "" : `:${issue.line}`}: ${issue.message}`;
}

/** CLI entry: `node scripts/build.ts`. */
export async function main(root: string = process.cwd()): Promise<number> {
  const result = await build({ ...repositorySources(root), outDir: path.join(root, "dist") });
  if (result.issues.length > 0) {
    result.issues.forEach((issue) => console.error(formatIssue(issue)));
    return 1;
  }
  console.log(`Built ${result.skills.length} skill(s) into dist/ (${result.files.length} files).`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}

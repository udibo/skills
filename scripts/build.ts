import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { renderOutputs } from "./lib/outputs.ts";
import { collectSources } from "./lib/sources.ts";
import { writeTracked } from "./lib/tracked.ts";
import type { SourceIssue, SourceOptions } from "./lib/sources.ts";
import { CHANNELS } from "./lib/steering.ts";

export type BuildOptions = SourceOptions & { outDir: string; trackedDir?: string };

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
 * plugin marketplace tree, as the copies `channel` publishes (`full` by
 * default). With `trackedDir`, also replaces the generated
 * marketplace directories at that repository root (`.claude-plugin/`,
 * `.cursor-plugin/`, `plugins/`). Writes nothing when any source has an issue.
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
  if (options.trackedDir !== undefined) await writeTracked(options.trackedDir, outputs);
  return { files: [...outputs.keys()], skills: sources.skills.map((skill) => skill.name), issues: [] };
}

/** Formats a source issue as `skill/file:line: message`. */
export function formatIssue(issue: SourceIssue): string {
  return `${issue.skill}/${issue.file}${issue.line === undefined ? "" : `:${issue.line}`}: ${issue.message}`;
}

/**
 * CLI entry: `node scripts/build.ts [--channel <name>]`. The default `full`
 * channel writes `dist/` and the committed marketplace tree; any other channel
 * writes only `dist/channels/<name>/`.
 */
export async function main(root: string = process.cwd(), argv: string[] = []): Promise<number> {
  const flag = argv.indexOf("--channel");
  const requested = flag === -1 ? "full" : argv[flag + 1];
  const channel = CHANNELS.find((entry) => entry === requested);
  if (channel === undefined) {
    console.error(`--channel must be one of ${CHANNELS.join(", ")}`);
    return 2;
  }
  const result = await build(
    channel === "full"
      ? { ...repositorySources(root), outDir: path.join(root, "dist"), trackedDir: root }
      : { ...repositorySources(root), channel, outDir: path.join(root, "dist", "channels", channel) },
  );
  if (result.issues.length > 0) {
    result.issues.forEach((issue) => console.error(formatIssue(issue)));
    return 1;
  }
  const where = channel === "full" ? "dist/" : `dist/channels/${channel}/`;
  console.log(`Built ${result.skills.length} skill(s) into ${where} (${result.files.length} files).`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.cwd(), process.argv.slice(2));
}

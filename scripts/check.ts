import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build, formatIssue, repositorySources } from "./build.ts";
import { renderManifests } from "./lib/outputs.ts";
import type { SourceOptions } from "./lib/sources.ts";
import { CHANNELS, manifestTextProblems } from "./lib/steering.ts";
import { trackedDrift } from "./lib/tracked.ts";
import { licenceProblems } from "./lib/release.ts";
import { verifyDist } from "./lib/verify.ts";
import { checkWorkflows } from "./lib/workflows.ts";

export type CheckOptions = {
  sources: SourceOptions;
  workflowsDir?: string;
  root?: string;
  distDir?: string;
};

/**
 * Runs every repository check and returns one message per problem: source
 * skills against the specification, conventions, safety and steering rules;
 * two builds into temporary directories that must be byte-identical and must
 * verify; a build of every other channel's copies, which must pass the same
 * checks and verify; the plugin manifests' text; the CI workflows; the
 * licence files and the committed marketplace tree, when `root` is given;
 * and, when `distDir` is given, an existing build.
 */
export async function check(options: CheckOptions): Promise<string[]> {
  const problems: string[] = [];
  const scratch = await mkdtemp(path.join(tmpdir(), "skills-check-"));
  try {
    const first = await build({ ...options.sources, outDir: path.join(scratch, "a") });
    if (first.issues.length > 0) {
      problems.push(...first.issues.map(formatIssue));
    } else {
      const second = await build({ ...options.sources, outDir: path.join(scratch, "b") });
      problems.push(...(await compareBuilds(path.join(scratch, "a"), path.join(scratch, "b"), first.files, second.files)));
      problems.push(...(await verifyDist(path.join(scratch, "a"))));
      if (options.root !== undefined) problems.push(...(await trackedDrift(options.root, path.join(scratch, "a"))));
      for (const channel of CHANNELS.filter((entry) => entry !== "full")) {
        const outDir = path.join(scratch, `channel-${channel}`);
        const variant = await build({ ...options.sources, channel, outDir });
        problems.push(...variant.issues.map((issue) => `${channel} channel: ${formatIssue(issue)}`));
        if (variant.issues.length === 0) problems.push(...(await verifyDist(outDir)).map((problem) => `${channel} channel: ${problem}`));
      }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  for (const [file, data] of renderManifests(true)) problems.push(...manifestTextProblems(file, manifestTexts(JSON.parse(data.toString("utf8")))));
  if (options.workflowsDir !== undefined) problems.push(...(await checkWorkflows(options.workflowsDir)));
  if (options.root !== undefined) problems.push(...(await licenceProblems(options.root)));
  if (options.distDir !== undefined) {
    problems.push(...(await verifyDist(options.distDir)).map((problem) => `dist: ${problem}`));
  }
  return problems;
}

/** Every `description`, at any depth, of a parsed manifest: the text a directory or a model reads. */
export function manifestTexts(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(manifestTexts);
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, entry]) => (key === "description" && typeof entry === "string" ? [entry] : manifestTexts(entry)));
}

/** Compares two build outputs file by file; returns a message for each difference. */
export async function compareBuilds(a: string, b: string, filesA: string[], filesB: string[]): Promise<string[]> {
  if (JSON.stringify(filesA) !== JSON.stringify(filesB)) return ["build is not deterministic: two runs wrote different file lists"];
  const problems: string[] = [];
  for (const file of filesA) {
    const [left, right] = await Promise.all([readFile(path.join(a, file)), readFile(path.join(b, file))]);
    if (!left.equals(right)) problems.push(`build is not deterministic: ${file} differs between two runs`);
  }
  return problems;
}

/** CLI entry: `node scripts/check.ts [--dist <dir>]`. */
export async function main(argv: string[] = process.argv.slice(2), root: string = process.cwd()): Promise<number> {
  const distFlag = argv.indexOf("--dist");
  const distArg = distFlag === -1 ? undefined : argv[distFlag + 1];
  if (distFlag !== -1 && distArg === undefined) {
    console.error("--dist needs a directory");
    return 2;
  }
  const problems = await check({
    sources: repositorySources(root),
    workflowsDir: path.join(root, ".github", "workflows"),
    root,
    ...(distArg === undefined ? {} : { distDir: path.resolve(root, distArg) }),
  });
  if (problems.length > 0) {
    problems.forEach((problem) => console.error(problem));
    console.error(`${problems.length} problem(s) found.`);
    return 1;
  }
  console.log("All checks passed.");
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}

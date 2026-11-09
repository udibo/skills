import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { parse } from "yaml";

import { compare } from "./skill.ts";

export const RUNNER_LABEL = "ubuntu-24.04";

const PINNED_ACTION = /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/;

/**
 * Checks one GitHub Actions workflow against the rules that keep it safe for
 * a fork's pull request: GitHub-hosted `ubuntu-24.04` runners only, no
 * `pull_request_target`, no `secrets.` reference, top-level read-only
 * contents permission, and every action pinned to a full commit SHA.
 */
export function checkWorkflow(name: string, text: string): string[] {
  const problems: string[] = [];
  const fail = (message: string): void => {
    problems.push(`${name}: ${message}`);
  };
  if (/self-hosted/i.test(text)) fail("names a self-hosted runner");
  if (/pull_request_target/.test(text)) fail("uses the pull_request_target trigger");
  if (/\bsecrets\s*(?:\.|\[)/.test(text)) fail("references secrets");
  if (/\bsecrets\s*:\s*inherit\b/.test(text)) fail("inherits secrets");

  let workflow: Record<string, unknown>;
  try {
    workflow = parse(text, { strict: true, uniqueKeys: true }) as Record<string, unknown>;
  } catch (error) {
    fail(`is not valid YAML: ${(error as Error).message}`);
    return problems;
  }
  const triggers = workflow["on"];
  const triggerNames =
    typeof triggers === "string" ? [triggers] : Array.isArray(triggers) ? triggers : Object.keys(triggers ?? {});
  if (!triggerNames.includes("pull_request")) fail("must run on the pull_request trigger");
  const permissions = workflow["permissions"] as Record<string, unknown> | undefined;
  if (
    permissions === null ||
    typeof permissions !== "object" ||
    Object.keys(permissions).length !== 1 ||
    permissions["contents"] !== "read"
  ) {
    fail("must declare top-level permissions of exactly contents: read");
  }
  const jobs = workflow["jobs"];
  if (jobs === null || typeof jobs !== "object") {
    fail("has no jobs");
    return problems;
  }
  for (const [jobName, job] of Object.entries(jobs as Record<string, Record<string, unknown>>)) {
    if (job["runs-on"] !== RUNNER_LABEL) fail(`job ${jobName} must set runs-on: ${RUNNER_LABEL}`);
    const steps = Array.isArray(job["steps"]) ? (job["steps"] as Record<string, unknown>[]) : [];
    for (const step of steps) {
      const uses = step["uses"];
      if (typeof uses === "string" && !uses.startsWith("./") && !PINNED_ACTION.test(uses)) {
        fail(`job ${jobName} uses ${uses}, which is not pinned to a full commit SHA`);
      }
    }
  }
  return problems;
}

/** Checks every `.yml` and `.yaml` file in a workflows directory. */
export async function checkWorkflows(dir: string): Promise<string[]> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((file) => /\.ya?ml$/.test(file)).sort(compare);
  } catch {
    return [];
  }
  const problems: string[] = [];
  for (const file of files) {
    problems.push(...checkWorkflow(file, await readFile(path.join(dir, file), "utf8")));
  }
  return problems;
}

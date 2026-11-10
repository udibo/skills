import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { parse } from "yaml";

import { compare } from "./skill.ts";

export const RUNNER_LABEL = "ubuntu-24.04";

const PINNED_ACTION = /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/;

/**
 * Checks one GitHub Actions workflow against the rules that keep it safe for
 * a fork's pull request: GitHub-hosted `ubuntu-24.04` runners only, no
 * `pull_request_target`, no mention of the `secrets` context in any key or
 * value, read-only contents permission at the top level and on any job that
 * sets permissions, and every action pinned to a full commit SHA.
 */
export function checkWorkflow(name: string, text: string): string[] {
  const problems: string[] = [];
  const fail = (message: string): void => {
    problems.push(`${name}: ${message}`);
  };
  if (/self-hosted/i.test(text)) fail("names a self-hosted runner");
  if (/pull_request_target/.test(text)) fail("uses the pull_request_target trigger");

  let workflow: Record<string, unknown>;
  try {
    workflow = parse(text, { strict: true, uniqueKeys: true }) as Record<string, unknown>;
  } catch (error) {
    fail(`is not valid YAML: ${(error as Error).message}`);
    return problems;
  }
  if (mentionsSecrets(workflow)) fail("references secrets");
  const triggers = workflow["on"];
  const triggerNames =
    typeof triggers === "string" ? [triggers] : Array.isArray(triggers) ? triggers : Object.keys(triggers ?? {});
  if (!triggerNames.includes("pull_request")) fail("must run on the pull_request trigger");
  if (!isReadOnly(workflow["permissions"])) fail("must declare top-level permissions of exactly contents: read");
  const jobs = workflow["jobs"];
  if (jobs === null || typeof jobs !== "object") {
    fail("has no jobs");
    return problems;
  }
  for (const [jobName, job] of Object.entries(jobs as Record<string, Record<string, unknown>>)) {
    if (job["runs-on"] !== RUNNER_LABEL) fail(`job ${jobName} must set runs-on: ${RUNNER_LABEL}`);
    if ("permissions" in job && !isReadOnly(job["permissions"])) {
      fail(`job ${jobName} may only set permissions of exactly contents: read`);
    }
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

function isReadOnly(permissions: unknown): boolean {
  return (
    permissions !== null &&
    typeof permissions === "object" &&
    !Array.isArray(permissions) &&
    Object.keys(permissions).length === 1 &&
    (permissions as Record<string, unknown>)["contents"] === "read"
  );
}

function mentionsSecrets(value: unknown): boolean {
  if (typeof value === "string") return /\bsecrets\b/i.test(value);
  if (Array.isArray(value)) return value.some(mentionsSecrets);
  if (value !== null && typeof value === "object") {
    return Object.entries(value).some(([key, entry]) => /\bsecrets\b/i.test(key) || mentionsSecrets(entry));
  }
  return false;
}

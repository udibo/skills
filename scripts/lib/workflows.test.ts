import { readFile } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "vitest";

import { checkWorkflow, checkWorkflows } from "./workflows.ts";

const WORKFLOWS = path.resolve(import.meta.dirname, "../../.github/workflows");
const SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1";

function workflow(overrides: { on?: string; permissions?: string; runsOn?: string; step?: string } = {}): string {
  return [
    `on: ${overrides.on ?? "[pull_request, push]"}`,
    overrides.permissions ?? "permissions:\n  contents: read",
    "jobs:",
    "  ci:",
    `    runs-on: ${overrides.runsOn ?? "ubuntu-24.04"}`,
    "    steps:",
    `      - ${overrides.step ?? `uses: actions/checkout@${SHA}`}`,
  ].join("\n");
}

test("this repository's workflows pass", async () => {
  expect(await checkWorkflows(WORKFLOWS)).toEqual([]);
});

test("ci.yml runs install, check, test and build", async () => {
  const text = await readFile(path.join(WORKFLOWS, "ci.yml"), "utf8");
  for (const command of ["pnpm install --frozen-lockfile", "pnpm check", "pnpm test", "pnpm build"]) {
    expect(text).toContain(`run: ${command}`);
  }
});

test("accepts a minimal safe workflow", () => {
  expect(checkWorkflow("w.yml", workflow())).toEqual([]);
});

test.each([
  ["a self-hosted runner", workflow({ runsOn: "[self-hosted, linux]" }), "w.yml: names a self-hosted runner"],
  ["a runner group", workflow({ runsOn: "{ group: ubuntu-runners }" }), "w.yml: job ci must set runs-on: ubuntu-24.04"],
  ["a moving runner label", workflow({ runsOn: "ubuntu-latest" }), "w.yml: job ci must set runs-on: ubuntu-24.04"],
  ["pull_request_target", workflow({ on: "[pull_request, pull_request_target]" }), "w.yml: uses the pull_request_target trigger"],
  ["no pull_request trigger", workflow({ on: "[push]" }), "w.yml: must run on the pull_request trigger"],
  ["a secrets reference", workflow({ step: "run: echo ${{ secrets.TOKEN }}" }), "w.yml: references secrets"],
  ["an indexed secrets reference", workflow({ step: "run: echo ${{ secrets['TOKEN'] }}" }), "w.yml: references secrets"],
  ["missing permissions", workflow({ permissions: "" }), "w.yml: must declare top-level permissions of exactly contents: read"],
  ["write permissions", workflow({ permissions: "permissions: write-all" }), "w.yml: must declare top-level permissions of exactly contents: read"],
  [
    "extra permissions",
    workflow({ permissions: "permissions:\n  contents: read\n  id-token: write" }),
    "w.yml: must declare top-level permissions of exactly contents: read",
  ],
  ["an action pinned to a tag", workflow({ step: "uses: actions/checkout@v7" }), "w.yml: job ci uses actions/checkout@v7, which is not pinned to a full commit SHA"],
])("rejects %s", (_label, text, message) => {
  expect(checkWorkflow("w.yml", text)).toContain(message);
});

test("reports a workflow that is not valid YAML", () => {
  expect(checkWorkflow("w.yml", "on: [pull_request\n")[0]).toMatch(/^w\.yml: is not valid YAML/);
});

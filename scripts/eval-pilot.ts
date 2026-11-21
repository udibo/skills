/** Manual conversational evaluations of the existing-provider and outward-migration pilots. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { readTurn, runEvaluation, selectedFiles, type Evaluation } from "./lib/eval-turns.ts";
import { replayExistingProject } from "./lib/existing-project-pilot.ts";
import { readSkillDocument } from "./lib/fixture.ts";
import { replayMigrationPilot } from "./lib/migration-pilot.ts";

const cases = {
  existing: {
    skill: "udibo-add-to-project",
    situation: "I have an existing Hono application and provider. I want to try the client package while keeping that issuer and our existing sign-in. Our public home is /, our login and callback are under /auth, existing support sessions use /support, and /records/:owner is protected by organization membership.",
    approval: "I approve Phase A against the existing issuer for a pilot. The operator registered /pilot-auth/callback for the pilot. Available mount paths are /auth and /pilot-auth. Select one in the pilot array. Keep the existing handlers, support session and record access controls working.",
  },
  migration: {
    skill: "udibo-migrate-from-udibo",
    situation: "I've chosen to leave my hosted tenant for my own server on the package. Help me plan a synthetic sign-in rehearsal. The directory and credential exports contain three mapped accounts labeled pilot (active), disabled and deleted. Use only the eligible cohort and keep the source available.",
    approval: "I approve the synthetic rehearsal on my own server. The fixture operator verified the snapshot and paired exports and will handle the key. Put the eligible account labels in the pilot array. Production cutover is outside this rehearsal.",
  },
};

type PilotCase = keyof typeof cases;

function pilotTurn(turn: unknown): { files: number[]; pilot: string[] } {
  assert.ok(turn && typeof turn === "object" && "pilot" in turn, "the pilot selection is missing");
  const { pilot, ...reply } = turn;
  assert.ok(Array.isArray(pilot) && pilot.every(item => typeof item === "string"), "expected pilot selections");
  return { files: readTurn(reply).files, pilot };
}

export async function pilotEvaluation(id: PilotCase): Promise<Evaluation> {
  const entry = cases[id];
  const directory = path.resolve(import.meta.dirname, "../skills", entry.skill);
  const source = await readFile(path.join(directory, "SKILL.md"), "utf8");
  const document = await readSkillDocument(directory);
  const sha256 = createHash("sha256").update(source).digest("hex");
  function choicePrompt(plan: unknown): string {
    const { files, pilot } = pilotTurn(plan);
    assert.ok(!files.length && !pilot.length, "the agent requested project or pilot actions before approval");
    return [
      entry.approval, "Return the same JSON format. Select the reviewed file blocks to apply and tell me what happens next.",
      ...document.files.map(file => `${file.line} ${file.path} ${file.contents.split("\n")[0]}`),
    ].join("\n");
  }
  return {
    planPrompt: () => [
      entry.situation, "Work in conversation only. The fixture operator can apply the actions I approve.",
      'Return JSON with "message" (your answer), "files" (file-block line numbers to apply this turn), and "pilot" (items to activate this turn).',
      "", source,
    ].join("\n"),
    choicePrompt,
    async grade(plan, implementation) {
      choicePrompt(plan);
      const { files, pilot } = pilotTurn(implementation);
      const selected = selectedFiles(files, document.files);
      if (id === "existing") {
        const [mount] = pilot;
        assert.ok(pilot.length === 1 && (mount === "/auth" || mount === "/pilot-auth"), "select one offered mount");
        await replayExistingProject(selected, "hono", true, mount);
      } else {
        await replayMigrationPilot(selected, pilot);
      }
      return JSON.stringify({ skill: entry.skill, sha256, fixture: id, passed: true });
    },
  };
}

if (import.meta.main) {
  const [id, ...args] = process.argv.slice(2);
  if (id === "existing" || id === "migration") await runEvaluation(await pilotEvaluation(id), args);
  else {
    console.error("Choose an evaluation case: existing or migration.");
    process.exitCode = 1;
  }
}

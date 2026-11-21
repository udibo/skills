import path from "node:path";
import { expect, test } from "vitest";

import { pilotEvaluation } from "./eval-pilot.ts";
import { readSkillDocument } from "./lib/fixture.ts";

const plan = { message: "I will wait for approval.", files: [], pilot: [] };

test.each([
  ["existing", "udibo-add-to-project", ["/pilot-auth"]],
  ["migration", "udibo-migrate-from-udibo", ["pilot"]],
] as const)("the %s pilot follows approval and runs the accepted project", { timeout: 30_000 }, async (id, name, pilot) => {
  const evaluation = await pilotEvaluation(id);
  const document = await readSkillDocument(path.resolve(import.meta.dirname, "../skills", name));
  const files = document.files.map(file => file.line);
  expect(evaluation.planPrompt()).toContain(name);
  expect(evaluation.choicePrompt(plan)).toContain(`${files[0]} ${document.files[0]?.path}`);
  expect(() => evaluation.choicePrompt({ ...plan, pilot })).toThrow("before approval");
  expect(() => evaluation.choicePrompt({ ...plan, files })).toThrow("before approval");
  await expect(evaluation.grade(plan, { ...plan, files: [-1], pilot })).rejects.toThrow("outside the reviewed skill");
  expect(JSON.parse(await evaluation.grade(plan, { ...plan, files, pilot }))).toMatchObject({ skill: name, fixture: id, passed: true });
});

test("using the occupied login mount fails to reach the pilot issuer", { timeout: 30_000 }, async () => {
  const evaluation = await pilotEvaluation("existing");
  const document = await readSkillDocument(path.resolve(import.meta.dirname, "../skills/udibo-add-to-project"));
  await expect(evaluation.grade(plan, { ...plan, files: document.files.map(file => file.line), pilot: ["/auth"] }))
    .rejects.toThrow("the pilot login must reach the registered issuer");
});

test("importing a disabled account fails the decrypted directory comparison", async () => {
  const evaluation = await pilotEvaluation("migration");
  const document = await readSkillDocument(path.resolve(import.meta.dirname, "../skills/udibo-migrate-from-udibo"));
  await expect(evaluation.grade(plan, { ...plan, files: document.files.map(file => file.line), pilot: ["pilot", "disabled"] }))
    .rejects.toThrow("pilot cohort disagrees with eligible directory accounts");
});

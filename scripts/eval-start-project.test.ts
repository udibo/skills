import path from "node:path";
import { expect, test } from "vitest";

import { choicePrompt, grade, planPrompt } from "./eval-start-project.ts";
import { readSkillDocument } from "./lib/fixture.ts";

const skill = await readSkillDocument(path.resolve(import.meta.dirname, "../skills/udibo-start-project"));
const plan = { message: "Which path shall we take?", files: [] };
const local = skill.files.filter(file => file.path !== ".env.example" || file.contents.includes("AUTH_CLIENT_ID=dev-client")).map(file => file.line);
const implementation = { message: "Set the private settings locally.", files: local };

test("the two turns present the actual skill and the distinct local and hosted settings blocks", () => {
  expect(planPrompt()).toContain("udibo-start-project");
  const prompt = choicePrompt(plan);
  for (const file of skill.files) expect(prompt).toContain(`${file.line} ${file.path} `);
});

test("a file change in the planning turn or an unreviewed block fails", async () => {
  expect(() => choicePrompt(implementation)).toThrow("before approval");
  await expect(grade(plan, { ...implementation, files: [-1] })).rejects.toThrow("outside the reviewed skill");
  await expect(grade(plan, { ...implementation, command: "node server.ts" })).rejects.toThrow("expected a message");
});

test("the grader signs in and out using the selected blocks", { timeout: 30_000 }, async () => {
  expect(JSON.parse(await grade(plan, implementation))).toMatchObject({
    skill: "udibo-start-project", sha256: expect.stringMatching(/^[a-f\d]{64}$/), signedIn: true, signedOut: true,
  });
});

test("choosing the hosted settings after approving the local path fails the same fixture", { timeout: 30_000 }, async () => {
  await expect(grade(plan, { ...implementation, files: skill.files.map(file => file.line) })).rejects.toThrow("use the local provider's issuer");
});

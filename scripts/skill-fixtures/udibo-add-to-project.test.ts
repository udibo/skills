import path from "node:path";
import { afterEach, expect, test } from "vitest";

import { readSkillDocument, stopAllProcesses } from "../lib/fixture.ts";
import { replayExistingProject } from "../lib/existing-project-pilot.ts";

const root = path.resolve(import.meta.dirname, "../..");
const skill = await readSkillDocument(path.join(root, "skills/udibo-add-to-project"));

afterEach(stopAllProcesses);

test.each([
  ["hono", "local development provider"],
  ["react-router", "person-supplied tenant"],
  ["hono", "existing provider, phase A"],
])("integrates an existing %s app with the %s", async (framework, scenario) => {
  expect(skill.commands).toEqual([]);
  expect(skill.files.map(file => file.path)).toEqual(["server/sign-in.ts"]);
  await replayExistingProject(skill.files, framework, scenario === "existing provider, phase A");
});

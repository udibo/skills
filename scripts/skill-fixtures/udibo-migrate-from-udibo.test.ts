import path from "node:path";
import { expect, test } from "vitest";

import { readSkillDocument } from "../lib/fixture.ts";
import { replayMigrationPilot } from "../lib/migration-pilot.ts";

test("a synthetic directory and encrypted credential row reach a destination sign-in and native rehash", async () => {
  const root = path.resolve(import.meta.dirname, "../..");
  const skill = await readSkillDocument(path.join(root, "skills/udibo-migrate-from-udibo"));
  expect(skill.commands).toEqual([]);
  expect(skill.files.map(file => file.path)).toEqual(["migration/identity.mjs"]);
  await replayMigrationPilot(skill.files, ["pilot"]);
});

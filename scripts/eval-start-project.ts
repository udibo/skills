/** Two-turn manual model evaluation of a new project's local sign-in. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { fixtureProject, readSkillDocument, writeFileBlocks } from "./lib/fixture.ts";
import { replayLocalSignIn } from "./lib/local-sign-in.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const directory = path.join(ROOT, "skills", "udibo-start-project");
const source = await readFile(path.join(directory, "SKILL.md"), "utf8");
const digest = createHash("sha256").update(source).digest("hex");
const document = await readSkillDocument(directory);

export function planPrompt(): string {
  return [
    "I have an empty project directory and want to add sign-in. Help me decide how to start using the skill below.",
    "Work in conversation only. A fixture operator can apply file blocks once I approve.",
    'Return JSON with "message" (your answer to me) and "files" (an array of file-block line numbers to apply this turn).',
    "", source,
  ].join("\n");
}

function readTurn(turn: unknown): { message: string; files: number[] } {
  assert.ok(turn && typeof turn === "object" && "message" in turn && "files" in turn &&
    Object.keys(turn).length === 2 && typeof turn.message === "string" && turn.message.trim() &&
    Array.isArray(turn.files) && turn.files.every(Number.isSafeInteger), "expected a message and file-block numbers");
  return { message: turn.message, files: turn.files };
}

export function choicePrompt(plan: unknown): string {
  assert.equal(readTurn(plan).files.length, 0, "the agent attempted a file change before approval");
  return [
    "I choose my own local provider. I approve the plan to create the project and sign in locally.",
    "The fixture operator will set up the dependencies, supply the private settings, and run the provider and app.",
    "Return the same JSON format. Choose the file blocks to apply, in order, and tell me what I should do next.",
    "Available file blocks (line of the opening fence, file, first line):",
    ...document.files.map(file => `${file.line} ${file.path} ${file.contents.split("\n")[0]}`),
  ].join("\n");
}

export async function grade(plan: unknown, implementation: unknown): Promise<string> {
  choicePrompt(plan);
  const { files } = readTurn(implementation);
  const selected = files.map(line => {
    const block = document.files.find(file => file.line === line);
    assert.ok(block, "selected a file block outside the reviewed skill");
    return block;
  });
  await using project = await fixtureProject(ROOT);
  await writeFile(path.join(project.path, "package.json"), JSON.stringify({ type: "module" }));
  await writeFileBlocks(project.path, selected);
  const ignore = await readFile(path.join(project.path, ".gitignore"), "utf8");
  assert.ok(ignore.split("\n").includes(".env"), "the project must keep the private settings out of Git");
  await copyFile(path.join(project.path, ".env.example"), path.join(project.path, ".env"));
  const provider = document.commands.find(command => command.text.includes(" udibo-oauth2 idp dev "));
  const app = document.commands.find(command => command.text.startsWith("node --env-file="));
  const providerArgs = provider?.text.split(" udibo-oauth2 ")[1]?.split(" ");
  assert.ok(providerArgs && app, "the reviewed skill must declare its provider and server commands");
  const visit = await replayLocalSignIn(project.path, providerArgs, app.text.split(" ").slice(1));
  assert.equal(visit.requestedPort, visit.callback.port, "the app and callback must use the same port");
  return JSON.stringify({ skill: document.name, sha256: digest, fixture: "local-sign-in", signedIn: true, signedOut: true });
}

async function turnFile(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, "utf8"));
}

if (import.meta.main) {
  const [action, first, second, ...extra] = process.argv.slice(2);
  try {
    if (action === "prompt" && first === undefined) console.log(planPrompt());
    else if (action === "choose" && first && second === undefined) console.log(choicePrompt(await turnFile(first)));
    else if (action === "grade" && first && second && !extra.length) console.log(await grade(await turnFile(first), await turnFile(second)));
    else throw new Error();
  } catch {
    // Model replies, provider banners and callback URLs can contain private values.
    console.error("Evaluation failed. Check the command, JSON turns, selected file blocks and local fixture prerequisites.");
    process.exitCode = 1;
  }
}

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { FileBlock } from "./fixture.ts";

export interface Evaluation {
  planPrompt(): string;
  choicePrompt(plan: unknown): string;
  grade(plan: unknown, implementation: unknown): Promise<string>;
}

export function readTurn(turn: unknown): { message: string; files: number[] } {
  assert.ok(turn && typeof turn === "object" && "message" in turn && "files" in turn &&
    Object.keys(turn).length === 2 && typeof turn.message === "string" && turn.message.trim() &&
    Array.isArray(turn.files) && turn.files.every(Number.isSafeInteger), "expected a message and file-block numbers");
  return { message: turn.message, files: turn.files };
}

export function selectedFiles(files: number[], available: FileBlock[]): FileBlock[] {
  return files.map(line => {
    const block = available.find(file => file.line === line);
    assert.ok(block, "selected a file block outside the reviewed skill");
    return block;
  });
}

async function turnFile(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, "utf8"));
}

export async function runEvaluation(evaluation: Evaluation, args: string[]): Promise<void> {
  const [action, first, second, ...extra] = args;
  try {
    if (action === "prompt" && first === undefined) console.log(evaluation.planPrompt());
    else if (action === "choose" && first && second === undefined) console.log(evaluation.choicePrompt(await turnFile(first)));
    else if (action === "grade" && first && second && !extra.length) console.log(await evaluation.grade(await turnFile(first), await turnFile(second)));
    else throw new Error();
  } catch {
    // Model replies, provider banners and callback URLs can contain private values.
    console.error("Evaluation failed. Check the command, JSON turns, selected file blocks and local fixture prerequisites.");
    process.exitCode = 1;
  }
}

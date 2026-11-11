import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { MARKETPLACE_DIR } from "./outputs.ts";
import { compare } from "./skill.ts";

/** The directories at the repository root that hold the generated plugin marketplace. */
export const TRACKED_ROOTS: readonly string[] = [".claude-plugin", ".cursor-plugin", "plugins"];

/** The command that regenerates the tracked marketplace tree. */
export const REGENERATE = "pnpm build";

/**
 * Replaces the generated marketplace directories under `root` with the build's
 * `plugin-marketplace/` tree, so `.claude-plugin/marketplace.json` sits at the
 * repository root and its plugin sources resolve to tracked paths.
 */
export async function writeTracked(root: string, outputs: Map<string, Buffer>): Promise<void> {
  for (const dir of TRACKED_ROOTS) await rm(path.join(root, dir), { recursive: true, force: true });
  for (const [file, data] of outputs) {
    if (!file.startsWith(`${MARKETPLACE_DIR}/`)) continue;
    const destination = path.join(root, file.slice(MARKETPLACE_DIR.length + 1));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, data);
  }
}

/**
 * Compares the generated directories under `root` with a build's output
 * directory; returns one message per stale, missing or hand-added file.
 */
export async function trackedDrift(root: string, builtDir: string): Promise<string[]> {
  const expected = await filesUnder(path.join(builtDir, MARKETPLACE_DIR));
  const actual = new Set<string>();
  for (const dir of TRACKED_ROOTS) for (const file of await filesUnder(path.join(root, dir), dir)) actual.add(file);
  const problems: string[] = [];
  for (const file of expected) {
    if (!actual.has(file)) {
      problems.push(`${file}: missing from the generated marketplace tree; run \`${REGENERATE}\` and commit the result`);
    } else {
      const [want, have] = await Promise.all([
        readFile(path.join(builtDir, MARKETPLACE_DIR, file)),
        readFile(path.join(root, file)),
      ]);
      if (!want.equals(have)) problems.push(`${file}: differs from what the build produces; run \`${REGENERATE}\` and commit the result`);
    }
  }
  for (const file of [...actual].sort(compare)) {
    if (!expected.includes(file)) problems.push(`${file}: not produced by the build; run \`${REGENERATE}\` and commit the result`);
  }
  return problems;
}

async function filesUnder(dir: string, prefix = ""): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => compare(a.name, b.name))) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await filesUnder(path.join(dir, entry.name), relative)));
    else files.push(relative);
  }
  return files;
}

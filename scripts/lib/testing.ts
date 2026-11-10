import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export const FIXTURES: string = path.resolve(import.meta.dirname, "../../test/fixtures");

export type TempDir = AsyncDisposable & { path: string };

/** Creates a temporary directory removed at the end of the `await using` scope. */
export async function tempDir(): Promise<TempDir> {
  const dir = await mkdtemp(path.join(tmpdir(), "skills-test-"));
  return {
    path: dir,
    [Symbol.asyncDispose]: () => rm(dir, { recursive: true, force: true }),
  };
}

/** Writes a skill directory from a map of relative path to file contents. */
export async function writeSkill(root: string, name: string, files: Record<string, string>): Promise<string> {
  const dir = path.join(root, name);
  for (const [file, contents] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), contents);
  }
  return dir;
}

/** A SKILL.md that passes every check, with frontmatter lines and body replaceable. */
export function skillMd(name: string, options: { frontmatter?: string; body?: string } = {}): string {
  const frontmatter =
    options.frontmatter ??
    [
      `name: ${name}`,
      "description: A test skill that exists only inside one test.",
      "metadata:",
      '  version: "1.0.0"',
      '  targets: "@udibo/oauth2@>=1.0.0 <2.0.0"',
    ].join("\n");
  return `---\n${frontmatter}\n---\n\n${options.body ?? "# Test skill\n\nNothing to do.\n"}`;
}

/** Copies the placeholder fixtures into a fresh skills directory under `root`. */
export async function copyPlaceholders(root: string): Promise<string> {
  const skillsDir = path.join(root, "skills");
  await cp(path.join(FIXTURES, "placeholder-skills"), skillsDir, { recursive: true });
  return skillsDir;
}

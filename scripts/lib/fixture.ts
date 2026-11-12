import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { parseFrontmatter } from "./frontmatter.ts";
import { classifyLines } from "./markdown.ts";
import { parseTargets } from "./skill.ts";
import type { Target } from "./skill.ts";

export type ShellCommand = { text: string; line: number };

export type FileBlock = { path: string; contents: string; line: number };

export type PackagePin = { name: string; version: string; command: string; line: number };

export type SkillDocument = {
  name: string;
  targets: Target[];
  commands: ShellCommand[];
  files: FileBlock[];
};

const SHELL_LANGUAGES = new Set(["sh", "bash", "shell", "zsh", "console"]);
const TITLE = /\btitle="([^"]+)"/;
const EXACT_SPEC = /^((?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;
const INSTALLERS: Record<string, string[]> = { npm: ["install", "i", "add"], pnpm: ["add"], yarn: ["add"], bun: ["add"] };
const RUNNERS = new Set(["npx", "pnpx", "bunx"]);

/**
 * Reads a skill's `SKILL.md` into what a fixture replay needs: every command
 * in a shell-fenced block, every fenced block titled with a file path
 * (```ts title="app.ts"```), and the frontmatter targets. A file block that
 * a skill shows twice, such as a later revision, is returned each time in
 * document order.
 */
export async function readSkillDocument(skillDir: string): Promise<SkillDocument> {
  const text = await readFile(path.join(skillDir, "SKILL.md"), "utf8");
  const { data } = parseFrontmatter(text);
  const metadata = (data["metadata"] ?? {}) as Record<string, string>;
  return {
    name: String(data["name"]),
    targets: parseTargets(metadata["targets"] ?? ""),
    commands: shellCommands(text),
    files: fileBlocks(text),
  };
}

/**
 * Every command in a fenced block whose language is a shell, one entry per
 * command with `\` continuations joined and blank or `#` comment lines
 * dropped. `line` is the 1-based line the command starts on.
 */
export function shellCommands(markdown: string): ShellCommand[] {
  const commands: ShellCommand[] = [];
  for (const block of fencedBlocks(markdown)) {
    if (!SHELL_LANGUAGES.has(block.language)) continue;
    let parts: string[] = [];
    let start = 0;
    block.lines.forEach((raw, index) => {
      const trimmed = raw.trim();
      if (parts.length === 0 && (trimmed === "" || trimmed.startsWith("#"))) return;
      if (parts.length === 0) start = block.firstLine + index;
      const continues = trimmed.endsWith("\\");
      parts.push(continues ? trimmed.slice(0, -1).trim() : trimmed);
      if (!continues) {
        commands.push({ text: parts.join(" ").replace(/^\$\s+/, ""), line: start });
        parts = [];
      }
    });
    if (parts.length > 0) commands.push({ text: parts.join(" "), line: start });
  }
  return commands;
}

/** Every fenced block whose info string carries `title="<path>"`, with its contents. */
export function fileBlocks(markdown: string): FileBlock[] {
  return fencedBlocks(markdown)
    .filter((block) => block.title !== undefined)
    .map((block) => ({ path: block.title ?? "", contents: block.lines.map((line) => `${line}\n`).join(""), line: block.firstLine - 1 }));
}

/**
 * The exact `name@version` packages a command installs or runs: the
 * positionals of `npm install`, `pnpm add`, `yarn add` and `bun add`, and the
 * `--package` (or first positional) of `npx`, `pnpx` and `bunx`. A spec that
 * is not an exact version is left out; the safety rules reject it.
 */
export function packagePins(command: ShellCommand): PackagePin[] {
  const tokens = command.text.split(/\s+/).filter((token) => token !== "");
  const tool = tokens[0] ?? "";
  const specs: string[] = [];
  if (RUNNERS.has(tool)) {
    const named = tokens.flatMap((token, index) => {
      if (token.startsWith("--package=")) return [token.slice("--package=".length)];
      if (token === "--package" || token === "-p") return [tokens[index + 1] ?? ""];
      return [];
    });
    specs.push(...(named.length > 0 ? named : tokens.slice(1).filter((token) => !token.startsWith("-")).slice(0, 1)));
  } else if (tool in INSTALLERS && INSTALLERS[tool]?.includes(tokens[1] ?? "")) {
    specs.push(...tokens.slice(2).filter((token) => !token.startsWith("-")));
  }
  return specs.flatMap((spec) => {
    const match = EXACT_SPEC.exec(spec);
    return match ? [{ name: match[1] ?? "", version: match[2] ?? "", command: command.text, line: command.line }] : [];
  });
}

/**
 * Checks a skill's pinned packages against this repository: each must be
 * installed in `root`'s `node_modules` at exactly the pinned version, so the
 * fixture replay exercises what the skill tells people to install, and each
 * must be named in the skill's `metadata.targets`, at that version when the
 * target gives an exact one. Returns one message per problem.
 */
export async function pinProblems(root: string, document: SkillDocument): Promise<string[]> {
  const problems: string[] = [];
  for (const pin of document.commands.flatMap(packagePins)) {
    const where = `${document.name}/SKILL.md:${pin.line}`;
    const installed = await installedVersion(root, pin.name);
    if (installed !== pin.version) {
      problems.push(
        `${where}: pins ${pin.name}@${pin.version} but this repository has ${installed === undefined ? "no copy" : installed}; add it with pnpm add -D --save-exact ${pin.name}@${pin.version}`,
      );
    }
    const target = document.targets.find((entry) => entry.target === pin.name);
    if (target === undefined) problems.push(`${where}: ${pin.name} is pinned but missing from metadata.targets`);
    else if (EXACT_SPEC.test(`${pin.name}@${target.range}`) && target.range !== pin.version) {
      problems.push(`${where}: pins ${pin.name}@${pin.version} but metadata.targets names ${pin.name}@${target.range}`);
    }
  }
  return problems;
}

/** The version of `name` installed under `root/node_modules`, or `undefined`. */
export async function installedVersion(root: string, name: string): Promise<string | undefined> {
  try {
    const manifest = JSON.parse(await readFile(path.join(root, "node_modules", name, "package.json"), "utf8")) as { version?: unknown };
    return typeof manifest.version === "string" ? manifest.version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Path of a package's executable, read from its `bin` field under
 * `root/node_modules`. Throws when the package is missing or has no such
 * executable.
 */
export async function packageBin(root: string, name: string, bin: string): Promise<string> {
  const dir = path.join(root, "node_modules", name);
  const manifest = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8")) as { bin?: string | Record<string, string> };
  const entry = typeof manifest.bin === "string" ? { [name.split("/").pop() ?? name]: manifest.bin } : (manifest.bin ?? {});
  const file = entry[bin];
  if (file === undefined) throw new Error(`${name} has no "${bin}" executable`);
  return path.join(dir, file);
}

/** Problems with a file block's path: it must be relative and stay inside the project. */
export function filePathProblems(document: SkillDocument): string[] {
  return document.files.flatMap((file) => {
    const normalised = path.posix.normalize(file.path);
    const escapes = path.posix.isAbsolute(file.path) || normalised === ".." || normalised.startsWith("../") || file.path.includes("\\");
    return escapes ? [`${document.name}/SKILL.md:${file.line}: file block "${file.path}" must be a relative path inside the project`] : [];
  });
}

export type FixtureProject = AsyncDisposable & { path: string };

/**
 * Creates an empty project directory under `root/.cache/fixture-projects/`,
 * removed at the end of the `await using` scope. It sits inside the
 * repository so the project resolves the packages this repository pins.
 */
export async function fixtureProject(root: string): Promise<FixtureProject> {
  const parent = path.join(root, ".cache", "fixture-projects");
  await mkdir(parent, { recursive: true });
  const dir = await mkdtemp(path.join(parent, "project-"));
  return { path: dir, [Symbol.asyncDispose]: () => rm(dir, { recursive: true, force: true }) };
}

/** Writes file blocks into `dir`; a later block for the same path replaces an earlier one. */
export async function writeFileBlocks(dir: string, files: FileBlock[]): Promise<void> {
  for (const file of files) {
    const target = path.join(dir, file.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.contents);
  }
}

/** Runs one shell command from a skill, as written, in `cwd`, and resolves with its stdout. Rejects when it exits non-zero. */
export async function runShell(command: string, cwd: string): Promise<string> {
  const { stdout } = await promisify(execFile)("sh", ["-c", command], { cwd, timeout: 60_000 });
  return stdout;
}

export type RunningProcess = AsyncDisposable & { child: ChildProcess; stdout: () => string };

/**
 * Starts a long-running process, such as a server a skill tells someone to
 * start, and resolves once `ready` accepts its stdout so far. Rejects when it
 * exits first or is not ready within `timeoutMs`. Disposing it stops the
 * process and waits for it to exit.
 */
export async function startProcess(
  file: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; ready: (stdout: string) => boolean; timeoutMs?: number },
): Promise<RunningProcess> {
  const child = spawn(file, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => (stderr += chunk));
  const stop = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`not ready after ${options.timeoutMs ?? 15_000} ms\n${stdout}${stderr}`)), options.timeoutMs ?? 15_000);
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (options.ready(stdout)) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`exited with ${code} before it was ready\n${stdout}${stderr}`));
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  } catch (error) {
    await stop();
    throw error;
  }
  return { child, stdout: () => stdout, [Symbol.asyncDispose]: stop };
}

type FencedBlock = { language: string; title: string | undefined; lines: string[]; firstLine: number; indent: number };

function fencedBlocks(markdown: string): FencedBlock[] {
  const blocks: FencedBlock[] = [];
  let current: FencedBlock | undefined;
  for (const entry of classifyLines(markdown)) {
    if (entry.kind === "fence-delimiter") {
      if (current) {
        blocks.push(current);
        current = undefined;
      } else {
        const indent = /^ */.exec(entry.text)?.[0].length ?? 0;
        const info = entry.text.trim().replace(/^(`{3,}|~{3,})/, "").trim();
        current = { language: (info.split(/\s+/)[0] ?? "").toLowerCase(), title: TITLE.exec(info)?.[1], lines: [], firstLine: entry.line + 1, indent };
      }
    } else if (entry.kind === "code" && current) {
      current.lines.push(entry.text.replace(new RegExp(`^ {0,${current.indent}}`), ""));
    }
  }
  return blocks;
}

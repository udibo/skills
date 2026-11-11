import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { releaseTagProblems } from "./lib/release.ts";

/** CLI entry: `node scripts/check-release.ts <tag>` fails unless the tag is `v` plus the package version. */
export async function main(argv: string[] = process.argv.slice(2), root: string = process.cwd()): Promise<number> {
  const tag = argv[0];
  if (tag === undefined || argv.length !== 1) {
    console.error("usage: node scripts/check-release.ts <tag>");
    return 2;
  }
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as { version?: unknown };
  const problems = releaseTagProblems(tag, typeof pkg.version === "string" ? pkg.version : "");
  if (problems.length > 0) {
    problems.forEach((problem) => console.error(problem));
    return 1;
  }
  console.log(`Tag ${tag} matches package.json.`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}

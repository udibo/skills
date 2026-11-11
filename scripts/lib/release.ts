import { readFile } from "node:fs/promises";
import path from "node:path";

import { LICENSE, SEMVER_PATTERN } from "./skill.ts";

/**
 * Checks that a git tag names the release in `package.json`: the tag must be
 * `v` followed by exactly the package version. Returns one message per problem.
 */
export function releaseTagProblems(tag: string, packageVersion: string): string[] {
  if (!tag.startsWith("v") || !SEMVER_PATTERN.test(tag.slice(1))) {
    return [`tag "${tag}" is not a release tag: use v<major>.<minor>.<patch>, for example v1.2.3`];
  }
  if (!SEMVER_PATTERN.test(packageVersion)) {
    return [`package.json version "${packageVersion}" is not a semantic version`];
  }
  if (tag !== `v${packageVersion}`) {
    return [`tag "${tag}" does not match package.json version "${packageVersion}"; expected the tag "v${packageVersion}"`];
  }
  return [];
}

/** Checks that `package.json` and the `LICENSE` file both state the repository licence. */
export async function licenceProblems(root: string): Promise<string[]> {
  const problems: string[] = [];
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as { license?: unknown };
  if (pkg.license !== LICENSE) problems.push(`package.json: license must be "${LICENSE}"`);
  try {
    const text = await readFile(path.join(root, "LICENSE"), "utf8");
    if (!text.startsWith("MIT License\n") || !/^Copyright \(c\) 2026 Udibo$/m.test(text)) {
      problems.push("LICENSE: must be the MIT licence with the copyright line \"Copyright (c) 2026 Udibo\"");
    }
  } catch {
    problems.push("LICENSE: file is missing");
  }
  return problems;
}

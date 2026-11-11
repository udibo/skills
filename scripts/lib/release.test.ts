import { writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test, vi } from "vitest";

import { main } from "../check-release.ts";
import { licenceProblems, releaseTagProblems } from "./release.ts";
import { tempDir } from "./testing.ts";

const REPOSITORY = path.resolve(import.meta.dirname, "../..");

describe("releaseTagProblems", () => {
  test("accepts v plus the package version", () => {
    expect(releaseTagProblems("v1.2.3", "1.2.3")).toEqual([]);
    expect(releaseTagProblems("v1.2.3-rc.1", "1.2.3-rc.1")).toEqual([]);
  });

  test("rejects a tag that differs from the package version", () => {
    expect(releaseTagProblems("v1.2.4", "1.2.3")).toEqual([
      'tag "v1.2.4" does not match package.json version "1.2.3"; expected the tag "v1.2.3"',
    ]);
  });

  test.each(["1.2.3", "v1.2", "release-1", "V1.2.3", "vv1.2.3"])("rejects %s as not a release tag", (tag) => {
    expect(releaseTagProblems(tag, "1.2.3")[0]).toContain("is not a release tag");
  });
});

describe("licenceProblems", () => {
  test("passes for this repository", async () => {
    expect(await licenceProblems(REPOSITORY)).toEqual([]);
  });

  test("reports a package licence that differs and a missing LICENSE file", async () => {
    await using dir = await tempDir();
    await writeFile(path.join(dir.path, "package.json"), '{ "license": "ISC" }\n');
    expect(await licenceProblems(dir.path)).toEqual(['package.json: license must be "MIT"', "LICENSE: file is missing"]);
  });

  test("rejects a LICENSE with the wrong holder", async () => {
    await using dir = await tempDir();
    await writeFile(path.join(dir.path, "package.json"), '{ "license": "MIT" }\n');
    await writeFile(path.join(dir.path, "LICENSE"), "MIT License\n\nCopyright (c) 2026 Someone Else\n");
    expect((await licenceProblems(dir.path))[0]).toContain("LICENSE: must be the MIT licence");
  });
});

describe("check-release CLI", () => {
  test("passes on a matching tag and fails on a mismatch", async () => {
    await using dir = await tempDir();
    await writeFile(path.join(dir.path, "package.json"), '{ "version": "2.0.0" }\n');
    using log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    using error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await main(["v2.0.0"], dir.path)).toBe(0);
    expect(log).toHaveBeenCalledWith("Tag v2.0.0 matches package.json.");
    expect(await main(["v2.0.1"], dir.path)).toBe(1);
    expect(error).toHaveBeenCalledWith('tag "v2.0.1" does not match package.json version "2.0.0"; expected the tag "v2.0.0"');
    expect(await main([], dir.path)).toBe(2);
  });
});

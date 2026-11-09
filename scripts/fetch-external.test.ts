import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { describe, expect, test, vi } from "vitest";

import { build } from "./build.ts";
import { fetchExternal, main, tarballUrl } from "./fetch-external.ts";
import { collectSources, readExternalPins } from "./lib/sources.ts";
import { createTarGz } from "./lib/tar.ts";
import { skillMd, tempDir } from "./lib/testing.ts";

const SKILL = "udibo-oauth2";

function packageSkill(version: string, targets = "@udibo/oauth2@>=1.2.0 <1.3.0"): string {
  return skillMd(SKILL, {
    frontmatter: [
      `name: ${SKILL}`,
      "description: Test copy of a package-owned skill.",
      "metadata:",
      `  version: "${version}"`,
      `  targets: "${targets}"`,
    ].join("\n"),
  });
}

function tarball(files: Record<string, string>): Buffer {
  return createTarGz(Object.entries(files).map(([file, contents]) => ({ path: file, data: Buffer.from(contents) })));
}

function integrity(bytes: Buffer): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

type Registry = AsyncDisposable & { url: string; requests: string[] };

async function registry(routes: Record<string, Buffer>): Promise<Registry> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    const body = routes[request.url ?? ""];
    response.writeHead(body ? 200 : 404).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    [Symbol.asyncDispose]: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function pinFile(root: string, pin: Record<string, string>): Promise<string> {
  const file = path.join(root, "external-skills.json");
  await writeFile(file, JSON.stringify({ skills: [pin] }));
  return file;
}

test("builds the registry tarball URL for scoped and unscoped packages", () => {
  expect(tarballUrl("https://registry.npmjs.org/", "@udibo/oauth2", "1.2.3")).toBe(
    "https://registry.npmjs.org/@udibo/oauth2/-/oauth2-1.2.3.tgz",
  );
  expect(tarballUrl("https://registry.npmjs.org", "zod", "4.0.0")).toBe("https://registry.npmjs.org/zod/-/zod-4.0.0.tgz");
});

describe("fetchExternal", () => {
  test("unpacks the pinned skill from the package tarball and the build publishes it", async () => {
    await using dir = await tempDir();
    const bytes = tarball({
      "package/package.json": "{}",
      [`package/skills/${SKILL}/SKILL.md`]: packageSkill("1.2.3"),
      "package/skills/other-skill/SKILL.md": "not ours",
    });
    await using server = await registry({ "/@udibo/oauth2/-/oauth2-1.2.3.tgz": bytes });
    const externalFile = await pinFile(dir.path, { name: SKILL, package: "@udibo/oauth2", version: "1.2.3", integrity: integrity(bytes) });
    const cacheDir = path.join(dir.path, ".cache", "external");

    expect(await fetchExternal({ externalFile, cacheDir, registry: server.url })).toEqual([SKILL]);
    expect(await readFile(path.join(cacheDir, SKILL, "SKILL.md"), "utf8")).toBe(packageSkill("1.2.3"));

    const result = await build({ skillsDir: path.join(dir.path, "skills"), externalFile, externalCacheDir: cacheDir, outDir: path.join(dir.path, "dist") });
    expect(result.issues).toEqual([]);
    expect(result.skills).toEqual([SKILL]);
  });

  test("rejects a tarball whose sha512 differs from the pinned integrity", async () => {
    await using dir = await tempDir();
    const bytes = tarball({ [`package/skills/${SKILL}/SKILL.md`]: packageSkill("1.2.3") });
    await using server = await registry({ "/@udibo/oauth2/-/oauth2-1.2.3.tgz": bytes });
    const pinned = integrity(Buffer.from("a different tarball"));
    const externalFile = await pinFile(dir.path, { name: SKILL, package: "@udibo/oauth2", version: "1.2.3", integrity: pinned });
    await expect(fetchExternal({ externalFile, cacheDir: path.join(dir.path, "cache"), registry: server.url })).rejects.toThrow(
      `@udibo/oauth2@1.2.3: tarball integrity ${integrity(bytes)} does not match the pinned ${pinned}`,
    );
  });

  test("rejects a package that does not ship the pinned skill", async () => {
    await using dir = await tempDir();
    const bytes = tarball({ "package/package.json": "{}" });
    await using server = await registry({ "/@udibo/oauth2/-/oauth2-1.2.3.tgz": bytes });
    const externalFile = await pinFile(dir.path, { name: SKILL, package: "@udibo/oauth2", version: "1.2.3", integrity: integrity(bytes) });
    await expect(fetchExternal({ externalFile, cacheDir: path.join(dir.path, "cache"), registry: server.url })).rejects.toThrow(
      `@udibo/oauth2@1.2.3 has no skills/${SKILL}/SKILL.md`,
    );
  });

  test("reports a registry error status", async () => {
    await using dir = await tempDir();
    await using server = await registry({});
    const externalFile = await pinFile(dir.path, { name: SKILL, package: "@udibo/oauth2", version: "1.2.3", integrity: integrity(Buffer.from("x")) });
    await expect(fetchExternal({ externalFile, cacheDir: path.join(dir.path, "cache"), registry: server.url })).rejects.toThrow(
      `GET ${server.url}/@udibo/oauth2/-/oauth2-1.2.3.tgz returned 404`,
    );
  });

  test("the CLI fetches nothing when no skill is pinned", async () => {
    await using dir = await tempDir();
    await writeFile(path.join(dir.path, "external-skills.json"), '{ "skills": [] }');
    using log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await main(dir.path)).toBe(0);
    expect(log).toHaveBeenCalledWith("No external skills are pinned.");
  });
});

describe("external skills in the build", () => {
  async function fetched(root: string, version: string, skill: string): Promise<{ externalFile: string; cacheDir: string }> {
    const bytes = tarball({ [`package/skills/${SKILL}/SKILL.md`]: skill });
    await using server = await registry({ [`/@udibo/oauth2/-/oauth2-${version}.tgz`]: bytes });
    const externalFile = await pinFile(root, { name: SKILL, package: "@udibo/oauth2", version, integrity: integrity(bytes) });
    const cacheDir = path.join(root, "cache");
    await fetchExternal({ externalFile, cacheDir, registry: server.url });
    return { externalFile, cacheDir };
  }

  test("rejects a skill that was never fetched", async () => {
    await using dir = await tempDir();
    const externalFile = await pinFile(dir.path, { name: SKILL, package: "@udibo/oauth2", version: "1.2.3", integrity: integrity(Buffer.from("x")) });
    const sources = await collectSources({ skillsDir: path.join(dir.path, "skills"), externalFile, externalCacheDir: path.join(dir.path, "cache") });
    expect(sources.issues).toEqual([
      { skill: SKILL, file: "external-skills.json", message: "not fetched at its pinned version; run node scripts/fetch-external.ts" },
    ]);
  });

  test("rejects a cache fetched at an older pin", async () => {
    await using dir = await tempDir();
    const { externalFile, cacheDir } = await fetched(dir.path, "1.2.3", packageSkill("1.2.3"));
    const pins = await readExternalPins(externalFile);
    await writeFile(externalFile, JSON.stringify({ skills: [{ ...pins[0], version: "1.2.4" }] }));
    const sources = await collectSources({ skillsDir: path.join(dir.path, "skills"), externalFile, externalCacheDir: cacheDir });
    expect(sources.issues.map((issue) => issue.message)).toEqual(["not fetched at its pinned version; run node scripts/fetch-external.ts"]);
  });

  test("requires the skill's version to equal the pinned package version", async () => {
    await using dir = await tempDir();
    const { externalFile, cacheDir } = await fetched(dir.path, "1.2.3", packageSkill("1.2.0"));
    const sources = await collectSources({ skillsDir: path.join(dir.path, "skills"), externalFile, externalCacheDir: cacheDir });
    expect(sources.issues.map((issue) => issue.message)).toEqual(["metadata.version 1.2.0 must equal the pinned @udibo/oauth2 version 1.2.3"]);
  });

  test("requires the skill's targets to name the package", async () => {
    await using dir = await tempDir();
    const { externalFile, cacheDir } = await fetched(dir.path, "1.2.3", packageSkill("1.2.3", "udibo:identity@1"));
    const sources = await collectSources({ skillsDir: path.join(dir.path, "skills"), externalFile, externalCacheDir: cacheDir });
    expect(sources.issues.map((issue) => issue.message)).toEqual(["metadata.targets must name @udibo/oauth2"]);
  });
});

describe("readExternalPins", () => {
  test("rejects a malformed pin with every problem", async () => {
    await using dir = await tempDir();
    const file = await pinFile(dir.path, { name: "Bad", package: "Not A Package", version: "^1.0.0", integrity: "sha256-abc", extra: "x" });
    await expect(readExternalPins(file)).rejects.toThrow(
      [
        `${file}: skills[0] must have exactly name, package, version and integrity`,
        `${file}: skills[0].name is not a valid skill name`,
        `${file}: skills[0].package is not an npm package name`,
        `${file}: skills[0].version must be an exact version`,
        `${file}: skills[0].integrity must be the tarball's sha512 integrity from the registry`,
      ].join("\n"),
    );
  });

  test("rejects a file without a skills array and a duplicate pin", async () => {
    await using dir = await tempDir();
    const file = path.join(dir.path, "external-skills.json");
    await writeFile(file, "{}");
    await expect(readExternalPins(file)).rejects.toThrow(`${file}: expected an object with a "skills" array`);
    const pin = { name: SKILL, package: "@udibo/oauth2", version: "1.2.3", integrity: integrity(Buffer.from("x")) };
    await writeFile(file, JSON.stringify({ skills: [pin, pin] }));
    await expect(readExternalPins(file)).rejects.toThrow(`${file}: skill "${SKILL}" is pinned more than once`);
  });
});

import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
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

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

async function registry(routes: Record<string, Buffer | Handler>): Promise<Registry> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    const route = routes[request.url ?? ""];
    if (typeof route === "function") route(request, response);
    else response.writeHead(route ? 200 : 404).end(route);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    [Symbol.asyncDispose]: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
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

describe("download limits", () => {
  const pin = async (root: string): Promise<string> =>
    pinFile(root, { name: SKILL, package: "@udibo/oauth2", version: "1.2.3", integrity: integrity(Buffer.from("x")) });
  const route = "/@udibo/oauth2/-/oauth2-1.2.3.tgz";

  test("refuses a response whose declared length exceeds the cap without reading it", async () => {
    await using dir = await tempDir();
    let written = 0;
    await using server = await registry({
      [route]: (_request, response) => {
        response.writeHead(200, { "content-length": String(10_000) });
        response.write(Buffer.alloc(100));
        written += 100;
      },
    });
    await expect(
      fetchExternal({ externalFile: await pin(dir.path), cacheDir: path.join(dir.path, "cache"), registry: server.url, maxTarballBytes: 1024 }),
    ).rejects.toThrow(`GET ${server.url}${route} returned more than 1024 bytes`);
    expect(written).toBe(100);
  });

  test("aborts a streamed response once it passes the cap", async () => {
    await using dir = await tempDir();
    let chunks = 0;
    await using server = await registry({
      [route]: (_request, response) => {
        response.writeHead(200);
        const timer = setInterval(() => {
          chunks++;
          response.write(Buffer.alloc(512));
        }, 1);
        response.on("close", () => clearInterval(timer));
      },
    });
    await expect(
      fetchExternal({ externalFile: await pin(dir.path), cacheDir: path.join(dir.path, "cache"), registry: server.url, maxTarballBytes: 4096 }),
    ).rejects.toThrow(`GET ${server.url}${route} returned more than 4096 bytes`);
    expect(chunks).toBeLessThan(1000);
  });

  test("aborts a download slower than the timeout", async () => {
    await using dir = await tempDir();
    await using server = await registry({ [route]: () => undefined });
    await expect(
      fetchExternal({ externalFile: await pin(dir.path), cacheDir: path.join(dir.path, "cache"), registry: server.url, timeoutMs: 100 }),
    ).rejects.toThrow(/aborted due to timeout/);
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

  test("removes files a newer tarball no longer ships", async () => {
    await using dir = await tempDir();
    const cacheDir = path.join(dir.path, "cache");
    const first = tarball({ [`package/skills/${SKILL}/SKILL.md`]: packageSkill("1.2.3"), [`package/skills/${SKILL}/references/old.md`]: "# Old\n" });
    await using server1 = await registry({ "/@udibo/oauth2/-/oauth2-1.2.3.tgz": first });
    const externalFile = await pinFile(dir.path, { name: SKILL, package: "@udibo/oauth2", version: "1.2.3", integrity: integrity(first) });
    await fetchExternal({ externalFile, cacheDir, registry: server1.url });
    await stat(path.join(cacheDir, SKILL, "references", "old.md"));
    const second = tarball({ [`package/skills/${SKILL}/SKILL.md`]: packageSkill("1.2.4", "@udibo/oauth2@>=1.2.0 <1.3.0") });
    await using server2 = await registry({ "/@udibo/oauth2/-/oauth2-1.2.4.tgz": second });
    await pinFile(dir.path, { name: SKILL, package: "@udibo/oauth2", version: "1.2.4", integrity: integrity(second) });
    await fetchExternal({ externalFile, cacheDir, registry: server2.url });
    await expect(stat(path.join(cacheDir, SKILL, "references", "old.md"))).rejects.toThrow(/ENOENT/);
  });

  test("rejects a cache whose recorded integrity differs from the pin", async () => {
    await using dir = await tempDir();
    const { externalFile, cacheDir } = await fetched(dir.path, "1.2.3", packageSkill("1.2.3"));
    const record = path.join(cacheDir, ".pins", `${SKILL}.json`);
    const recorded = JSON.parse(await readFile(record, "utf8"));
    await writeFile(record, JSON.stringify({ ...recorded, integrity: integrity(Buffer.from("other")) }));
    const sources = await collectSources({ skillsDir: path.join(dir.path, "skills"), externalFile, externalCacheDir: cacheDir });
    expect(sources.issues.map((issue) => issue.message)).toEqual(["not fetched at its pinned version; run node scripts/fetch-external.ts"]);
  });

  test("rejects a local skill and an external skill with the same name", async () => {
    await using dir = await tempDir();
    const { externalFile, cacheDir } = await fetched(dir.path, "1.2.3", packageSkill("1.2.3"));
    const skillsDir = path.join(dir.path, "skills");
    await mkdir(path.join(skillsDir, SKILL), { recursive: true });
    await writeFile(path.join(skillsDir, SKILL, "SKILL.md"), packageSkill("1.2.3"));
    const sources = await collectSources({ skillsDir, externalFile, externalCacheDir: cacheDir });
    expect(sources.issues).toEqual([{ skill: SKILL, file: "SKILL.md", message: "two sources publish a skill with this name" }]);
    expect(sources.skills).toEqual([]);
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

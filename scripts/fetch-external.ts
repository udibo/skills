import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fetchedPinPath, readExternalPins } from "./lib/sources.ts";
import type { ExternalPin } from "./lib/sources.ts";
import { readTarGz } from "./lib/tar.ts";

export type FetchOptions = {
  externalFile: string;
  cacheDir: string;
  registry?: string;
  maxTarballBytes?: number;
  timeoutMs?: number;
};

const DEFAULT_REGISTRY = "https://registry.npmjs.org";
const MAX_TARBALL_BYTES = 32 * 1024 * 1024;
const TIMEOUT_MS = 60_000;

/** The registry URL of a package's published tarball at one version. */
export function tarballUrl(registry: string, packageName: string, version: string): string {
  const base = packageName.split("/").pop() ?? packageName;
  return `${registry.replace(/\/$/, "")}/${packageName}/-/${base}-${version}.tgz`;
}

/**
 * Downloads each pinned package tarball, rejects it unless its sha512 equals
 * the pinned integrity, and replaces the cached `skills/<name>/` folder with
 * the one it holds. A download larger than `maxTarballBytes` (32 MiB) or
 * slower than `timeoutMs` (60 s) is aborted. Returns the names fetched.
 * Throws on the first failure.
 */
export async function fetchExternal(options: FetchOptions): Promise<string[]> {
  const pins = await readExternalPins(options.externalFile);
  const registry = options.registry ?? DEFAULT_REGISTRY;
  for (const pin of pins) {
    const tarball = await download(
      tarballUrl(registry, pin.package, pin.version),
      options.maxTarballBytes ?? MAX_TARBALL_BYTES,
      options.timeoutMs ?? TIMEOUT_MS,
    );
    const actual = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
    if (actual !== pin.integrity) {
      throw new Error(`${pin.package}@${pin.version}: tarball integrity ${actual} does not match the pinned ${pin.integrity}`);
    }
    await unpackSkill(tarball, pin, options.cacheDir);
  }
  return pins.map((pin) => pin.name);
}

async function download(url: string, maxBytes: number, timeoutMs: number): Promise<Buffer> {
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`GET ${url} returned ${response.status}`);
  }
  const tooLarge = `GET ${url} returned more than ${maxBytes} bytes`;
  const declared = Number(response.headers.get("content-length"));
  if (response.headers.has("content-length") && declared > maxBytes) {
    await response.body?.cancel();
    throw new Error(tooLarge);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of response.body ?? []) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new Error(tooLarge);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function unpackSkill(tarball: Buffer, pin: ExternalPin, cacheDir: string): Promise<void> {
  const prefix = `package/skills/${pin.name}/`;
  const files = readTarGz(tarball).filter((entry) => entry.path.startsWith(prefix));
  if (!files.some((entry) => entry.path === `${prefix}SKILL.md`)) {
    throw new Error(`${pin.package}@${pin.version} has no skills/${pin.name}/SKILL.md`);
  }
  const target = path.join(cacheDir, pin.name);
  await rm(target, { recursive: true, force: true });
  for (const entry of files) {
    const destination = path.join(target, entry.path.slice(prefix.length));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, entry.data);
  }
  const record = fetchedPinPath(cacheDir, pin.name);
  await mkdir(path.dirname(record), { recursive: true });
  await writeFile(record, `${JSON.stringify(pin, null, 2)}\n`);
}

/** CLI entry: `node scripts/fetch-external.ts`. */
export async function main(root: string = process.cwd()): Promise<number> {
  const fetched = await fetchExternal({
    externalFile: path.join(root, "external-skills.json"),
    cacheDir: path.join(root, ".cache", "external"),
  });
  console.log(fetched.length === 0 ? "No external skills are pinned." : `Fetched ${fetched.join(", ")}.`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}

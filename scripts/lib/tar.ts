import { gunzipSync, gzipSync } from "node:zlib";

export type ArchiveEntry = { path: string; data: Buffer };

const BLOCK = 512;
const GZIP_OS_UNIX = 3;
const MAX_UNPACKED_BYTES = 64 * 1024 * 1024;

/**
 * Writes a reproducible gzip-compressed ustar archive: entries sorted by path,
 * modification time 0, owner 0, mode 0644, and a fixed gzip header, so the
 * same files always give the same bytes on the same Node release.
 */
export function createTarGz(entries: ArchiveEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const blocks: Buffer[] = [];
  for (const entry of sorted) {
    assertSafePath(entry.path);
    blocks.push(header(entry.path, entry.data.length));
    blocks.push(entry.data);
    const padding = (BLOCK - (entry.data.length % BLOCK)) % BLOCK;
    if (padding > 0) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(BLOCK * 2));
  const gzipped = gzipSync(Buffer.concat(blocks), { level: 9 });
  gzipped.writeUInt32LE(0, 4);
  gzipped[9] = GZIP_OS_UNIX;
  return gzipped;
}

/**
 * Reads the regular files of a gzip-compressed tar archive, including the
 * pax and GNU long-name forms npm uses. Throws on a symbolic or hard link, a
 * path that is absolute or contains `..`, or more than 64 MiB unpacked.
 */
export function readTarGz(archive: Buffer): ArchiveEntry[] {
  const tar = gunzipSync(archive, { maxOutputLength: MAX_UNPACKED_BYTES });
  const entries: ArchiveEntry[] = [];
  let offset = 0;
  let pendingPath: string | undefined;
  while (offset + BLOCK <= tar.length) {
    const block = tar.subarray(offset, offset + BLOCK);
    if (block.every((byte) => byte === 0)) break;
    const size = parseInt(field(block, 124, 12).trim() || "0", 8);
    const type = String.fromCharCode(block[156] ?? 0);
    const prefix = field(block, 345, 155);
    const name = field(block, 0, 100);
    const data = tar.subarray(offset + BLOCK, offset + BLOCK + size);
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    if (type === "x") {
      pendingPath = paxPath(data) ?? pendingPath;
      continue;
    }
    if (type === "L") {
      pendingPath = data.toString("utf8").replace(/\0+$/, "");
      continue;
    }
    if (type === "g") continue;
    const entryPath = pendingPath ?? (prefix ? `${prefix}/${name}` : name);
    pendingPath = undefined;
    if (type === "1" || type === "2") throw new Error(`archive contains a link: ${entryPath}`);
    if (type === "5") {
      assertSafePath(entryPath.replace(/\/$/, ""));
      continue;
    }
    if (type !== "0" && type !== "\0") throw new Error(`archive entry ${entryPath} has unsupported type "${type}"`);
    assertSafePath(entryPath);
    entries.push({ path: entryPath, data: Buffer.from(data) });
  }
  return entries;
}

function assertSafePath(entryPath: string): void {
  if (
    entryPath === "" ||
    entryPath.startsWith("/") ||
    /^[A-Za-z]:/.test(entryPath) ||
    entryPath.includes("\\") ||
    entryPath.split("/").includes("..")
  ) {
    throw new Error(`unsafe archive path: ${entryPath}`);
  }
}

function header(entryPath: string, size: number): Buffer {
  const block = Buffer.alloc(BLOCK);
  const bytes = Buffer.from(entryPath, "utf8");
  let name = entryPath;
  let prefix = "";
  if (bytes.length > 100) {
    const split = entryPath.lastIndexOf("/", 155);
    prefix = split > 0 ? entryPath.slice(0, split) : "";
    name = split > 0 ? entryPath.slice(split + 1) : entryPath;
    if (Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155) {
      throw new Error(`archive path is too long: ${entryPath}`);
    }
  }
  block.write(name, 0, 100, "utf8");
  block.write("0000644\0", 100, 8, "ascii");
  block.write("0000000\0", 108, 8, "ascii");
  block.write("0000000\0", 116, 8, "ascii");
  block.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  block.write("00000000000\0", 136, 12, "ascii");
  block.write("        ", 148, 8, "ascii");
  block.write("0", 156, 1, "ascii");
  block.write("ustar\0", 257, 6, "ascii");
  block.write("00", 263, 2, "ascii");
  block.write(prefix, 345, 155, "utf8");
  const checksum = block.reduce((sum, byte) => sum + byte, 0);
  block.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return block;
}

function field(block: Buffer, start: number, length: number): string {
  const raw = block.subarray(start, start + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? length : end).toString("utf8");
}

function paxPath(data: Buffer): string | undefined {
  for (const record of data.toString("utf8").split("\n")) {
    const match = /^\d+ path=(.*)$/.exec(record);
    if (match) return match[1];
  }
  return undefined;
}

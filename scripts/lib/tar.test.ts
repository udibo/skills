import { gunzipSync, gzipSync } from "node:zlib";

import { expect, test } from "vitest";

import { createTarGz, readTarGz } from "./tar.ts";

const entries = [
  { path: "references/notes.md", data: Buffer.from("# Notes\n") },
  { path: "SKILL.md", data: Buffer.from("---\nname: x\n---\n") },
];

test("round-trips files, sorted by path", () => {
  expect(readTarGz(createTarGz(entries))).toEqual([
    { path: "SKILL.md", data: Buffer.from("---\nname: x\n---\n") },
    { path: "references/notes.md", data: Buffer.from("# Notes\n") },
  ]);
});

test("gives byte-identical output for the same files in any order", () => {
  expect(createTarGz(entries).equals(createTarGz([...entries].reverse()))).toBe(true);
});

test("writes a gzip header with no timestamp and a fixed operating system", () => {
  const archive = createTarGz(entries);
  expect(archive.readUInt32LE(4)).toBe(0);
  expect(archive[9]).toBe(3);
});

test("writes owner, mode and time as fixed values", () => {
  const header = gunzipSync(createTarGz([entries[1]!])).subarray(0, 512);
  expect(header.subarray(100, 108).toString("ascii")).toBe("0000644\0");
  expect(header.subarray(136, 148).toString("ascii")).toBe("00000000000\0");
});

test("stores a path longer than 100 bytes in the ustar prefix", () => {
  const long = `${"d".repeat(60)}/${"e".repeat(60)}/file.md`;
  expect(readTarGz(createTarGz([{ path: long, data: Buffer.from("x") }]))[0]?.path).toBe(long);
});

test.each(["../escape.md", "/etc/passwd", "a/../../b", "C:/x", "a\\b"])("refuses to write the unsafe path %s", (unsafe) => {
  expect(() => createTarGz([{ path: unsafe, data: Buffer.alloc(0) }])).toThrow(`unsafe archive path: ${unsafe}`);
});

function rawTar(name: string, type: string, data = Buffer.alloc(0), sizeField?: Buffer | string): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0);
  if (typeof sizeField === "string") header.write(sizeField.padEnd(12, "\0").slice(0, 12), 124, 12, "latin1");
  else if (sizeField) sizeField.copy(header, 124);
  else header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
  header.write(type, 156);
  header.write("        ", 148);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148);
  const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([header, data, padding]);
}

function archiveOf(...blocks: Buffer[]): Buffer {
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

test("rejects a symbolic link entry", () => {
  const archive = archiveOf(rawTar("link", "2"));
  expect(() => readTarGz(archive)).toThrow("archive contains a link: link");
});

test("rejects a traversal path when reading", () => {
  const archive = archiveOf(rawTar("../evil.md", "0", Buffer.from("x")));
  expect(() => readTarGz(archive)).toThrow("unsafe archive path: ../evil.md");
});

test("reads the path from a pax header", () => {
  const record = "30 path=package/skills/x/a.md\n";
  const archive = gzipSync(
    Buffer.concat([
      rawTar("PaxHeader", "x", Buffer.from(record)),
      rawTar("ignored-name", "0", Buffer.from("body")),
      Buffer.alloc(1024),
    ]),
  );
  expect(readTarGz(archive)).toEqual([{ path: "package/skills/x/a.md", data: Buffer.from("body") }]);
});

test("reads the path from a GNU long-name entry and skips directories", () => {
  const archive = gzipSync(
    Buffer.concat([
      rawTar("package/", "5"),
      rawTar("././@LongLink", "L", Buffer.from("package/long-name.md\0")),
      rawTar("truncated", "0", Buffer.from("body")),
      Buffer.alloc(1024),
    ]),
  );
  expect(readTarGz(archive)).toEqual([{ path: "package/long-name.md", data: Buffer.from("body") }]);
});

test.each([
  ["a negative size", "-0000001000"],
  ["a garbage size", "12z4"],
])("rejects %s", (_label, sizeField) => {
  expect(() => readTarGz(archiveOf(rawTar("a.md", "0", Buffer.alloc(0), sizeField)))).toThrow("archive entry at byte 0 has an invalid size field");
});

test("rejects a base-256 size", () => {
  const size = Buffer.alloc(12);
  size[0] = 0x80;
  size[11] = 1;
  expect(() => readTarGz(archiveOf(rawTar("a.md", "0", Buffer.alloc(0), size)))).toThrow("archive entry at byte 0 uses an unsupported base-256 size");
});

test("rejects a size that runs past the end of the archive", () => {
  const header = rawTar("a.md", "0", Buffer.alloc(0), `${(4096).toString(8).padStart(11, "0")}\0`);
  expect(() => readTarGz(gzipSync(header))).toThrow("archive entry at byte 0 declares 4096 bytes past the end of the archive");
});

test("rejects a bad header checksum", () => {
  const block = rawTar("a.md", "0", Buffer.from("x"));
  block[0] = "b".charCodeAt(0);
  expect(() => readTarGz(archiveOf(block))).toThrow("archive entry at byte 0 has a bad header checksum");
});

test("rejects an archive without an end-of-archive block", () => {
  expect(() => readTarGz(gzipSync(rawTar("a.md", "0", Buffer.from("x"))))).toThrow("archive has no end-of-archive block");
});

test.each([
  ["a character device", "3"],
  ["a block device", "4"],
  ["a fifo", "6"],
])("rejects %s entry", (_label, type) => {
  expect(() => readTarGz(archiveOf(rawTar("dev", type)))).toThrow(`archive entry dev has unsupported type "${type}"`);
});

test("rejects a traversal path on a directory entry", () => {
  expect(() => readTarGz(archiveOf(rawTar("../outside/", "5")))).toThrow("unsafe archive path: ../outside");
});

test("rejects an archive larger than the decompression cap", () => {
  const archive = createTarGz([{ path: "big.md", data: Buffer.alloc(8192) }]);
  expect(() => readTarGz(archive, { maxUnpackedBytes: 4096 })).toThrow("Cannot create a Buffer larger than 4096 bytes");
  expect(readTarGz(archive, { maxUnpackedBytes: 16384 })).toHaveLength(1);
});

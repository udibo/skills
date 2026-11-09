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

function rawTar(name: string, type: string, data = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0);
  header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
  header.write(type, 156);
  const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([header, data, padding]);
}

test("rejects a symbolic link entry", () => {
  const archive = gzipSync(Buffer.concat([rawTar("link", "2"), Buffer.alloc(1024)]));
  expect(() => readTarGz(archive)).toThrow("archive contains a link: link");
});

test("rejects a traversal path when reading", () => {
  const archive = gzipSync(Buffer.concat([rawTar("../evil.md", "0", Buffer.from("x")), Buffer.alloc(1024)]));
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

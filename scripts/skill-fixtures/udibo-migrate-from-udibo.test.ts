import { pbkdf2Sync, randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { PasswordCredential } from "@udibo/oauth2/identity";
import { IdentityService } from "@udibo/oauth2/identity";
import { CompactEncrypt, compactDecrypt, generateKeyPair } from "jose";
import { expect, test } from "vitest";

import { fixtureProject, readSkillDocument, writeFileBlocks } from "../lib/fixture.ts";

const root = path.resolve(import.meta.dirname, "../..");

test("a synthetic directory and encrypted credential row reach a destination sign-in and native rehash", async () => {
  const skill = await readSkillDocument(path.join(root, "skills/udibo-migrate-from-udibo"));
  expect(skill.commands).toEqual([]);
  expect(skill.files.map((file) => file.path)).toEqual(["migration/identity.mjs"]);
  await using project = await fixtureProject(root);
  await writeFileBlocks(project.path, skill.files);
  const { createMigrationIdentity, importedPbkdf2 } = await import(pathToFileURL(path.join(project.path, "migration/identity.mjs")).href);

  const tenantId = randomUUID();
  const requestId = randomUUID();
  const sourceUserId = randomUUID();
  const directory = { tenantId, users: [{ id: sourceUserId, username: "pilot" }] };
  const password = randomBytes(24).toString("hex");
  const salt = randomBytes(16).toString("hex");
  const digest = pbkdf2Sync(password, salt, 100_000, 32, "sha256").toString("base64");
  const row = {
    userId: sourceUserId, username: "pilot", email: null,
    password: { format: "pbkdf2-sha256", value: `pbkdf2_sha256$100000$${salt}$${digest}` },
  };
  const { privateKey, publicKey } = await generateKeyPair("RSA-OAEP-256");
  const bound = { req: requestId, idx: 0, fin: true };
  const chunk = await new CompactEncrypt(new TextEncoder().encode(JSON.stringify([row])))
    .setProtectedHeader({ alg: "RSA-OAEP-256", enc: "A256GCM", udibo: bound }).encrypt(publicKey);
  const { protectedHeader, plaintext } = await compactDecrypt(chunk, privateKey, {
    keyManagementAlgorithms: ["RSA-OAEP-256"], contentEncryptionAlgorithms: ["A256GCM"],
  });
  expect(protectedHeader.udibo).toEqual(bound);
  const [record] = JSON.parse(new TextDecoder().decode(plaintext)) as [typeof row];
  const sourceUser = directory.users.find((user) => user.id === record.userId);
  if (!sourceUser) throw new Error("Fixture account mapping missing");
  expect(importedPbkdf2({ password: null })).toBeNull();
  expect(() => importedPbkdf2({ password: { format: "legacy", value: "unknown" } })).toThrow();
  expect(() => importedPbkdf2({ password: { format: "pbkdf2-sha256", value: "invalid" } })).toThrow();

  const localUser = { id: randomUUID(), username: sourceUser.username };
  let legacy: string | null = importedPbkdf2(record);
  let native: PasswordCredential | undefined;
  const users = {
    findByIdentifier: async (identifier: string) => identifier === localUser.username ? localUser : undefined,
    getCredential: async (id: string) => id === localUser.id ? native : undefined,
    getLegacyCredential: async (id: string) => id === localUser.id ? legacy : null,
    replaceCredential: async (id: string, expected: PasswordCredential | undefined, replacement: PasswordCredential) => {
      if (id !== localUser.id || native !== expected) return false;
      native = replacement;
      return true;
    },
    clearLegacyCredential: async (id: string) => { if (id === localUser.id) legacy = null; },
    create: async () => { throw new Error("The pilot must reuse its mapped user"); },
    findByEmail: async () => undefined,
    setCredential: async () => { throw new Error("The native upgrade must compare and set"); },
  };
  const destination = createMigrationIdentity({ users });
  expect(await destination.signIn({ identifier: "pilot", password: randomUUID() })).toBeNull();
  expect(native).toBeUndefined();
  expect(legacy).toBe(record.password.value);
  expect(await destination.signIn({ identifier: "pilot", password })).toEqual(localUser);
  expect(native).toBeDefined();
  expect(legacy).toBeNull();
  expect(await new IdentityService({ users }).signIn({ identifier: "pilot", password })).toEqual(localUser);
});

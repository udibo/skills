import { pbkdf2Sync, randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { PasswordCredential } from "@udibo/oauth2/identity";
import { IdentityService } from "@udibo/oauth2/identity";
import { calculateJwkThumbprint, CompactEncrypt, compactDecrypt, exportJWK, generateKeyPair } from "jose";
import { expect, test } from "vitest";

import { fixtureProject, readSkillDocument, writeFileBlocks } from "../lib/fixture.ts";

const root = path.resolve(import.meta.dirname, "../..");

test("a synthetic directory and encrypted credential row reach a destination sign-in and native rehash", async () => {
  const skill = await readSkillDocument(path.join(root, "skills/udibo-migrate-from-udibo"));
  expect(skill.commands).toEqual([]);
  expect(skill.files.map((file) => file.path)).toEqual(["migration/identity.mjs"]);
  await using project = await fixtureProject(root);
  await writeFileBlocks(project.path, skill.files);
  const { createMigrationIdentity, eligibleDirectoryUser, importedPbkdf2 } = await import(pathToFileURL(path.join(project.path, "migration/identity.mjs")).href);

  const tenantId = randomUUID();
  const requestId = randomUUID();
  const sourceUserId = randomUUID();
  const createdAt = new Date().toISOString();
  const pilot = { id: sourceUserId, username: "pilot", disabledAt: null, deletedAt: null };
  const disabled = { ...pilot, id: randomUUID(), username: "disabled", disabledAt: createdAt };
  const deleted = { ...pilot, id: randomUUID(), username: "deleted", deletedAt: createdAt };
  const directory = [
    { type: "manifest", record: { format: "udibo.directory-export.v2", tenantId, createdAt, containsCredentials: false } },
    ...[pilot, disabled, deleted].map(record => ({ type: "user", record })),
  ].map(line => JSON.stringify(line)).join("\n");
  const [first, ...accounts] = directory.split("\n").map(line => JSON.parse(line));
  expect(first).toMatchObject({ type: "manifest", record: { tenantId, format: "udibo.directory-export.v2", containsCredentials: false } });
  const directoryUsers = new Map(accounts.filter(line => line.type === "user").map(line => [line.record.id, line.record]));
  const password = randomBytes(24).toString("hex");
  const salt = randomBytes(16).toString("hex");
  const digest = pbkdf2Sync(password, salt, 100_000, 32, "sha256").toString("base64");
  const row = {
    userId: sourceUserId, username: "pilot", email: null,
    password: { format: "pbkdf2-sha256", value: `pbkdf2_sha256$100000$${salt}$${digest}` },
  };
  const { privateKey, publicKey } = await generateKeyPair("RSA-OAEP-256");
  const bound = { req: requestId, idx: 0, fin: true };
  const thumbprint = await calculateJwkThumbprint(await exportJWK(publicKey));
  const manifest = {
    format: "udibo.credential-export.v1", requestId, tenantId, createdAt,
    recipientThumbprint: thumbprint, includesMfaSecrets: false,
    encryption: { alg: "RSA-OAEP-256", enc: "A256GCM", serialization: "compact", chunkPayload: "json-array" },
  };
  const rows = [pilot, disabled, deleted].map(user => ({ ...row, userId: user.id, username: user.username }));
  const chunk = await new CompactEncrypt(new TextEncoder().encode(JSON.stringify(rows)))
    .setProtectedHeader({ alg: "RSA-OAEP-256", enc: "A256GCM", udibo: bound }).encrypt(publicKey);
  const artifact = [JSON.stringify(manifest), chunk].join("\n");
  const [header, encrypted] = artifact.split("\n");
  expect(JSON.parse(header!)).toMatchObject({
    tenantId: first.record.tenantId, requestId, recipientThumbprint: thumbprint, includesMfaSecrets: false,
    format: "udibo.credential-export.v1",
  });
  const { protectedHeader, plaintext } = await compactDecrypt(encrypted!, privateKey, {
    keyManagementAlgorithms: ["RSA-OAEP-256"], contentEncryptionAlgorithms: ["A256GCM"],
  });
  expect(protectedHeader.udibo).toEqual(bound);
  const decoded = JSON.parse(new TextDecoder().decode(plaintext)) as (typeof row)[];
  const eligible = decoded.filter(record => eligibleDirectoryUser(directoryUsers, record.userId));
  expect(eligible.map(record => record.userId)).toEqual([pilot.id]);
  expect(() => eligibleDirectoryUser(directoryUsers, randomUUID())).toThrow("no mapped directory account");
  const record = eligible[0]!;
  const sourceUser = eligibleDirectoryUser(directoryUsers, record.userId);
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
  for (const refused of [disabled, deleted]) {
    expect(await destination.signIn({ identifier: refused.username, password })).toBeNull();
  }
  expect(await destination.signIn({ identifier: "pilot", password: randomUUID() })).toBeNull();
  expect(native).toBeUndefined();
  expect(legacy).toBe(record.password.value);
  expect(await destination.signIn({ identifier: "pilot", password })).toEqual(localUser);
  expect(native).toBeDefined();
  expect(legacy).toBeNull();
  expect(await new IdentityService({ users }).signIn({ identifier: "pilot", password })).toEqual(localUser);
});

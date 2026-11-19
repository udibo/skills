import { copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, expect, test } from "vitest";

import { fixtureProject, readSkillDocument, startNode, stopAllProcesses, writeFileBlocks } from "../lib/fixture.ts";
import { Browser, parseBanner, startProvider } from "../lib/oidc-fixture.ts";

const root = path.resolve(import.meta.dirname, "../..");
const skill = await readSkillDocument(path.join(root, "skills/udibo-add-to-project"));
const existing = path.join(root, "test/fixtures/existing-project/server.mjs");

afterEach(stopAllProcesses);

test.each([
  ["hono", "local development provider"],
  ["react-router", "person-supplied tenant"],
  ["hono", "existing provider, phase A"],
])("integrates an existing %s app with the %s", async (framework, scenario) => {
  await using project = await fixtureProject(root);
  const entry = path.join(project.path, "server.mjs");
  await copyFile(existing, entry);
  const original = await readFile(entry, "utf8");
  const ready = (output: string) => /Fixture listening at http:\/\/127\.0\.0\.1:\d+/.test(output);
  const listenOrigin = (output: string) => {
    const origin = /Fixture listening at (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1];
    if (!origin) throw new Error("Missing app origin");
    return origin;
  };
  {
    await using baseline = await startNode(["--input-type=module", "-e", 'import { start } from "./server.mjs"; start();'], {
      cwd: project.path, env: { ...process.env, FIXTURE_FRAMEWORK: framework }, ready,
    });
    const url = listenOrigin(baseline.stdout());
    expect(await (await fetch(url)).text()).toBe("Existing public home");
    expect((await fetch(url + "/records/north")).status).toBe(401);
    expect((await fetch(url + "/pilot-auth/login")).status).toBe(404);
  }
  expect(skill.commands).toEqual([]);
  expect(skill.files.map((file) => file.path)).toEqual(["server/sign-in.ts"]);
  await writeFileBlocks(project.path, skill.files);
  expect(await readFile(entry, "utf8")).toBe(original);

  const callback = "http://localhost:3000/pilot-auth/callback";
  await writeFile(path.join(project.path, "idp.json"), JSON.stringify({
    clients: [{ id: "fixture-client", secret: "development-only", redirectUris: [callback], grants: ["authorization_code", "refresh_token"] }],
    users: [{ id: "fixture-person", username: "fixture", password: "development-only", claims: { name: "Fixture Person" } }],
  }));
  await using provider = await startProvider(project.path, ["idp", "dev", "--port", "0", "--config", "idp.json"]);
  const { issuer, clients, users } = parseBanner(provider.stdout());
  const client = clients.find((value) => value.secret && value.redirectUris.includes(callback));
  const user = users[0];
  if (!client?.secret || !user) throw new Error("Missing local development client or user");
  const pilot = path.join(project.path, "pilot.mjs");
  await copyFile(path.join(path.dirname(existing), "pilot.mjs"), pilot);
  await using app = await startNode([pilot], {
    cwd: project.path,
    env: { ...process.env, FIXTURE_FRAMEWORK: framework, FIXTURE_ISSUER: issuer, FIXTURE_CLIENT: client.id, FIXTURE_SECRET: client.secret, FIXTURE_CALLBACK: callback },
    ready,
  });
  const origin = new URL(callback).origin;
  const actual = listenOrigin(app.stdout());
  const browser = new Browser({ [origin]: actual });

  expect((await browser.open(origin)).body).toBe("Existing public home");
  expect((await browser.open(origin + "/records/north")).status).toBe(401);
  if (scenario.startsWith("existing provider")) {
    expect((await browser.open(origin + "/auth/login")).body).toBe("Original sign-in");
    expect((await browser.open(origin + "/auth/callback")).body).toBe("Original callback");
    expect((await browser.open(origin + "/support")).status).toBe(200);
  }
  const login = await browser.open(origin + "/pilot-auth/login");
  expect(new URL(login.url).origin).toBe(new URL(issuer).origin);
  await browser.submitSignIn(login, user);
  expect(await browser.open(origin + "/records/north")).toMatchObject({ status: 200, body: expect.stringMatching(/^Existing record for .+/) });
  const reloaded = await browser.open(origin + "/records/north");
  expect(reloaded.status).toBe(200);
  expect(reloaded.headers.get("cache-control")).toBe("private, no-store");
  const forbidden = await browser.open(origin + "/records/south");
  expect(forbidden.status).toBe(403);
  expect(forbidden.headers.get("cache-control")).toBe("private, no-store");
  if (scenario.startsWith("existing provider")) {
    expect((await browser.open(origin + "/support")).status).toBe(200);
  }
  await browser.open(origin + "/pilot-auth/logout");
  expect((await browser.open(origin + "/records/north")).status).toBe(401);
  if (scenario.startsWith("existing provider")) {
    expect((await browser.open(origin + "/support")).status).toBe(200);
  }
});

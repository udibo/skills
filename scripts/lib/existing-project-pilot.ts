import assert from "node:assert/strict";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { fixtureProject, startNode, writeFileBlocks, type FileBlock } from "./fixture.ts";
import { Browser, parseBanner, startProvider } from "./oidc-fixture.ts";

const root = path.resolve(import.meta.dirname, "../..");
const existing = path.join(root, "test/fixtures/existing-project/server.mjs");

/** Preserve the existing app, session and account boundaries while rehearsing the pilot mount. */
export async function replayExistingProject(files: FileBlock[], framework: string, preserveProvider: boolean, mount = "/pilot-auth"): Promise<void> {
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
    assert.equal(await (await fetch(url)).text(), "Existing public home");
    assert.equal((await fetch(url + "/records/north")).status, 401);
    assert.equal((await fetch(url + "/pilot-auth/login")).status, 404);
  }
  await writeFileBlocks(project.path, files);
  assert.equal(await readFile(entry, "utf8"), original);

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
    env: { ...process.env, FIXTURE_FRAMEWORK: framework, FIXTURE_ISSUER: issuer, FIXTURE_CLIENT: client.id, FIXTURE_SECRET: client.secret, FIXTURE_CALLBACK: callback, FIXTURE_MOUNT: mount },
    ready,
  });
  const origin = new URL(callback).origin;
  const actual = listenOrigin(app.stdout());
  const browser = new Browser({ [origin]: actual });

  assert.equal((await browser.open(origin)).body, "Existing public home");
  assert.equal((await browser.open(origin + "/records/north")).status, 401);
  if (preserveProvider) {
    assert.equal((await browser.open(origin + "/auth/login")).body, "Original sign-in");
    assert.equal((await browser.open(origin + "/auth/callback")).body, "Original callback");
    assert.equal((await browser.open(origin + "/support")).status, 200);
  }
  const login = await browser.open(origin + mount + "/login");
  assert.equal(new URL(login.url).origin, new URL(issuer).origin, "the pilot login must reach the registered issuer");
  await browser.submitSignIn(login, user);
  const signedIn = await browser.open(origin + "/records/north");
  assert.equal(signedIn.status, 200);
  assert.match(signedIn.body, /^Existing record for .+/);
  const reloaded = await browser.open(origin + "/records/north");
  assert.equal(reloaded.status, 200);
  assert.equal(reloaded.headers.get("cache-control"), "private, no-store");
  const forbidden = await browser.open(origin + "/records/south");
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.headers.get("cache-control"), "private, no-store");
  if (preserveProvider) {
    assert.equal((await browser.open(origin + "/support")).status, 200);
  }
  await browser.open(origin + mount + "/logout");
  assert.equal((await browser.open(origin + "/records/north")).status, 401);
  if (preserveProvider) {
    assert.equal((await browser.open(origin + "/support")).status, 200);
  }
}

import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

import { fixtureProject, readSkillDocument, runNode, runShell, startNode, stopAllProcesses, writeFileBlocks } from "../lib/fixture.ts";
import type { FileBlock } from "../lib/fixture.ts";

import { Browser, parseBanner, startProvider } from "../lib/oidc-fixture.ts";

import { LISTEN_SPY, replayLocalSignIn } from "../lib/local-sign-in.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");
const SKILL_DIR = path.join(ROOT, "skills", "udibo-start-project");
const document = await readSkillDocument(SKILL_DIR);
const skillText = (await readFile(path.join(SKILL_DIR, "SKILL.md"), "utf8")).replace(/\s+/g, " ");

const COMMANDS = {
  nodeVersion: "node --version",
  init: "npm init -y",
  moduleType: "npm pkg set type=module",
  install: "npm install --save-exact @udibo/oauth2@0.52.0 hono@4.13.17 @hono/node-server@2.1.6",
  envFile: "cp .env.example .env",
  provider: "npx --package=@udibo/oauth2@0.52.0 udibo-oauth2 idp dev --issuer http://127.0.0.1:9000 --port 9000",
  app: "node --env-file=.env server.ts",
  hostedApp: "node --env-file=.env server.ts",
};

type AppModule = {
  createApp: (config: { issuer: string; clientId: string; clientSecret: string; callbackUrl: string }) => {
    fetch: (request: Request) => Response | Promise<Response>;
  };
};

function firstFiles(): FileBlock[] {
  const seen = new Set<string>();
  return document.files.filter((file) => !seen.has(file.path) && seen.add(file.path));
}

function envExample(files: FileBlock[] = firstFiles()): Record<string, string> {
  const file = files.findLast((block) => block.path === ".env.example");
  if (file === undefined) throw new Error("the skill has no .env.example block");
  return Object.fromEntries(
    file.contents
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
}

function providerArgs(): string[] {
  const tokens = COMMANDS.provider.split(" ");
  return tokens.slice(tokens.indexOf("udibo-oauth2") + 1);
}

function withoutFlag(args: string[], flag: string): string[] {
  const index = args.indexOf(flag);
  return index === -1 ? args : [...args.slice(0, index), ...args.slice(index + 2)];
}

async function preparedProject(dir: string): Promise<void> {
  await runShell(COMMANDS.init, dir);
  await runShell(COMMANDS.moduleType, dir);
  await writeFileBlocks(dir, firstFiles());
  await runShell(COMMANDS.envFile, dir);
}

afterEach(stopAllProcesses);

describe("udibo-start-project", () => {
  test("every command in the skill is replayed by this file", () => {
    expect(document.commands.map((command) => command.text)).toEqual(Object.values(COMMANDS));
  });

  test("the install command pins exactly the packages the replay uses", async () => {
    const manifest = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8")) as { devDependencies: Record<string, string> };
    for (const spec of COMMANDS.install.split(" ").slice(3)) {
      const at = spec.lastIndexOf("@");
      expect(manifest.devDependencies[spec.slice(0, at)]).toBe(spec.slice(at + 1));
    }
  });

  test("the replay runs on a Node.js release the skill accepts", async () => {
    const version = (await runShell(COMMANDS.nodeVersion, ROOT)).trim();
    expect(Number(/^v(\d+)\./.exec(version)?.[1])).toBeGreaterThanOrEqual(24);
    expect(skillText).toContain("Node.js 24 or later");
  });

  test("creates an ES module project with the skill's files and an env file without a secret", async () => {
    await using project = await fixtureProject(ROOT);
    await preparedProject(project.path);
    const manifest = JSON.parse(await readFile(path.join(project.path, "package.json"), "utf8")) as { type?: string };
    expect(manifest.type).toBe("module");
    expect(firstFiles().map((file) => file.path)).toEqual(["app.ts", "server.ts", ".env.example", ".gitignore"]);
    expect(await readFile(path.join(project.path, ".env"), "utf8")).toContain("AUTH_CLIENT_SECRET=\n");
    expect((await readFile(path.join(project.path, ".gitignore"), "utf8")).split("\n")).toContain(".env");
  });

  test("the skill's TypeScript type-checks against the pinned packages and runs with type stripping", async () => {
    await using project = await fixtureProject(ROOT);
    await preparedProject(project.path);
    await writeFile(
      path.join(project.path, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2024",
          module: "nodenext",
          moduleResolution: "nodenext",
          types: ["node"],
          strict: true,
          noUncheckedIndexedAccess: true,
          erasableSyntaxOnly: true,
          verbatimModuleSyntax: true,
          allowImportingTsExtensions: true,
          noEmit: true,
        },
        include: ["*.ts"],
      }),
    );
    const tsc = path.join(ROOT, "node_modules", ".bin", "tsc");
    await expect(promisify(execFile)(tsc, ["-p", path.join(project.path, "tsconfig.json")], { cwd: project.path, timeout: 60_000, killSignal: "SIGKILL" })).resolves.toBeDefined();
  });

  test("the provider command starts the provider with the fixed issuer the env example names", async () => {
    await using project = await fixtureProject(ROOT);
    await preparedProject(project.path);
    await using provider = await startProvider(project.path, [...providerArgs(), "--port", "0"]);
    const banner = parseBanner(provider.stdout());
    const env = envExample();
    expect(banner.issuer).toBe(env["AUTH_ISSUER"]);
    expect(providerArgs()).toEqual(["idp", "dev", "--issuer", env["AUTH_ISSUER"], "--port", "9000"]);
    expect(provider.stdout()).toContain("Reachable from: this machine only (loopback)");
  });

  test("the env example names a confidential client the provider registers with the app's callback", async () => {
    await using project = await fixtureProject(ROOT);
    await preparedProject(project.path);
    await using provider = await startProvider(project.path, [...providerArgs(), "--port", "0"]);
    const env = envExample();
    const client = parseBanner(provider.stdout()).clients.find((entry) => entry.id === env["AUTH_CLIENT_ID"]);
    expect(client?.secret).toBeTruthy();
    expect(client?.redirectUris).toContain(env["AUTH_CALLBACK_URL"]);
    expect(env["AUTH_CLIENT_SECRET"]).toBe("");
    expect(new URL(env["AUTH_CALLBACK_URL"] ?? "").port).toBe("3000");
  });

  test("the app command, with the person's env file, signs the seeded user in and out through the links on its pages", { timeout: 30_000 }, async () => {
    await using project = await fixtureProject(ROOT);
    await preparedProject(project.path);
    const visit = await replayLocalSignIn(project.path, providerArgs(), COMMANDS.app.split(" ").slice(1));
    expect(visit.requestedPort).toBe(visit.callback.port);
    expect(skillText).toContain("It prints `Listening on http://localhost:3000`");
    expect(skillText).toContain(`open \`${visit.callback.origin}\``);
    expect(skillText).toContain('reading "Signed in as Alice Example"');
  });

  test("the hosted path's app command signs in against an issuer the person supplies, with only .env changed", { timeout: 30_000 }, async () => {
    await using project = await fixtureProject(ROOT);
    await preparedProject(project.path);
    const appBefore = await readFile(path.join(project.path, "app.ts"), "utf8");
    await writeFileBlocks(project.path, document.files);
    expect(await readFile(path.join(project.path, "app.ts"), "utf8")).toBe(appBefore);
    const hostedExample = envExample(document.files);
    expect(hostedExample).toEqual({ AUTH_ISSUER: "", AUTH_CLIENT_ID: "", AUTH_CLIENT_SECRET: "", AUTH_CALLBACK_URL: envExample()["AUTH_CALLBACK_URL"] });
    expect(await readFile(path.join(project.path, ".env.example"), "utf8")).not.toMatch(/udibo\.com/);

    await using tenant = await startProvider(project.path, ["idp", "dev", "--port", "0"]);
    const banner = parseBanner(tenant.stdout());
    expect(banner.issuer).not.toBe(envExample()["AUTH_ISSUER"]);
    const client = banner.clients.find((entry) => entry.secret !== undefined && entry.redirectUris.includes(hostedExample["AUTH_CALLBACK_URL"] ?? ""));
    const user = banner.users[0];
    if (client?.secret === undefined || user === undefined) throw new Error(`unexpected provider banner:\n${tenant.stdout()}`);
    await writeFile(
      path.join(project.path, ".env"),
      `AUTH_ISSUER=${banner.issuer}\nAUTH_CLIENT_ID=${client.id}\nAUTH_CLIENT_SECRET=${client.secret}\nAUTH_CALLBACK_URL=${hostedExample["AUTH_CALLBACK_URL"]}\n`,
    );

    const { PORT: _unset, ...environment } = process.env;
    const [, ...args] = COMMANDS.hostedApp.split(" ");
    await using app = await startNode(["--import", LISTEN_SPY, ...args], {
      cwd: project.path,
      env: environment,
      ready: (stdout) => /Listening on http:\/\/localhost:\d+/.test(stdout),
    });
    const callback = new URL(hostedExample["AUTH_CALLBACK_URL"] ?? "");
    const actual = /Listening on (http:\/\/localhost:\d+)/.exec(app.stdout())?.[1] ?? "";
    const browser = new Browser({ [callback.origin]: actual });
    const signInPage = await browser.followLink(await browser.open(`${callback.origin}/`), "Sign in");
    expect(new URL(signInPage.url).origin).toBe(new URL(banner.issuer).origin);
    const signedIn = await browser.submitSignIn(signInPage, user);
    expect(signedIn).toMatchObject({ url: `${callback.origin}/`, status: 200 });
    expect(signedIn.body).toContain("Signed in as");
    expect(skillText).toContain('"Signed in as" and the user\'s name');
    expect((await browser.followLink(signedIn, "Sign out")).body).toContain("Signed out");
  });

  test("the app refuses a sign-in from a provider whose issuer differs from its configuration", async () => {
    await using project = await fixtureProject(ROOT);
    await preparedProject(project.path);
    await using provider = await startProvider(project.path, [...withoutFlag(providerArgs(), "--issuer"), "--port", "0"]);
    const banner = parseBanner(provider.stdout());
    const env = envExample();
    const client = banner.clients.find((entry) => entry.id === env["AUTH_CLIENT_ID"]);
    if (client?.secret === undefined) throw new Error(`unexpected provider banner:\n${provider.stdout()}`);
    const { createApp } = (await import(pathToFileURL(path.join(project.path, "app.ts")).href)) as AppModule;
    const callbackUrl = env["AUTH_CALLBACK_URL"] ?? "";
    const otherName = banner.issuer.replace("127.0.0.1", "localhost");
    const app = createApp({ issuer: otherName, clientId: client.id, clientSecret: client.secret, callbackUrl });

    const login = await app.fetch(new Request(`${new URL(callbackUrl).origin}/auth/login`));
    expect(login.status).toBeGreaterThanOrEqual(400);
    expect(login.headers.get("location")).toBeNull();
  });

  test("the app command refuses to start without the client secret", async () => {
    await using project = await fixtureProject(ROOT);
    await preparedProject(project.path);
    const [, ...args] = COMMANDS.app.split(" ");
    const result = await runNode(args, { cwd: project.path, env: { ...process.env, PORT: "0" }, timeoutMs: 10_000 });
    expect(result).toMatchObject({ code: 1, timedOut: false });
    expect(result.stderr).toContain("AUTH_CLIENT_SECRET is not set; add it to .env");
  });
});

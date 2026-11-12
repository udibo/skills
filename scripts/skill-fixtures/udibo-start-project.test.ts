import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

import { fixtureProject, packageBin, readSkillDocument, runNode, runShell, startNode, stopAllProcesses, writeFileBlocks } from "../lib/fixture.ts";
import type { FileBlock, RunningProcess } from "../lib/fixture.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");
const SKILL_DIR = path.join(ROOT, "skills", "udibo-start-project");
const document = await readSkillDocument(SKILL_DIR);
const skillText = (await readFile(path.join(SKILL_DIR, "SKILL.md"), "utf8")).replace(/\s+/g, " ");

const COMMANDS = {
  nodeVersion: "node --version",
  init: "npm init -y",
  moduleType: "npm pkg set type=module",
  install: "npm install --save-exact @udibo/oauth2@0.51.0 hono@4.13.17 @hono/node-server@2.1.6",
  envFile: "cp .env.example .env",
  provider: "npx --package=@udibo/oauth2@0.51.0 udibo-oauth2 idp dev --issuer http://127.0.0.1:9000 --port 9000",
  app: "node --env-file=.env server.ts",
};

type Banner = {
  issuer: string;
  users: { username: string; password: string }[];
  clients: { id: string; secret: string | undefined; redirectUris: string[] }[];
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

function envExample(): Record<string, string> {
  const file = firstFiles().find((block) => block.path === ".env.example");
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

function bannerComplete(stdout: string): boolean {
  const clients = stdout.split("\nClients:\n")[1];
  if (clients === undefined) return false;
  const headers = clients.split("\n").filter((line) => /^ {2}\S/.test(line)).length;
  return headers > 0 && (clients.match(/^ {4}access tokens: .*$/gm) ?? []).length === headers;
}

function parseBanner(stdout: string): Banner {
  const issuer = /^Issuer: (\S+)/m.exec(stdout)?.[1] ?? "";
  const [usersPart = "", clientsPart = ""] = (stdout.split("\nUsers:\n")[1] ?? "").split("\nClients:\n");
  const users = [...usersPart.matchAll(/^ {2}(\S+) {2}password: (\S+)/gm)].map((match) => ({ username: match[1] ?? "", password: match[2] ?? "" }));
  const clients = clientsPart.split(/\n(?= {2}\S)/).flatMap((chunk) => {
    const header = /^ {2}(\S+) {2}(?:secret: (\S+)|public client)/.exec(chunk);
    if (!header) return [];
    const uris = /redirect URIs: (.*)$/m.exec(chunk)?.[1] ?? "";
    return [{ id: header[1] ?? "", secret: header[2], redirectUris: uris.split(", ") }];
  });
  return { issuer, users, clients };
}

async function startProvider(cwd: string, args: string[]): Promise<RunningProcess> {
  const bin = await packageBin(ROOT, "@udibo/oauth2", "udibo-oauth2");
  return startNode([bin, ...args], { cwd, ready: bannerComplete });
}

async function preparedProject(dir: string): Promise<void> {
  await runShell(COMMANDS.init, dir);
  await runShell(COMMANDS.moduleType, dir);
  await writeFileBlocks(dir, firstFiles());
  await runShell(COMMANDS.envFile, dir);
}

const LISTEN_SPY = `data:text/javascript,${encodeURIComponent(`
import net from "node:net";
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  if (typeof args[0] === "number" || (typeof args[0] === "string" && /^\\d+$/.test(args[0]))) {
    process.stderr.write("fixture: listen requested port " + args[0] + "\\n");
    args[0] = 0;
  }
  return listen.apply(this, args);
};
`)}`;

type Page = { url: string; status: number; body: string };

class Browser {
  #jars = new Map<string, Map<string, string>>();
  #routes = new Map<string, string>();
  #current: string | undefined;

  constructor(routes: Record<string, string> = {}) {
    for (const [origin, actual] of Object.entries(routes)) this.#routes.set(origin, actual);
  }

  async open(url: string): Promise<Page> {
    this.#current = undefined;
    return this.#navigate(url, { method: "GET" });
  }

  async followLink(page: Page, text: string): Promise<Page> {
    const href = new RegExp(`<a href="([^"]*)">${text}</a>`).exec(page.body)?.[1];
    if (href === undefined) throw new Error(`no "${text}" link on ${page.url}:\n${page.body}`);
    return this.#navigate(new URL(href.replaceAll("&amp;", "&"), page.url).href, { method: "GET" });
  }

  async submitSignIn(page: Page, user: { username: string; password: string }): Promise<Page> {
    const returnTo = (/name="return_to" value="([^"]*)"/.exec(page.body)?.[1] ?? "").replaceAll("&amp;", "&");
    const action = /<form method="post" action="([^"]*)" id="sign-in-form">/.exec(page.body)?.[1];
    if (action === undefined) throw new Error(`no sign-in form on ${page.url}:\n${page.body}`);
    return this.#navigate(new URL(action, page.url).href, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ return_to: returnTo, username: user.username, password: user.password }),
    });
  }

  async #navigate(start: string, init: RequestInit): Promise<Page> {
    let url = start;
    let request = init;
    for (let hop = 0; hop < 10; hop++) {
      const target = new URL(url);
      const headers = new Headers(request.headers);
      const cookies = [...(this.#jars.get(target.host) ?? [])].map(([name, value]) => `${name}=${value}`).join("; ");
      if (cookies !== "") headers.set("cookie", cookies);
      headers.set("sec-fetch-site", this.#current === undefined ? "none" : this.#current === target.origin ? "same-origin" : "cross-site");
      const actual = this.#routes.get(target.origin);
      const response = await fetch(actual === undefined ? url : `${actual}${target.pathname}${target.search}`, { ...request, headers, redirect: "manual" });
      this.#store(target.host, response);
      this.#current = target.origin;
      const location = response.headers.get("location");
      if (response.status < 300 || response.status >= 400 || location === null) return { url, status: response.status, body: await response.text() };
      url = new URL(location, url).href;
      request = { method: "GET" };
    }
    throw new Error(`more than ten redirects from ${start}`);
  }

  #store(host: string, response: Response): void {
    const jar = this.#jars.get(host) ?? new Map<string, string>();
    for (const header of response.headers.getSetCookie()) {
      const pair = header.split(";")[0] ?? "";
      const name = pair.slice(0, pair.indexOf("="));
      const value = pair.slice(pair.indexOf("=") + 1);
      if (/max-age=0/i.test(header) || value === "") jar.delete(name);
      else jar.set(name, value);
    }
    this.#jars.set(host, jar);
  }
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
    await using provider = await startProvider(project.path, [...withoutFlag(providerArgs(), "--issuer"), "--port", "0"]);
    const banner = parseBanner(provider.stdout());
    const env = envExample();
    const client = banner.clients.find((entry) => entry.id === env["AUTH_CLIENT_ID"]);
    const user = banner.users[0];
    if (client?.secret === undefined || user === undefined) throw new Error(`unexpected provider banner:\n${provider.stdout()}`);
    const envPath = path.join(project.path, ".env");
    const personal = (await readFile(envPath, "utf8"))
      .replace(`AUTH_ISSUER=${env["AUTH_ISSUER"]}\n`, `AUTH_ISSUER=${banner.issuer}\n`)
      .replace("AUTH_CLIENT_SECRET=\n", `AUTH_CLIENT_SECRET=${client.secret}\n`);
    await writeFile(envPath, personal);

    const { PORT: _unset, ...environment } = process.env;
    const [, ...args] = COMMANDS.app.split(" ");
    await using app = await startNode(["--import", LISTEN_SPY, ...args], {
      cwd: project.path,
      env: environment,
      ready: (stdout) => /Listening on http:\/\/localhost:\d+/.test(stdout),
    });
    const callback = new URL(env["AUTH_CALLBACK_URL"] ?? "");
    expect(/fixture: listen requested port (\d+)/.exec(app.stderr())?.[1]).toBe(callback.port);
    const actual = /Listening on (http:\/\/localhost:\d+)/.exec(app.stdout())?.[1] ?? "";
    expect(skillText).toContain("It prints `Listening on http://localhost:3000`");
    expect(skillText).toContain(`open \`${callback.origin}\``);

    const browser = new Browser({ [callback.origin]: actual });
    const home = await browser.open(`${callback.origin}/`);
    expect(home.body).toContain("Signed out");
    const signInPage = await browser.followLink(home, "Sign in");
    expect(new URL(signInPage.url).origin).toBe(new URL(banner.issuer).origin);
    const signedIn = await browser.submitSignIn(signInPage, user);
    expect(signedIn).toMatchObject({ url: `${callback.origin}/`, status: 200 });
    expect(signedIn.body).toContain("Signed in as Alice Example");
    expect(skillText).toContain('reading "Signed in as Alice Example"');

    const signedOut = await browser.followLink(signedIn, "Sign out");
    expect(signedOut).toMatchObject({ url: `${callback.origin}/`, status: 200 });
    expect(signedOut.body).toContain("Signed out");
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

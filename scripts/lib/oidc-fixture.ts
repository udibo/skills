import path from "node:path";

import { packageBin, startNode, type RunningProcess } from "./fixture.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");

type Banner = {
  issuer: string;
  users: { username: string; password: string }[];
  clients: { id: string; secret: string | undefined; redirectUris: string[] }[];
};

function bannerComplete(stdout: string): boolean {
  const clients = stdout.split("\nClients:\n")[1];
  if (clients === undefined) return false;
  const headers = clients.split("\n").filter((line) => /^ {2}\S/.test(line)).length;
  return headers > 0 && (clients.match(/^ {4}access tokens: .*$/gm) ?? []).length === headers;
}

export function parseBanner(stdout: string): Banner {
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

export async function startProvider(cwd: string, args: string[]): Promise<RunningProcess> {
  const bin = await packageBin(ROOT, "@udibo/oauth2", "udibo-oauth2");
  return startNode([bin, ...args], { cwd, ready: bannerComplete });
}

type Page = { headers: Headers; url: string; status: number; body: string };

export class Browser {
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
      if (response.status < 300 || response.status >= 400 || location === null) return { headers: response.headers, url, status: response.status, body: await response.text() };
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

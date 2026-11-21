import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { startNode } from "./fixture.ts";
import { Browser, parseBanner, startProvider } from "./oidc-fixture.ts";

export const LISTEN_SPY: string = `data:text/javascript,${encodeURIComponent(`
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

/** Drive the local provider, app, callback and logout on an already prepared skill project. */
export async function replayLocalSignIn(
  dir: string, providerArgs: string[], appArgs: string[],
): Promise<{ callback: URL; requestedPort: string | undefined }> {
  const issuerFlag = providerArgs.indexOf("--issuer");
  assert.ok(issuerFlag >= 0, "local provider command needs a configured issuer");
  const configuredIssuer = providerArgs[issuerFlag + 1];
  const args = providerArgs.toSpliced(issuerFlag, 2);
  await using provider = await startProvider(dir, [...args, "--port", "0"]);
  const banner = parseBanner(provider.stdout());
  const envPath = path.join(dir, ".env");
  const source = await readFile(envPath, "utf8");
  const env = Object.fromEntries(source.trimEnd().split("\n").map(line => line.split("=")));
  assert.equal(env.AUTH_ISSUER, configuredIssuer, "use the local provider's issuer");
  assert.equal(env.AUTH_CLIENT_SECRET, "", "leave the secret for the person to supply");
  const client = banner.clients.find(entry => entry.id === env.AUTH_CLIENT_ID);
  const user = banner.users[0];
  assert.ok(client?.secret && user, "the local provider must register the selected client and user");
  await writeFile(envPath, source.replace(`AUTH_ISSUER=${configuredIssuer}\n`, `AUTH_ISSUER=${banner.issuer}\n`)
    .replace("AUTH_CLIENT_SECRET=\n", `AUTH_CLIENT_SECRET=${client.secret}\n`));

  const { PORT: _unset, ...environment } = process.env;
  await using app = await startNode(["--import", LISTEN_SPY, ...appArgs], {
    cwd: dir, env: environment, ready: stdout => /Listening on http:\/\/localhost:\d+/.test(stdout),
  });
  const callback = new URL(env.AUTH_CALLBACK_URL ?? "");
  const actual = /Listening on (http:\/\/localhost:\d+)/.exec(app.stdout())?.[1] ?? "";
  const browser = new Browser({ [callback.origin]: actual });
  const home = await browser.open(`${callback.origin}/`);
  assert.ok(home.body.includes("Signed out"), "visitor starts signed out");
  const form = await browser.followLink(home, "Sign in");
  assert.equal(new URL(form.url).origin, new URL(banner.issuer).origin);
  const signedIn = await browser.submitSignIn(form, user);
  assert.equal(signedIn.status, 200);
  assert.equal(signedIn.url, `${callback.origin}/`);
  assert.ok(signedIn.body.includes("Signed in as Alice Example"), "the callback must show the synthetic user's name");
  const signedOut = await browser.followLink(signedIn, "Sign out");
  assert.equal(signedOut.status, 200);
  assert.equal(signedOut.url, `${callback.origin}/`);
  assert.ok(signedOut.body.includes("Signed out"), "sign-out must end the session");
  return { callback, requestedPort: /fixture: listen requested port (\d+)/.exec(app.stderr())?.[1] };
}

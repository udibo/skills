---
name: udibo-start-project
description: Start a new web project that signs people in with the @udibo/oauth2 package, beginning on a local development identity provider that needs no account, with a later step that moves it to a hosted Udibo Identity tenant. Use when someone wants a new app with sign-in built on Udibo, wants to try Udibo Identity before signing up, or asks to scaffold a Hono backend with an OAuth2 sign-in flow.
license: MIT
compatibility: Needs Node.js 24 or later, npm, and access to the npm registry. Written for a new, empty project directory.
metadata:
  version: "0.1.0"
  targets: "@udibo/oauth2@0.51.0, hono@4.13.17, @hono/node-server@2.1.6"
---

# Start a project on Udibo

This skill creates a small Hono web app that signs people in through the
`@udibo/oauth2` backend-for-frontend (BFF). It starts against the package's
local development identity provider, so nobody needs a Udibo account to try
it. Moving to a hosted Udibo Identity tenant is a separate, later step that
changes configuration, not the sign-in code.

Every package version below is exact. Use these versions, not newer ones: this
skill was tested with them, and a different version may behave differently.

## Rules for the whole skill

- **Plan first.** Before you create or change any file, show the person the
  plan in _Step 1_ and wait for them to approve it. If they change it, show
  the revised plan again.
- **Secrets stay out of the conversation.** The person writes the client
  secret into `.env` in their own editor. Never ask them for it, never open or
  search `.env`, and never run a command that would display its contents. You
  may create `.env` by copying `.env.example`, which holds no secret.
- **The person runs the local provider themselves**, in a terminal of their
  own. Its startup banner lists the development client's credentials and an
  admin token, and that banner must not land in this conversation.
- **Only run the commands written here**, in fenced blocks, as written.

## Step 1: Agree the plan

Confirm three things with the person, then present the plan below with their
answers filled in:

1. The new project directory. It must be empty, or not exist yet.
2. Node.js 24 or later is installed. You may check the version:

   ```sh
   node --version
   ```

3. Whether they already have one of Udibo's service templates. Those are
   private repositories that Udibo grants access to, and each expects a hosted
   tenant from the start. If they have one, stop here and follow that
   template's README instead; this skill builds its own smaller starting app.

The plan to present:

- Create `package.json` and install three packages at exact versions:
  `@udibo/oauth2` 0.51.0, `hono` 4.13.17 and `@hono/node-server` 2.1.6.
- Create four files: `app.ts` (the sign-in routes and a home page),
  `server.ts` (reads `.env` settings and listens on port 3000), `.env.example`
  (setting names, no secret) and `.gitignore` (keeps `.env` and
  `node_modules/` out of Git).
- Copy `.env.example` to `.env`. The person then adds the development client
  secret to `.env` themselves.
- The person starts the local identity provider in their own terminal.
- Start the app, and the person signs in at `http://localhost:3000`.
- Not included: a database, a production session store, or deployment. The
  local provider and the app's sessions both live in memory, for development
  only.

## Step 2: Create the project

In the project directory, create `package.json`, mark it as an ES module
package and install the three packages:

```sh
npm init -y
npm pkg set type=module
npm install --save-exact @udibo/oauth2@0.51.0 hono@4.13.17 @hono/node-server@2.1.6
```

## Step 3: Write the files

Create each file exactly as shown.

```ts title="app.ts"
import { DirectClient } from "@udibo/oauth2/client";
import { HonoBff, MemoryAuthRequestStorageFactory, MemorySessionStore } from "@udibo/oauth2/hono/bff";
import { Hono } from "hono";
import { html } from "hono/html";

export type AppConfig = {
  issuer: string;
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
};

export function createApp(config: AppConfig): Hono {
  const callback = new URL(config.callbackUrl);
  const bff = new HonoBff({
    client: new DirectClient({
      issuer: config.issuer,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      redirectUri: callback.href,
      scope: "openid profile email",
    }),
    sessionStore: new MemorySessionStore(),
    authRequestStorage: new MemoryAuthRequestStorageFactory(),
    cookie: { secure: callback.protocol === "https:" },
    paths: { basePath: "", callback: callback.pathname },
  });

  const app = new Hono();
  app.route("/", bff.routes());
  app.get("/", async (c) => {
    c.header("Cache-Control", "private, no-store");
    const session = await bff.readSession(c);
    if (!session.isAuthenticated) {
      return c.html(html`<h1>Signed out</h1><a href="/auth/login">Sign in</a>`);
    }
    const name = String(session.user?.name ?? session.user?.sub ?? "");
    return c.html(html`<h1>Signed in as ${name}</h1><a href="/auth/logout">Sign out</a>`);
  });
  return app;
}
```

```ts title="server.ts"
import { serve } from "@hono/node-server";

import { createApp } from "./app.ts";

const {
  AUTH_ISSUER,
  AUTH_CLIENT_ID,
  AUTH_CLIENT_SECRET,
  AUTH_CALLBACK_URL,
  PORT = "3000",
} = process.env;

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is not set; add it to .env`);
  return value;
}

const app = createApp({
  issuer: required("AUTH_ISSUER", AUTH_ISSUER),
  clientId: required("AUTH_CLIENT_ID", AUTH_CLIENT_ID),
  clientSecret: required("AUTH_CLIENT_SECRET", AUTH_CLIENT_SECRET),
  callbackUrl: required("AUTH_CALLBACK_URL", AUTH_CALLBACK_URL),
});

serve({ fetch: app.fetch, port: Number(PORT) }, (info) => {
  console.log(`Listening on http://localhost:${info.port}`);
});
```

```ini title=".env.example"
AUTH_ISSUER=http://127.0.0.1:9000
AUTH_CLIENT_ID=dev-client
AUTH_CLIENT_SECRET=
AUTH_CALLBACK_URL=http://localhost:3000/callback
```

```gitignore title=".gitignore"
node_modules/
.env
```

What these settings mean:

- `AUTH_ISSUER` is fixed at `http://127.0.0.1:9000`, and the provider is
  started with exactly that issuer in _Step 4_. The two must match: the app
  refuses a sign-in whose issuer differs from the one it was configured with.
- `dev-client` is the confidential client the local provider registers when it
  runs without a config file. Its registered redirect URIs include
  `http://localhost:3000/callback`, which is why the app mounts its callback at
  `/callback` and listens on port 3000.

Then create `.env` from the example:

```sh
cp .env.example .env
```

## Step 4: The person starts the local provider

Ask the person to run this in a separate terminal of their own, inside the
project directory, and to leave it running:

```sh
npx --package=@udibo/oauth2@0.51.0 udibo-oauth2 idp dev --issuer http://127.0.0.1:9000 --port 9000
```

Then ask them to open `.env` in their editor and set `AUTH_CLIENT_SECRET` to
the value their terminal lists for `dev-client`. Tell them they don't need to
report it back; you only need to hear that `.env` is saved.

Tell the person what this provider is:

- It is for development and CI only. Its users, clients and tokens live in
  memory and are lost when it stops, and its seeded passwords are plain text.
- Its `/__admin/` endpoints mint tokens for any seeded user without a
  password, guarded only by the admin token. It listens on `127.0.0.1` alone
  by default; it should never be exposed to a network the person doesn't
  control.

## Step 5: Start the app and sign in

Once the person says `.env` is saved and the provider is running, start the
app:

```sh
node --env-file=.env server.ts
```

It prints `Listening on http://localhost:3000`. Ask the person to open
`http://localhost:3000`, choose **Sign in**, and sign in as the seeded user
their provider terminal lists. They should return to a page reading "Signed in
as Alice Example". **Sign out** returns them to the signed-out page.

If the sign-in fails, check these before changing code:

- The provider was started with `--issuer http://127.0.0.1:9000`, matching
  `AUTH_ISSUER`.
- The app is on port 3000, so the callback matches the registered
  `http://localhost:3000/callback`.
- The person saved `AUTH_CLIENT_SECRET` in `.env` and restarted the app after
  saving.

Stop here unless the person asks to move to a hosted tenant.

## Later: move to a hosted Udibo Identity tenant

Do this only when the person asks for it. It needs a Udibo account. The code
in `app.ts` and `server.ts` does not change; the settings do.

Again, present this plan and wait for approval before changing anything:

1. **The person registers the app on their tenant**, following
   [Connect your first application](https://www.udibo.com/docs/identity/get-started).
   For local development they set Environment to Development, check
   Confidential client, choose the Authorization code and Refresh token grants,
   and add `http://localhost:3000/callback` as a redirect URI. Saving creates
   the client ID; they create the client secret on the application's page.
2. **The person edits `.env` themselves**: `AUTH_ISSUER` becomes the
   **Issuer** shown on the application's page (their tenant's own host, in the
   form `https://{tenant-id}.udibo.com`), `AUTH_CLIENT_ID` becomes the new
   client ID, and `AUTH_CLIENT_SECRET` becomes the new client secret. Again,
   they keep these values to themselves.
3. **You update `.env.example`** so it no longer suggests the local provider,
   leaving every value empty except `AUTH_CALLBACK_URL`:

   ```ini title=".env.example"
   AUTH_ISSUER=
   AUTH_CLIENT_ID=
   AUTH_CLIENT_SECRET=
   AUTH_CALLBACK_URL=http://localhost:3000/callback
   ```

4. **The person stops the local provider** and restarts the app with the same
   command as in _Step 5_. A new tenant has no users, so they create a test
   user on the tenant's **Users** page and sign in as that user.

Before the app serves real users, two parts of the starting app must change.
Tell the person; don't make these changes without a plan they have approved:

- `MemorySessionStore` and `MemoryAuthRequestStorageFactory` keep sign-in
  state in one process's memory: a restart signs everyone out, and a second
  instance can't see the first one's sessions. `@udibo/oauth2/hono/bff` also
  exports `EncryptedCookieSessionStore` and
  `EncryptedCookieAuthRequestStorage`, and accepts a session store backed by a
  shared database. The
  [Use Udibo's identity service](https://www.udibo.com/docs/oauth2/guides/use-udibo)
  guide covers the choice.
- The app must be served over HTTPS, with an `https://` callback URL
  registered on the tenant and set as `AUTH_CALLBACK_URL`. The app marks its
  session cookie `Secure` whenever the callback URL uses `https:`.

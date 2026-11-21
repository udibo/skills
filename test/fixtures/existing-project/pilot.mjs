import { MemoryAuthRequestStorageFactory, MemorySessionStore } from "@udibo/oauth2/hono/bff";

import { start } from "./server.mjs";
import { createSignIn } from "./server/sign-in.ts";

const bff = createSignIn({
  issuer: process.env.FIXTURE_ISSUER,
  clientId: process.env.FIXTURE_CLIENT,
  clientSecret: process.env.FIXTURE_SECRET,
  callbackUrl: process.env.FIXTURE_CALLBACK,
}, {
  sessionStore: new MemorySessionStore(),
  authRequestStorage: new MemoryAuthRequestStorageFactory(),
});

start({
  mount: (app) => app.route(process.env.FIXTURE_MOUNT, bff.routes()),
  sessionFor: (c) => bff.readSession(c),
});

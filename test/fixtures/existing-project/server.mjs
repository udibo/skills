import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createContext, createStaticHandler, RouterContextProvider } from "react-router";


export function start({ sessionFor = async () => ({ isAuthenticated: false }), mount = () => {} } = {}) {
  const app = new Hono();
  app.get("/", (c) => c.text("Existing public home"));
  app.get("/auth/login", (c) => {
    c.header("Set-Cookie", "fixture_support_session=active; HttpOnly; Path=/");
    return c.text("Original sign-in");
  });
  app.get("/auth/callback", (c) => c.text("Original callback"));
  app.get("/support", (c) => c.text("Support", c.req.header("cookie")?.includes("fixture_support_session=active") ? 200 : 401));
  mount(app);

  const members = new Map([[JSON.stringify([process.env.FIXTURE_ISSUER, "fixture-person"]), "north"]]);

  function record(session, owner) {
    const headers = { "Cache-Control": "private, no-store" };
    if (!session.isAuthenticated) return new Response("Sign in", { status: 401, headers });
    if (members.get(JSON.stringify([process.env.FIXTURE_ISSUER, session.user?.sub])) !== owner) return new Response("Forbidden", { status: 403, headers });
    return new Response("Existing record for " + session.user.sub, { headers });
  }

  if (process.env.FIXTURE_FRAMEWORK === "react-router") {
    const sessionContext = createContext();
    const router = createStaticHandler([{
      id: "record",
      path: "/records/:owner",
      loader: ({ context, params }) => record(context.get(sessionContext), params.owner),
    }]);
    app.get("/records/:owner", async (c) => {
      const context = new RouterContextProvider();
      context.set(sessionContext, await sessionFor(c));
      return router.queryRoute(c.req.raw, { routeId: "record", requestContext: context });
    });
  } else {
    app.get("/records/:owner", async (c) => record(await sessionFor(c), c.req.param("owner")));
  }

  serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, ({ port }) => {
    console.log("Fixture listening at http://127.0.0.1:" + port);
  });
}

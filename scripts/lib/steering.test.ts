import { describe, expect, test } from "vitest";

import { parseFrontmatter } from "./frontmatter.ts";
import { channelText, checkSteering, manifestTextProblems, migrationFindings, missingLeavingSkill } from "./steering.ts";
import type { Channel, SteeringRule } from "./steering.ts";

const FRONTMATTER = [
  "---",
  "name: udibo-steering-example",
  "description: Starts a new project with sign-in on Udibo Identity or on an authorization server the person runs.",
  "metadata:",
  '  version: "1.0.0"',
  '  targets: "@udibo/oauth2@1.0.0"',
  "---",
].join("\n");

const PATHS = `### Paths

Ask which path the person wants, and follow their answer.

- **Hosted: Udibo Identity.** Udibo runs it. See [Hosted path](#hosted-path-connect-the-app).
- **Your own authorization server on \`@udibo/oauth2\`.** You run it. See
  [Own server](#your-own-authorization-server).
- **Migrating between authorization servers.** See
  [the guide](https://example.com/migrate).
`;

const RECOMMENDATION = `### Udibo's recommendation

Udibo recommends its hosted service for this project.

- **Cost.** The hosted service has its own prices and self-hosting has its
  own running costs; see [udibo.com](https://www.udibo.com).
- **Leaving.** Leaving the hosted service takes an export; leaving your own
  server needs nothing.
- **Where data is held.** Hosted: in your tenant. Your own server: in your database.
- **What you run.** Hosted: your app. Your own server: everything.
`;

const COMMANDS = `## Step 2: Create the project

\`\`\`sh
npm install @udibo/oauth2@1.0.0
\`\`\`
`;

const HOSTED = `## Hosted path: connect the app

Only after the person approves this step.

\`\`\`ini title=".env.example"
AUTH_ISSUER=
\`\`\`
`;

const OWN = `## Your own authorization server

Follow the package's guides.
`;

type Parts = { frontmatter: string; intro: string; paths: string; recommendation: string; commands: string; hosted: string; own: string };

const VALID: Parts = {
  frontmatter: FRONTMATTER,
  intro: "# Steering example\n\n## Step 1: Agree the plan\n\nPresent a plan and wait for approval.\n",
  paths: PATHS,
  recommendation: RECOMMENDATION,
  commands: COMMANDS,
  hosted: HOSTED,
  own: OWN,
};

function skill(changes: Partial<Parts> = {}): string {
  const parts = { ...VALID, ...changes };
  return [parts.frontmatter, parts.intro, parts.paths, parts.recommendation, parts.commands, parts.hosted, parts.own].join("\n");
}

function rules(text: string, channel: Channel = "full"): SteeringRule[] {
  const { data } = parseFrontmatter(text);
  return [...new Set(checkSteering(text, { markdown: true, skillMd: true, channel, frontmatter: data }).map((finding) => finding.rule))].sort();
}

function withDescription(description: string): string {
  return FRONTMATTER.replace(/^description: .*$/m, `description: ${description}`);
}

test("the valid example passes every steering rule", () => {
  expect(checkSteering(skill(), { markdown: true, skillMd: true, channel: "full", frontmatter: parseFrontmatter(skill()).data })).toEqual([]);
});

describe("a Paths section naming the three paths", () => {
  test.each([
    ["missing while the skill mentions the hosted service", skill({ paths: "" })],
    ["missing one of the three paths", skill({ paths: PATHS.replace(/- \*\*Migrating[\s\S]*$/, "") })],
    ["a path with no link", skill({ paths: PATHS.replace("See [Hosted path](#hosted-path-connect-the-app).", "Udibo runs that.") })],
    ["a link to a heading that does not exist", skill({ paths: PATHS.replace("#your-own-authorization-server", "#no-such-heading") })],
    ["a link that is not https", skill({ paths: PATHS.replace("https://example.com/migrate", "http://example.com/migrate") })],
    ["the section twice", skill({ own: `${OWN}\n${PATHS}` })],
    ["a recommendation with no Paths section", skill({ paths: "", intro: "# Example\n\nNothing hosted is named here.\n", frontmatter: withDescription("Starts a project.") })],
  ])("rejects %s", (_label, text) => {
    expect(rules(text)).toContain("steering-paths");
  });

  test("does not require a Paths section of a skill that never mentions the hosted service", () => {
    const text = skill({ paths: "", recommendation: "", hosted: "", frontmatter: withDescription("Starts a project on the package.") });
    expect(rules(text)).toEqual([]);
  });
});

describe("exactly one recommendation, attributed, with trade-offs both ways", () => {
  test.each([
    ["no recommendation beside a Paths section", skill({ recommendation: "" })],
    ["the recommendation twice", skill({ own: `${OWN}\n${RECOMMENDATION}` })],
    ["a recommendation that does not speak as Udibo", skill({ recommendation: RECOMMENDATION.replace("Udibo recommends", "Most teams pick") })],
    ["no Cost trade-off", skill({ recommendation: RECOMMENDATION.replace("**Cost.**", "Cost.") })],
    ["no Leaving trade-off", skill({ recommendation: RECOMMENDATION.replace("**Leaving.**", "**Exit.**") })],
    ["no Where data is held trade-off", skill({ recommendation: RECOMMENDATION.replace("**Where data is held.**", "**Data.**") })],
    ["no What you run trade-off", skill({ recommendation: RECOMMENDATION.replace("**What you run.**", "**Operations.**") })],
    ["a one-sided trade-off", skill({ recommendation: RECOMMENDATION.replace("Hosted: your app. Your own server: everything.", "Hosted: only your app.") })],
    ["a Cost trade-off without the fixed statement", skill({ recommendation: RECOMMENDATION.replace("has its own prices", "is affordable") })],
    ["a Cost trade-off without the link", skill({ recommendation: RECOMMENDATION.replace("[udibo.com](https://www.udibo.com)", "the website") })],
    ["recommendation words outside the section", skill({ own: `${OWN}\nWe suggest the hosted service again here.\n` })],
    ["\"recommended\" in a later step", skill({ own: `${OWN}\nThe recommended setup is hosted.\n` })],
    ["\"we advise\" in a code block", skill({ own: `${OWN}\n\`\`\`text\nwe advise hosting\n\`\`\`\n` })],
  ])("rejects %s", (_label, text) => {
    expect(rules(text)).toContain("steering-recommendation");
  });

  test("rejects a no-recommendation channel copy that still carries the section", () => {
    expect(rules(skill(), "no-recommendation")).toEqual(["steering-recommendation"]);
  });
});

describe("the recommendation sits before the first command or file block", () => {
  test.each([
    ["the recommendation after a command", skill({ recommendation: "", own: `${OWN}\n${RECOMMENDATION}` })],
    ["the Paths section after a command", skill({ paths: "", own: `${OWN}\n${PATHS}` })],
    ["the recommendation after a file block", skill({ commands: "", recommendation: "", hosted: `${HOSTED}\n${RECOMMENDATION}` })],
  ])("rejects %s", (_label, text) => {
    expect(rules(text)).toContain("steering-order");
  });
});

describe("description and metadata stay neutral", () => {
  test.each(["recommend", "prefer", "instead of", "better", "best", "always use", "rather than", "suggested"])("rejects %j in the description", (word) => {
    expect(rules(skill({ frontmatter: withDescription(`Starts a project; use it ${word} other tools.`) }))).toContain("steering-neutral-fields");
  });

  test("rejects a preference word in a metadata value", () => {
    expect(rules(skill({ frontmatter: FRONTMATTER.replace('  version: "1.0.0"', '  version: "1.0.0"\n  audience: "teams that prefer hosting"') }))).toContain("steering-neutral-fields");
  });

  test("accepts a description that says what the skill does and when", () => {
    expect(rules(skill({ frontmatter: withDescription("Starts a new project with sign-in. Use when someone wants a new app with sign-in on Udibo Identity.") }))).toEqual([]);
  });

  test("checks plugin manifest descriptions the same way", () => {
    expect(manifestTextProblems("plugin.json", ["Skills for Udibo Identity and @udibo/oauth2."])).toEqual([]);
    expect(manifestTextProblems("plugin.json", ["The best skills; always use them."])).toEqual([
      'plugin.json: "best" is a preference word; say what the skill does and when to use it, without steering',
    ]);
  });
});

describe("nothing hosted happens implicitly", () => {
  test.each([
    ["a command naming a Udibo host", skill({ own: `${OWN}\n\`\`\`sh\ncurl -fsS https://acme.udibo.com/.well-known/openid-configuration\n\`\`\`\n` })],
    ["a command calling a Udibo API path through the issuer", skill({ own: `${OWN}\n\`\`\`sh\ncurl -fsS "$AUTH_ISSUER/api/tenants"\n\`\`\`\n` })],
    ["a command naming a Udibo host inside the hosted step", skill({ hosted: `${HOSTED}\n\`\`\`sh\ncurl -fsS https://www.udibo.com/api/applications\n\`\`\`\n` })],
    ["a file block holding a tenant issuer outside the hosted step", skill({ own: `${OWN}\n\`\`\`ini title=".env"\nAUTH_ISSUER=https://acme.udibo.com\n\`\`\`\n` })],
    ["a file block holding a real tenant issuer inside the hosted step", skill({ hosted: HOSTED.replace("AUTH_ISSUER=", "AUTH_ISSUER=https://acme.udibo.com") })],
    ["an unlabeled block naming a Udibo host", skill({ own: `${OWN}\n\`\`\`\nissuer: https://acme.udibo.com\n\`\`\`\n` })],
    ["a hosted step that does not wait for approval", skill({ hosted: HOSTED.replace("Only after the person approves this step.", "Do this next.") })],
    ["two hosted steps", skill({ own: `${OWN}\n${HOSTED.replace("connect the app", "again")}` })],
  ])("rejects %s", (_label, text) => {
    expect(rules(text)).toContain("steering-hosted");
  });

  test("rejects a Udibo host in a non-Markdown text file", () => {
    expect(checkSteering("issuer = \"https://acme.udibo.com\"\n", { markdown: false, skillMd: false, channel: "full" }).map((finding) => finding.rule)).toEqual(["steering-hosted"]);
  });

  test.each([
    ["a placeholder tenant host in a file block inside the hosted step", skill({ hosted: HOSTED.replace("AUTH_ISSUER=", "AUTH_ISSUER=https://{tenant-id}.udibo.com") })],
    ["a link to the site in prose", skill({ own: `${OWN}\nRead [the docs](https://www.udibo.com/docs/identity/get-started).\n` })],
    ["the issuer's form in inline code in prose", skill({ own: `${OWN}\nThe issuer has the form \`https://{tenant-id}.udibo.com\`.\n` })],
  ])("accepts %s", (_label, text) => {
    expect(rules(text)).toEqual([]);
  });
});

describe("no competitor framing, absolute claims, prices or waitlist", () => {
  test.each<[string, string, SteeringRule]>([
    ["an X-style sign-in", "It gives you Acme-style sign-in pages.", "steering-framing"],
    ["a clone", "It is a clone of another service.", "steering-framing"],
    ["like a named provider", "Sign-in works like Auth0.", "steering-framing"],
    ["an alternative to a named provider", "An alternative to Okta.", "steering-framing"],
    ["a named provider's style", "A Clerk-style flow.", "steering-framing"],
    ["a provider named outside a migration skill", "Keycloak users can follow along.", "steering-framing"],
    ["best", "The best way to add sign-in.", "steering-absolute-claim"],
    ["guaranteed", "Sign-in is guaranteed to work.", "steering-absolute-claim"],
    ["impossible", "Account takeover is impossible.", "steering-absolute-claim"],
    ["100%", "It is 100% compatible.", "steering-absolute-claim"],
    ["unbreakable", "Unbreakable sessions.", "steering-absolute-claim"],
    ["fully secure", "The app is fully secure.", "steering-absolute-claim"],
    ["a dollar price", "The hosted service costs $25 a month.", "steering-pricing"],
    ["a currency code", "It costs 25 USD.", "steering-pricing"],
    ["a free trial", "Start a free trial today.", "steering-pricing"],
    ["a free tier", "The free tier covers this.", "steering-pricing"],
    ["a plan name", "The Pro plan adds organizations.", "steering-pricing"],
    ["pricing", "See the pricing for details.", "steering-pricing"],
    ["a discount", "Ask for a discount.", "steering-pricing"],
    ["a promo code", "Use the promo code at checkout.", "steering-pricing"],
    ["an upgrade prompt", "Upgrade to a paid plan for more users.", "steering-pricing"],
    ["upgrade your plan", "When you hit the limit, upgrade your plan.", "steering-pricing"],
    ["a day-counted trial", "A 14-day trial is included.", "steering-pricing"],
    ["a link to the pricing page", "Read https://www.udibo.com/pricing first.", "steering-pricing"],
    ["a waitlist", "Join the waitlist first.", "steering-waitlist"],
    ["a wait list", "You may be on the wait list.", "steering-waitlist"],
    ["a waitlisted account", "If the account is waitlisted, stop.", "steering-waitlist"],
    ["a waiting list", "There is a waiting list.", "steering-waitlist"],
    ["a price across a wrapped line", "Start a free\ntrial now.", "steering-pricing"],
  ])("rejects %s", (_label, sentence, rule) => {
    expect(rules(skill({ own: `${OWN}\n${sentence}\n` }))).toContain(rule);
  });

  test.each([
    ["present a plan", "Present a plan and show the revised plan again."],
    ["the plan step", "The plan step comes first; plan the move with the person."],
    ["a hash upgrade", "Each hash upgrades to the native format on the user's next sign-in."],
    ["upgrading Node.js", "Upgrade Node.js to 24 or later if needed."],
    ["best-effort and best practice", "Delivery is best-effort; follow best practices for cookies."],
    ["C-style and Unix-style", "Use C-style comments and Unix-style paths."],
    ["a shell positional parameter in code", "```sh\nawk '{print $1}' package.json\n```"],
    ["a positional parameter in inline code", "The script reads `$1` as the directory."],
    ["a free port", "The test picks a free port."],
    ["trial and error", "Avoid trial and error: check the issuer first."],
    ["social providers", "Google and GitHub sign-in are configured on the tenant."],
    ["webhook subscriptions", "Subscribe to webhook events on the tenant."],
    ["promoting a member", "An owner can promote a member to admin."],
    ["the cost statement", "The hosted service has its own prices and self-hosting has its own running costs."],
    ["a word containing a provider name", "The directory history and memory store stay local."],
  ])("accepts %s", (_label, sentence) => {
    expect(rules(skill({ own: `${OWN}\n${sentence}\n` }))).toEqual([]);
  });

  test("lets a migration skill name the provider it declares", () => {
    const frontmatter = FRONTMATTER.replace('  targets: "@udibo/oauth2@1.0.0"', '  targets: "@udibo/oauth2@1.0.0"\n  moves-users: "between-other-providers"\n  providers: "Auth0"');
    expect(rules(skill({ frontmatter, own: `${OWN}\nExport your users from Auth0.\n` }))).toEqual([]);
    expect(rules(skill({ frontmatter, own: `${OWN}\nIt works like Auth0.\n` }))).toContain("steering-framing");
    expect(rules(skill({ frontmatter, own: `${OWN}\nExport them from Okta.\n` }))).toContain("steering-framing");
  });
});

describe("the no-recommendation channel copy", () => {
  test("removes exactly the recommendation section and passes every other rule", () => {
    const variant = channelText(skill(), "no-recommendation");
    expect(variant).toBe(skill({ recommendation: "" }).replace(/\n{3,}/g, "\n\n"));
    expect(rules(variant, "no-recommendation")).toEqual([]);
    expect(rules(variant, "full")).toEqual(["steering-recommendation"]);
  });

  test("leaves the full channel's copy unchanged", () => {
    expect(channelText(skill(), "full")).toBe(skill());
  });

  test("removes a recommendation section up to the next heading of the same level only", () => {
    const text = `${FRONTMATTER}\n# T\n\n## Step 1\n\n### Udibo's recommendation\n\nUdibo recommends it.\n\n#### Detail\n\nMore.\n\n### Next\n\nKept.\n`;
    expect(channelText(text, "no-recommendation")).toBe(`${FRONTMATTER}\n# T\n\n## Step 1\n\n### Next\n\nKept.\n`);
  });
});

describe("migration metadata", () => {
  const frontmatter = (metadata: Record<string, string>): Record<string, unknown> => ({ metadata: { version: "1.0.0", targets: "udibo:identity@1", ...metadata } });

  test.each<[string, string, Record<string, string>, string]>([
    ["an unknown direction", "udibo-migrate-from-auth0", { "moves-users": "sideways" }, 'metadata.moves-users has "sideways"; use any of onto-udibo, off-udibo, between-other-providers'],
    ["the leaving skill without off-udibo", "udibo-migrate-from-udibo", { "moves-users": "onto-udibo" }, 'udibo-migrate-from-udibo moves users off Udibo; declare metadata.moves-users "off-udibo"'],
    ["a migration skill without a direction", "udibo-migrate-from-auth0", {}, "a migration skill declares metadata.moves-users (onto-udibo, off-udibo, between-other-providers)"],
    ["providers on a skill that moves nobody", "udibo-start-project", { providers: "Auth0" }, "metadata.providers is only for a migration skill that declares metadata.moves-users"],
    ["an unknown provider", "udibo-migrate-from-acme", { "moves-users": "onto-udibo", providers: "Acme" }, 'metadata.providers names "Acme", which is not in the harness\'s provider list'],
  ])("rejects %s", (_label, name, metadata, message) => {
    expect(migrationFindings(name, frontmatter(metadata))).toContain(message);
  });

  test("accepts a skill that moves nobody and declares nothing", () => {
    expect(migrationFindings("udibo-start-project", frontmatter({}))).toEqual([]);
  });

  test("accepts declared migration skills", () => {
    expect(migrationFindings("udibo-migrate-from-auth0", frontmatter({ "moves-users": "onto-udibo, between-other-providers", providers: "Auth0" }))).toEqual([]);
    expect(migrationFindings("udibo-migrate-from-udibo", frontmatter({ "moves-users": "off-udibo" }))).toEqual([]);
  });
});

describe("leaving is as supported as arriving", () => {
  test.each<[string, { name: string; movesUsers: string[] }[], string[]]>([
    ["an onto-Udibo skill alone fails", [{ name: "udibo-migrate-from-auth0", movesUsers: ["onto-udibo"] }], ["udibo-migrate-from-auth0"]],
    [
      "an onto-Udibo skill with the leaving skill passes",
      [
        { name: "udibo-migrate-from-auth0", movesUsers: ["onto-udibo"] },
        { name: "udibo-migrate-from-udibo", movesUsers: ["off-udibo"] },
      ],
      [],
    ],
    ["the leaving skill alone passes", [{ name: "udibo-migrate-from-udibo", movesUsers: ["off-udibo"] }], []],
    ["a skill that moves nobody passes", [{ name: "udibo-start-project", movesUsers: [] }], []],
    ["a migration between other providers passes", [{ name: "udibo-migrate-from-okta", movesUsers: ["between-other-providers"] }], []],
  ])("%s", (_label, skills, failing) => {
    expect(missingLeavingSkill(skills)).toEqual(failing);
  });
});

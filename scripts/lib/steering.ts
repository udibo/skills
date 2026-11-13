import { classifyLines, fencedBlocks, SHELL_LANGUAGES, withoutInlineCode } from "./markdown.ts";
import { normalise } from "./safety.ts";

export type SteeringRule =
  | "steering-paths"
  | "steering-recommendation"
  | "steering-order"
  | "steering-neutral-fields"
  | "steering-hosted"
  | "steering-framing"
  | "steering-absolute-claim"
  | "steering-pricing"
  | "steering-waitlist"
  | "steering-migration";

export type SteeringFinding = { rule: SteeringRule; line: number; message: string };

/**
 * Which copy of a skill is being checked. `full` is the source as written.
 * `no-recommendation` is the copy built for a channel whose rules do not allow
 * a recommendation: the recommendation section is removed and must be absent.
 */
export type Channel = "full" | "no-recommendation";

export const CHANNELS: readonly Channel[] = ["full", "no-recommendation"];

export const PATHS_HEADING = "Paths";
export const RECOMMENDATION_HEADING = "Udibo's recommendation";
export const ATTRIBUTION = "Udibo recommends";
export const HOSTED_STEP_PREFIX = "Hosted path:";
export const PATH_LABELS: readonly string[] = [
  "Hosted: Udibo Identity",
  "Your own authorization server on @udibo/oauth2",
  "Migrating between authorization servers",
];
export const TRADE_OFF_LABELS: readonly string[] = ["Cost", "Leaving", "Where data is held", "What you run"];
export const COST_STATEMENT = "the hosted service has its own prices and self-hosting has its own running costs";
export const COST_LINK = "https://www.udibo.com";
export const LEAVING_SKILL = "udibo-migrate-from-udibo";
export const MOVES_USERS: readonly string[] = ["onto-udibo", "off-udibo", "between-other-providers"];

type Provider = { name: string; pattern: string; flags: string };

const exact = (name: string): Provider => ({ name, pattern: escape(name), flags: "" });
const word = (name: string): Provider => ({ name, pattern: `(?<!^|[.!?:]\\s+|^\\s*[-*+]\\s+)${escape(name)}`, flags: "" });
const loose = (name: string, pattern: string): Provider => ({ name, pattern, flags: "i" });

const PROVIDER_LIST: readonly Provider[] = [
  loose("Auth0", "auth[ -]?0"),
  loose("Okta", "okta"),
  word("Clerk"),
  loose("Cognito", "(?:amazon[ -])?cognito"),
  loose("Firebase Auth", "firebase[ -]auth(?:entication)?"),
  loose("Supabase Auth", "supabase[ -]auth"),
  loose("Keycloak", "key[ -]?cloak"),
  loose("WorkOS", "work[ -]?os"),
  loose("Stytch", "stytch"),
  loose("FusionAuth", "fusion[ -]?auth"),
  word("Descope"),
  exact("Kinde"),
  exact("Ory"),
  loose("Zitadel", "zitadel"),
  loose("Authentik", "authentik"),
  exact("Logto"),
  loose("Microsoft Entra", "(?:microsoft[ -])?entra(?:[ -]id)?"),
  loose("Azure AD", "azure[ -]ad(?:[ -]b2c)?"),
  loose("Ping Identity", "ping[ -]identity"),
  loose("OneLogin", "one[ -]?login"),
  loose("Frontegg", "frontegg"),
  loose("PropelAuth", "propel[ -]?auth"),
  loose("SuperTokens", "super[ -]?tokens"),
  loose("Better Auth", "better[ -]auth"),
  loose("NextAuth", "next[ -]?auth"),
  loose("Auth.js", "auth\\.js"),
  exact("Hanko"),
];

/**
 * Identity providers a skill may name only when it is a migration skill that
 * declares the provider in `metadata.providers`, by these names. Names that
 * are also ordinary words match only as written (and Clerk and Descope not at
 * the start of a sentence); the others match in any case and spacing
 * (`auth0`, `Auth 0`).
 */
export const PROVIDERS: readonly string[] = PROVIDER_LIST.map((provider) => provider.name);

const STEERING_SUBJECT = /\bUdibo\b|\bhost(?:ed|ing)\b|\bmanaged\b|\bself-host\w*|\bown (?:authorization )?server\b|\bauthorization servers?\b|\bpaths?\b/i;
const PRODUCT_SUBJECT = /\bUdibo\b|\bhosted\b|@udibo\/oauth2|\bthe package\b|\bthis skill\b/i;
const HOSTED_SUBJECT = /\bUdibo\b|\bhosted\b|\btenants?\b|\bsign[- ]?up\b|udibo\.com/i;
const PREFERENCE_IN_BODY =
  /\brecommend\w*|\bsuggest\w*|\bwe advise\b|\bprefer(?:s|red|able)?\b|\bbetter (?:choice|option|fit|path|bet)\b|\bbest\b|\bshould (?:use|pick|choose|go with|start with)\b|\bwe(?:'d| would) (?:go with|pick|choose)\b|\b(?:pick|choose|go with) (?:the )?hosted\b|\bideal\b|\beasiest (?:path|option|way|choice)\b|\btop (?:choice|pick)\b|\bsuperior\b|\bmost teams\b|\bUdibo likes\b|\bthe way to go\b|\bgo with the (?:managed|hosted) (?:option|service|path)\b/i;
const PREFERENCE_IN_FIELDS =
  /\b(?:recommend\w*|suggest\w*|prefer\w*|instead of|rather than|better|best|always use|superior|we advise|number one|only (?:choice|option)|ideal|top (?:choice|pick)|should (?:pick|use|choose)|easiest)\b|#1\b/i;
const ABSOLUTE_ALLOWED = /\bbest[- ]effort\b|\bbest practices?\b/gi;
const ABSOLUTE_CLAIM =
  /\b(?:best|guarantee[ds]?|impossible|unbreakable|bulletproof|foolproof|uncopyable|unhackable)\b|\b100\s?%|\b(?:perfectly|completely|fully|totally)\s+secure\b|\bzero[- ]risk\b|\bnever fails\b/i;
const CURRENCY_AMOUNT = /[$€£¥]\s?\d|\b\d[\d,.]*\s?(?:USD|EUR|GBP|dollars?|euros?)\b/i;
const PRICING_PHRASE =
  /\bfree\s+(?:trials?|tiers?|plans?|accounts?|of charge|to use)\b|\bfor free\b|\bstarts? (?:out )?free\b|\bno credit card\b|\bper (?:month|year|user|seat)\b|\/(?:mo|month|yr|year)\b|\btrial\s+(?:period|plan|version|account)s?\b|\b(?:start|begin)\s+(?:a|your)\s+trial\b|\b\d+[- ]day\s+trial\b|\b(?:free|paid|pro|premium|starter|business|enterprise|team|hobby|growth|scale)\s+(?:plans?|tiers?)\b|\b(?:pricing|subscription)\s+plans?\b|\bpricing\b|\bpaid\s+subscriptions?\b|\bsubscribe\s+to\s+(?:a\s+|the\s+|our\s+)?(?:plan|tier|service)\b|\bdiscount(?:s|ed)?\b|\bpromo(?:s|tional)?\b|\bpromo[- ]codes?\b|\bcoupons?\b|\bupgrade\s+(?:now|today)\b|\bupgrade\s+(?:to\s+)?(?:your\s+|a\s+|the\s+)?(?:plan|tier|account|subscription|paid|pro|premium|business|enterprise|team)\b/i;
const PRICING_PAGE = /udibo\.[a-z]+\/pricing/i;
const WAITLIST = /\bwait[- ]?list(?:ed|s|ing)?\b|\bwaiting list\b|\bearly access\b|\brequest access\b|\bprivate beta\b|\binvite[- ]only\b|\bby invitation only\b/i;
const FRAMING_STYLE = /\b[\w.]+-style\s+(?:sign[- ]in|sign[- ]up|log[- ]?in|auth\w*|identity|experience|flows?|pages?|dashboard|api|sdk)\b|\bclone of\b/i;
const UDIBO_HOST = /(?:^|[^a-z0-9.-])((?:[a-z0-9{}<>_-]+\.)*udibo\.(?:com|io|dev|app|net|org|co|ai|cloud|sh|xyz|tech|site))(?![a-z0-9-])/i;
const ISSUER_VARIABLE = /\$\{?\w*(?:ISSUER|UDIBO|TENANT)\w*\}?|process\.env\.\w*(?:ISSUER|UDIBO|TENANT)\w*/i;
const NETWORK_USE = /\b(?:curl|wget|xh|httpie|http|https|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|fetch|nc|ssh|openssl)\b|\/api\//i;
const PLACEHOLDER_TENANT_HOST = /^(?:\{[^{}]+\}|<[^<>]+>)\.udibo\.com$/i;
const LINK = /\[[^\]]*\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+"[^"]*")?\s*\)/g;
const LINK_TARGET = /\]\(\s*(?:<[^>]*>|[^)\s]+)(?:\s+"[^"]*")?\s*\)/g;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const SETEXT = /^ {0,3}(=+|-+)\s*$/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;
const DANGLING =
  /\bas recommended\b|\b(?:the|this|that|Udibo's) recommendation\b|\brecommendation (?:above|below)\b|\b(?:see|described|listed|stated|explained|mentioned) above\b|\*\*(?:Cost|Leaving|Where data is held|What you run)[.:]?\*\*/i;
const HASH_COMMENTS = new Set([...SHELL_LANGUAGES, "ini", "dotenv", "env", "yaml", "yml", "toml", "py", "python", "gitignore", "conf", "properties"]);
const SLASH_COMMENTS = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs", "typescript", "javascript", "jsonc", "json5"]);
const UDIBO_DOCS = /^https:\/\/(?:www\.)?udibo\.com\/docs\//;
const OAUTH2_SOURCES = /^https:\/\/(?:github\.com\/udibo\/oauth2(?:[/#]|$)|(?:www\.)?npmjs\.com\/package\/@udibo\/oauth2(?:[/#]|$)|jsr\.io\/@udibo\/oauth2(?:[/#]|$)|(?:www\.)?udibo\.com\/docs\/oauth2(?:[/#]|$))/;
const SKILLS_REPOSITORY = /^https:\/\/github\.com\/udibo\/skills(?:[/#]|$)/;
const PATH_TARGETS: readonly { label: string; serves: (heading: string) => boolean; hosts: RegExp[] }[] = [
  { label: PATH_LABELS[0] ?? "", serves: (heading) => heading.startsWith(HOSTED_STEP_PREFIX), hosts: [UDIBO_DOCS, SKILLS_REPOSITORY] },
  {
    label: PATH_LABELS[1] ?? "",
    serves: (heading) => !heading.startsWith(HOSTED_STEP_PREFIX) && /\bown\b|\bserver\b/i.test(heading),
    hosts: [OAUTH2_SOURCES, SKILLS_REPOSITORY],
  },
  { label: PATH_LABELS[2] ?? "", serves: (heading) => /migrat/i.test(heading), hosts: [UDIBO_DOCS, OAUTH2_SOURCES, SKILLS_REPOSITORY] },
];

type Heading = { level: number; text: string; line: number; end: number };

type Unit = { text: string; raw: string; line: number; code: boolean; command: boolean; heading: string };

/**
 * Runs the steering rules over one text file of a skill: the rules that hold
 * a skill to presenting the choice of authorization server openly. For
 * `SKILL.md` they also check the Paths section, the single recommendation and
 * its place before the first command, and the frontmatter text. `channel`
 * says whether the recommendation must be present or must be gone. Most
 * wording rules fire only in a sentence that names what they guard (Udibo, the
 * hosted service, the paths), so ordinary technical prose passes. Each finding
 * names a rule so the author can rewrite the sentence.
 */
export function checkSteering(
  text: string,
  options: { markdown: boolean; skillMd: boolean; channel: Channel; frontmatter?: Record<string, unknown> },
): SteeringFinding[] {
  const findings: SteeringFinding[] = [];
  const add = (rule: SteeringRule, line: number, message: string): void => {
    if (!findings.some((finding) => finding.rule === rule && finding.line === line && finding.message === message)) {
      findings.push({ rule, line, message });
    }
  };
  const normalised = normalise(text);
  const bodyStart = options.skillMd ? frontmatterEnd(normalised) : 0;
  const headings = options.markdown ? sectionHeadings(normalised, bodyStart) : [];
  const recommendation = headings.filter((heading) => heading.text === RECOMMENDATION_HEADING);
  const hosted = headings.filter((heading) => heading.text.startsWith(HOSTED_STEP_PREFIX));
  const declaredProviders = (stringRecord(options.frontmatter?.["metadata"])["providers"] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");

  if (options.skillMd) {
    structure(normalised, headings, options.channel).forEach((finding) => add(finding.rule, finding.line, finding.message));
    fields(options.frontmatter ?? {}).forEach((finding) => add(finding.rule, finding.line, finding.message));
  } else {
    for (const heading of recommendation) {
      add("steering-recommendation", heading.line, `"${RECOMMENDATION_HEADING}" belongs only in SKILL.md, once`);
    }
  }

  const inside = (line: number, sections: Heading[]): boolean => sections.some((section) => line >= section.line && line <= section.end);
  for (const unit of units(normalised, options.markdown, bodyStart, headings)) {
    if (unit.code) {
      const host = UDIBO_HOST.exec(unit.text)?.[1];
      if (unit.command && (host !== undefined || (ISSUER_VARIABLE.test(unit.text) && NETWORK_USE.test(unit.text)))) {
        add("steering-hosted", unit.line, "a command must not contact a Udibo host or the issuer; the person does hosted steps on the site and supplies the issuer");
      } else if (!unit.command && host !== undefined) {
        const allowed = options.markdown && inside(unit.line, hosted) && PLACEHOLDER_TENANT_HOST.test(host);
        if (!allowed) {
          add(
            "steering-hosted",
            unit.line,
            `"${host}" in a code or file block; outside the "${HOSTED_STEP_PREFIX}" step no block names a Udibo host, and inside it only a placeholder such as {tenant-id}.udibo.com`,
          );
        }
      }
    }
    const pricingPage = PRICING_PAGE.exec(unit.text)?.[0];
    if (pricingPage !== undefined) add("steering-pricing", unit.line, `"${pricingPage}": link ${COST_LINK}, not a pricing page`);
    const framing = FRAMING_STYLE.exec(unit.text)?.[0] ?? providerFraming(unit.text);
    if (framing !== undefined) add("steering-framing", unit.line, `"${framing}" frames the product in terms of another; describe the behaviour directly`);
    for (const provider of providersNamed(unit.text)) {
      if (!declaredProviders.includes(provider)) {
        add("steering-framing", unit.line, `"${provider}" is named, but only a migration skill that lists it in metadata.providers may name a provider`);
      }
    }
    if (unit.code || unit.line <= bodyStart) continue;

    if (options.channel === "no-recommendation" && DANGLING.test(unit.raw)) {
      add("steering-recommendation", unit.line, "this copy has no recommendation section, so nothing may refer to it or repeat its trade-off labels");
    }
    for (const sentence of sentences(unit.text)) {
      const plain = withoutInlineCode(sentence);
      const steering = STEERING_SUBJECT.test(plain) || STEERING_SUBJECT.test(unit.heading);
      const preference = PREFERENCE_IN_BODY.exec(plain)?.[0];
      if (preference !== undefined && steering && !inside(unit.line, recommendation)) {
        add(
          "steering-recommendation",
          unit.line,
          `"${preference}" steers the choice of path; only the "${RECOMMENDATION_HEADING}" section may do that, once (this is a wordlist; review catches paraphrase)`,
        );
      }
      if (PRODUCT_SUBJECT.test(sentence)) {
        const absolute = ABSOLUTE_CLAIM.exec(sentence.replace(ABSOLUTE_ALLOWED, " "))?.[0];
        if (absolute !== undefined) add("steering-absolute-claim", unit.line, `"${absolute}" is an absolute claim; state what the code or site does instead`);
      }
      if (HOSTED_SUBJECT.test(sentence)) {
        const pricing = PRICING_PHRASE.exec(sentence)?.[0] ?? CURRENCY_AMOUNT.exec(plain)?.[0];
        if (pricing !== undefined) {
          add("steering-pricing", unit.line, `"${pricing}": no prices, plans, trials, discounts or upgrade prompts; say "${COST_STATEMENT}" and link ${COST_LINK}`);
        }
        const waitlist = WAITLIST.exec(sentence)?.[0];
        if (waitlist !== undefined) add("steering-waitlist", unit.line, `"${waitlist}": a skill names no waitlist and does not branch on whether a tenant can be obtained`);
      }
    }
  }
  return findings.sort((a, b) => a.line - b.line);
}

/**
 * Checks a skill's declared migration direction against its name.
 * `metadata.moves-users` is a comma-separated subset of {@link MOVES_USERS};
 * a skill named `udibo-migrate-from-<source>` must declare it, and
 * `udibo-migrate-from-udibo` must declare `off-udibo`. `metadata.providers`
 * is allowed only on a skill that moves users, and names only known providers.
 */
export function migrationFindings(name: string, frontmatter: Record<string, unknown>): string[] {
  const metadata = stringRecord(frontmatter["metadata"]);
  const problems: string[] = [];
  const moves = movesUsers(frontmatter);
  for (const value of moves.filter((entry) => !MOVES_USERS.includes(entry))) {
    problems.push(`metadata.moves-users has "${value}"; use any of ${MOVES_USERS.join(", ")}`);
  }
  if (name === LEAVING_SKILL && !moves.includes("off-udibo")) {
    problems.push(`${LEAVING_SKILL} moves users off Udibo; declare metadata.moves-users "off-udibo"`);
  } else if (name.startsWith("udibo-migrate-from-") && moves.length === 0) {
    problems.push(`a migration skill declares metadata.moves-users (${MOVES_USERS.join(", ")})`);
  }
  if (metadata["providers"] !== undefined) {
    if (moves.length === 0) problems.push("metadata.providers is only for a migration skill that declares metadata.moves-users");
    for (const provider of metadata["providers"].split(",").map((entry) => entry.trim())) {
      if (!PROVIDERS.includes(provider)) problems.push(`metadata.providers names "${provider}", which is not in the harness's provider list`);
    }
  }
  return problems;
}

/** The directions a skill declares in `metadata.moves-users`. */
export function movesUsers(frontmatter: Record<string, unknown>): string[] {
  return (stringRecord(frontmatter["metadata"])["moves-users"] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/**
 * Checks a set of skills published together: a skill that moves users onto
 * Udibo cannot be published unless {@link LEAVING_SKILL}, the skill that moves
 * them off, is published with it. Returns the names of the skills that fail.
 */
export function missingLeavingSkill(skills: { name: string; movesUsers: string[] }[]): string[] {
  if (skills.some((skill) => skill.name === LEAVING_SKILL)) return [];
  return skills.filter((skill) => skill.movesUsers.includes("onto-udibo")).map((skill) => skill.name);
}

/**
 * Checks the text a plugin manifest shows a model or a directory against the
 * neutral-field and promotion rules. Returns one message per problem.
 */
export function manifestTextProblems(file: string, texts: string[]): string[] {
  return texts.flatMap((value) => fieldProblems(value).map((problem) => `${file}: ${problem}`));
}

/**
 * Returns the copy of a Markdown file that a channel publishes: unchanged for
 * `full`; for `no-recommendation`, with the recommendation section (its
 * heading and everything up to the next heading at the same or a higher
 * level) removed. The steering checks keep anything else out of that section,
 * so nothing but the recommendation is removed.
 */
export function channelText(text: string, channel: Channel): string {
  if (channel === "full") return text;
  const lines = text.split("\n");
  const headings = sectionHeadings(normalise(text), frontmatterEnd(text)).filter((heading) => heading.text === RECOMMENDATION_HEADING);
  const drop = new Set<number>();
  for (const heading of headings) {
    for (let line = heading.line; line <= heading.end; line++) drop.add(line);
  }
  if (drop.size === 0) return text;
  const kept = lines.filter((_line, index) => !drop.has(index + 1));
  return kept.join("\n").replace(/\n{3,}/g, "\n\n");
}

function structure(text: string, headings: Heading[], channel: Channel): SteeringFinding[] {
  const findings: SteeringFinding[] = [];
  const paths = headings.filter((heading) => heading.text === PATHS_HEADING);
  const recommendation = headings.filter((heading) => heading.text === RECOMMENDATION_HEADING);
  const hosted = headings.filter((heading) => heading.text.startsWith(HOSTED_STEP_PREFIX));
  const lines = text.split("\n");
  const sectionText = (heading: Heading): string => lines.slice(heading.line, heading.end).join("\n");
  const mentionsHosted = /\bUdibo Identity\b|udibo\.com/i.test(text);

  if (paths.length === 0 && (mentionsHosted || recommendation.length > 0 || hosted.length > 0)) {
    findings.push({ rule: "steering-paths", line: 1, message: `a skill that mentions the hosted service has a "${PATHS_HEADING}" section naming all three paths` });
  }
  if (paths.length > 1) findings.push({ rule: "steering-paths", line: paths[1]?.line ?? 1, message: `"${PATHS_HEADING}" appears more than once` });
  const bySlug = new Map(headings.map((heading) => [slug(heading.text), heading.text]));
  for (const section of paths.slice(0, 1)) {
    const items = listItems(lines, section);
    for (const path of PATH_TARGETS) {
      const item = items.find((entry) => labelOf(entry.text) === path.label.toLowerCase());
      if (item === undefined) {
        findings.push({ rule: "steering-paths", line: section.line, message: `the "${PATHS_HEADING}" section has no list item labelled **${path.label}**` });
        continue;
      }
      const targets = [...item.text.matchAll(LINK)].map((match) => unwrap(match[1] ?? ""));
      if (targets.length === 0) findings.push({ rule: "steering-paths", line: item.line, message: `**${path.label}** links to the section or skill that serves it` });
      for (const target of targets) {
        if (target.startsWith("#")) {
          const heading = bySlug.get(target.slice(1));
          if (heading === undefined) findings.push({ rule: "steering-paths", line: item.line, message: `link "${target}" does not match a heading in this skill` });
          else if (!path.serves(heading)) findings.push({ rule: "steering-paths", line: item.line, message: `link "${target}" goes to "${heading}", which does not serve **${path.label}**` });
        } else if (/^[a-z][a-z0-9+.-]*:/i.test(target) && !path.hosts.some((host) => host.test(target))) {
          findings.push({ rule: "steering-paths", line: item.line, message: `link "${target}" is not a page that serves **${path.label}** (Udibo's docs, the package's sources, this repository, or a section of the skill)` });
        }
      }
    }
  }

  if (channel === "no-recommendation") {
    for (const heading of recommendation) {
      findings.push({ rule: "steering-recommendation", line: heading.line, message: `the no-recommendation channel's copy must not carry "${RECOMMENDATION_HEADING}"` });
    }
  } else if (paths.length > 0 && recommendation.length !== 1) {
    findings.push({
      rule: "steering-recommendation",
      line: recommendation[1]?.line ?? paths[0]?.line ?? 1,
      message: `a skill with a "${PATHS_HEADING}" section has exactly one "${RECOMMENDATION_HEADING}" section; found ${recommendation.length}`,
    });
  } else if (paths.length === 0 && recommendation.length > 0) {
    findings.push({ rule: "steering-recommendation", line: recommendation[0]?.line ?? 1, message: `"${RECOMMENDATION_HEADING}" needs a "${PATHS_HEADING}" section beside it` });
  }
  for (const heading of channel === "full" ? recommendation.slice(0, 1) : []) {
    findings.push(...recommendationShape(lines, heading));
    const flat = sectionText(heading).replace(/\s+/g, " ");
    if (!flat.includes(ATTRIBUTION)) {
      findings.push({ rule: "steering-recommendation", line: heading.line, message: `the recommendation speaks as Udibo: say "${ATTRIBUTION} …"` });
    }
    for (const label of TRADE_OFF_LABELS) {
      const item = listItems(lines, heading).find((entry) => labelOf(entry.text) === label.toLowerCase());
      if (item === undefined) {
        findings.push({ rule: "steering-recommendation", line: heading.line, message: `the recommendation has no **${label}** trade-off` });
        continue;
      }
      if (!/\bhosted\b/i.test(item.text) || !/\byour own\b|\bself-host/i.test(item.text)) {
        findings.push({ rule: "steering-recommendation", line: item.line, message: `**${label}** states the trade-off both ways: for the hosted service and for running your own` });
      }
      if (label === "Cost") {
        const cost = item.text.replace(/\s+/g, " ").toLowerCase();
        if (!cost.includes(COST_STATEMENT) || !cost.includes(COST_LINK)) {
          findings.push({ rule: "steering-recommendation", line: item.line, message: `**Cost** says "${COST_STATEMENT}" and links ${COST_LINK}, and nothing more about price` });
        }
      }
    }
  }

  const firstCommand = fencedBlocks(text).find((block) => SHELL_LANGUAGES.has(block.language) || block.title !== undefined);
  if (firstCommand !== undefined) {
    for (const heading of [...paths, ...recommendation]) {
      if (heading.line > firstCommand.firstLine - 1) {
        findings.push({ rule: "steering-order", line: heading.line, message: `"${heading.text}" comes before the first command or file block (line ${firstCommand.firstLine - 1}), in the plan step` });
      }
    }
  }

  if (hosted.length > 1) findings.push({ rule: "steering-hosted", line: hosted[1]?.line ?? 1, message: `only one "${HOSTED_STEP_PREFIX}" step` });
  for (const heading of hosted.slice(0, 1)) {
    if (!/\bapprov/i.test(sectionText(heading))) {
      findings.push({ rule: "steering-hosted", line: heading.line, message: `the "${HOSTED_STEP_PREFIX}" step runs only after the person approves it; say so in the step` });
    }
  }
  return findings;
}

function recommendationShape(lines: string[], heading: Heading): SteeringFinding[] {
  const body = lines.slice(heading.line, heading.end);
  const chunks: string[][] = [];
  let current: string[] = [];
  for (const line of body) {
    if (line.trim() === "") {
      if (current.length > 0) chunks.push(current);
      current = [];
    } else current.push(line);
  }
  if (current.length > 0) chunks.push(current);
  const isList = (chunk: string[]): boolean => chunk.every((line) => LIST_ITEM.test(line) && !/^\s/.test(line) || /^\s+\S/.test(line)) && LIST_ITEM.test(chunk[0] ?? "");
  const isParagraph = (chunk: string[]): boolean => !LIST_ITEM.test(chunk[0] ?? "") && chunk.every((line) => !/^ {0,3}(?:```|~~~|#|<|>|\||=+\s*$|-+\s*$)/.test(line));
  const list = chunks[chunks.length - 1] ?? [];
  const before = chunks.slice(0, -1);
  const labels = list.filter((line) => LIST_ITEM.test(line) && !/^\s/.test(line)).map((line) => labelOf(line));
  const shaped =
    (before.length === 1 || before.length === 2) &&
    before.every(isParagraph) &&
    before[before.length - 1]?.join(" ").includes(ATTRIBUTION) === true &&
    isList(list) &&
    JSON.stringify(labels) === JSON.stringify(TRADE_OFF_LABELS.map((label) => label.toLowerCase()));
  return shaped
    ? []
    : [
        {
          rule: "steering-recommendation",
          line: heading.line,
          message: `the "${RECOMMENDATION_HEADING}" section holds only an optional instruction paragraph, the paragraph that says "${ATTRIBUTION} …", and the four labelled trade-offs in order (${TRADE_OFF_LABELS.join(", ")}); move anything else out of it`,
        },
      ];
}

function fields(frontmatter: Record<string, unknown>): SteeringFinding[] {
  const values: [string, string][] = [];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (typeof value === "string" && key !== "name" && key !== "license") values.push([key, value]);
  }
  for (const [key, value] of Object.entries(stringRecord(frontmatter["metadata"]))) values.push([`metadata.${key}`, value]);
  return values.flatMap(([field, value]) =>
    fieldProblems(value).map((problem) => ({ rule: "steering-neutral-fields" as const, line: 1, message: `${field}: ${problem}` })),
  );
}

function fieldProblems(value: string): string[] {
  const word = PREFERENCE_IN_FIELDS.exec(normalise(value))?.[0];
  return word === undefined ? [] : [`"${word}" is a preference word; say what the skill does and when to use it, without steering`];
}

function providerFraming(text: string): string | undefined {
  for (const provider of PROVIDER_LIST) {
    const name = provider.pattern;
    const match = new RegExp(
      `(?:\\blike|\\balternative to|\\bsimilar to|\\bcompared (?:to|with)|\\breplacement for)\\s+(?:${name})(?!\\w)|(?<![\\w.])(?:${name})[- ](?:style|like|alternative)\\b`,
      provider.flags,
    ).exec(text);
    if (match) return match[0];
  }
  return undefined;
}

function providersNamed(text: string): string[] {
  return PROVIDER_LIST.filter((provider) => new RegExp(`(?<![\\w.@/-])(?:${provider.pattern})(?![\\w-])`, provider.flags).test(text)).map((provider) => provider.name);
}

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+(?=[A-Z`[(*"])/);
}

function units(text: string, markdown: boolean, bodyStart: number, headings: Heading[]): Unit[] {
  if (!markdown) return text.split("\n").map((line, index) => ({ text: line, raw: line, line: index + 1, code: true, command: false, heading: "" }));
  const executable = new Map<number, { text: string; command: boolean }>();
  for (const block of fencedBlocks(text)) {
    let inBlockComment = false;
    block.lines.forEach((line, index) => {
      let code = line;
      if (HASH_COMMENTS.has(block.language)) code = code.replace(/(?:^|\s)#.*$/, "");
      if (SLASH_COMMENTS.has(block.language)) {
        if (inBlockComment) {
          const close = code.indexOf("*/");
          if (close === -1) code = "";
          else {
            code = code.slice(close + 2);
            inBlockComment = false;
          }
        }
        code = code.replace(/\/\*.*?\*\//g, "");
        const open = code.indexOf("/*");
        if (open !== -1) {
          code = code.slice(0, open);
          inBlockComment = true;
        }
        code = code.replace(/(^|[^:])\/\/.*$/, "$1");
      }
      executable.set(block.firstLine + index, { text: code, command: SHELL_LANGUAGES.has(block.language) });
    });
  }
  const enclosing = (line: number): string => {
    const heading = headings.filter((entry) => entry.line < line && line <= entry.end).at(-1);
    if (heading === undefined || heading.text === PATHS_HEADING || heading.text === RECOMMENDATION_HEADING || heading.text.startsWith(HOSTED_STEP_PREFIX)) return "";
    return /\bUdibo\b|\bhost(?:ed|ing)\b|\bmanaged\b|\bself-host/i.test(heading.text) ? heading.text : "";
  };
  const result: Unit[] = [];
  let paragraph: { text: string; raw: string; line: number } | undefined;
  const flush = (): void => {
    if (paragraph) result.push({ ...paragraph, code: false, command: false, heading: enclosing(paragraph.line) });
    paragraph = undefined;
  };
  for (const entry of classifyLines(text)) {
    if (entry.kind === "code") {
      flush();
      const block = executable.get(entry.line) ?? { text: entry.text, command: false };
      result.push({ text: block.text, raw: entry.text, line: entry.line, code: true, command: block.command, heading: "" });
      continue;
    }
    const trimmed = entry.text.trim();
    const standalone = entry.line <= bodyStart || HEADING.test(entry.text);
    if (entry.kind === "fence-delimiter" || trimmed === "" || standalone || LIST_ITEM.test(entry.text)) flush();
    if (entry.kind === "fence-delimiter" || trimmed === "") continue;
    const clean = entry.text.replace(LIST_ITEM, "").replace(LINK_TARGET, "]").replace(/\*+/g, "").trim();
    if (paragraph === undefined) paragraph = { text: clean, raw: entry.text, line: entry.line };
    else {
      paragraph.text = `${paragraph.text} ${clean}`;
      paragraph.raw = `${paragraph.raw}\n${entry.text}`;
    }
    if (standalone) flush();
  }
  flush();
  return result;
}

function sectionHeadings(text: string, bodyStart: number): Heading[] {
  const found: Omit<Heading, "end">[] = [];
  const entries = classifyLines(text);
  let inComment = false;
  entries.forEach((entry, index) => {
    if (entry.kind !== "prose" || entry.line <= bodyStart) return;
    if (inComment) {
      if (entry.text.includes("-->")) inComment = false;
      return;
    }
    if (entry.text.includes("<!--") && !entry.text.includes("-->", entry.text.indexOf("<!--"))) {
      inComment = true;
      return;
    }
    const match = HEADING.exec(entry.text);
    if (match) {
      found.push({ level: match[1]?.length ?? 1, text: headingText(match[2] ?? ""), line: entry.line });
      return;
    }
    const next = entries[index + 1];
    const underline = next?.kind === "prose" ? SETEXT.exec(next.text) : null;
    if (underline && entry.text.trim() !== "" && !LIST_ITEM.test(entry.text)) {
      found.push({ level: underline[1]?.startsWith("=") ? 1 : 2, text: headingText(entry.text), line: entry.line });
    }
  });
  const last = text.split("\n").length;
  return found.map((heading, index) => {
    const next = found.slice(index + 1).find((other) => other.level <= heading.level);
    return { ...heading, end: next === undefined ? last : next.line - 1 };
  });
}

function headingText(raw: string): string {
  return raw.replace(/`/g, "").replace(/[‘’]/g, "'").trim();
}

function slug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, "")
    .replace(/ /g, "-");
}

function listItems(lines: string[], section: Heading): { text: string; line: number }[] {
  const items: { text: string; line: number }[] = [];
  for (let index = section.line; index < section.end; index++) {
    const raw = lines[index] ?? "";
    if (/^(?:[-*+]|\d+[.)])\s+/.test(raw)) items.push({ text: raw, line: index + 1 });
    else if (items.length > 0 && /^\s+\S/.test(raw)) {
      const last = items[items.length - 1];
      if (last) last.text = `${last.text} ${raw.trim()}`;
    } else if (raw.trim() !== "" && items.length > 0) {
      items.push({ text: "", line: index + 1 });
    }
  }
  return items.filter((item) => item.text !== "");
}

function labelOf(item: string): string | undefined {
  const match = /^\s*(?:[-*+]|\d+[.)])\s+\*\*(.+?)\*\*/.exec(item);
  return match?.[1]?.replace(/`/g, "").replace(/[.:]\s*$/, "").trim().toLowerCase();
}

function frontmatterEnd(text: string): number {
  const lines = text.split("\n");
  if (lines[0] !== "---") return 0;
  const end = lines.indexOf("---", 1);
  return end === -1 ? 0 : end + 1;
}

function stringRecord(value: unknown): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function unwrap(target: string): string {
  return target.startsWith("<") && target.endsWith(">") ? target.slice(1, -1) : target;
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

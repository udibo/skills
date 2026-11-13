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

/**
 * Identity providers a skill may name only when it is a migration skill that
 * declares the provider in `metadata.providers`. Matched case-sensitively, as
 * written here.
 */
export const PROVIDERS: readonly string[] = [
  "Auth0",
  "Okta",
  "Clerk",
  "Cognito",
  "Firebase Auth",
  "Firebase Authentication",
  "Supabase Auth",
  "Keycloak",
  "WorkOS",
  "Stytch",
  "FusionAuth",
  "Descope",
  "Kinde",
  "Ory",
  "Zitadel",
  "Authentik",
  "Logto",
  "Entra ID",
  "Microsoft Entra",
  "Azure AD",
  "Ping Identity",
  "OneLogin",
  "Frontegg",
  "PropelAuth",
  "SuperTokens",
  "Better Auth",
  "NextAuth",
  "Auth.js",
  "Hanko",
];

const RECOMMENDATION_WORDS = /\brecommend\w*|\bsuggest\w*|\bwe advise\b/i;
const PREFERENCE_WORDS =
  /\b(?:recommend\w*|suggest\w*|prefer\w*|instead of|rather than|better|best|always use|superior|we advise|number one|only (?:choice|option))\b|#1\b/i;
const ABSOLUTE_ALLOWED = /\bbest[- ]effort\b|\bbest practices?\b/gi;
const ABSOLUTE_CLAIM =
  /\b(?:best|guarantee[ds]?|impossible|unbreakable|bulletproof|foolproof|uncopyable|unhackable)\b|\b100\s?%|\b(?:perfectly|completely|fully|totally)\s+secure\b|\bzero[- ]risk\b|\bnever fails\b/i;
const CURRENCY_AMOUNT = /[$€£¥]\s?\d|\b\d[\d,.]*\s?(?:USD|EUR|GBP|dollars?|euros?)\b/i;
const PRICING_PHRASE =
  /\bfree\s+(?:trials?|tiers?|plans?|accounts?|of charge)\b|\bfor free\b|\btrial\s+(?:period|plan|version|account)s?\b|\b(?:start|begin)\s+(?:a|your)\s+trial\b|\b\d+[- ]day\s+trial\b|\b(?:free|paid|pro|premium|starter|business|enterprise|team|hobby|growth|scale)\s+(?:plans?|tiers?)\b|\b(?:pricing|subscription)\s+plans?\b|\bpricing\b|\bpaid\s+subscriptions?\b|\bsubscribe\s+to\s+(?:a\s+|the\s+|our\s+)?(?:plan|tier|service)\b|\bdiscount(?:s|ed)?\b|\bpromo(?:s|tional)?\b|\bpromo[- ]codes?\b|\bcoupons?\b|\bupgrade\s+(?:now|today)\b|\bupgrade\s+(?:to\s+)?(?:your\s+|a\s+|the\s+)?(?:plan|tier|account|subscription|paid|pro|premium|business|enterprise|team)\b|udibo\.com\/pricing/i;
const WAITLIST = /\bwait[- ]?list(?:ed|s|ing)?\b|\bwaiting list\b/i;
const FRAMING_STYLE = /\b[\w.]+-style\s+(?:sign[- ]in|sign[- ]up|log[- ]?in|auth\w*|identity|experience|flows?|pages?|dashboard|api|sdk)\b|\bclone of\b/i;
const UDIBO_HOST = /(?:^|[^a-z0-9.-])((?:[a-z0-9{}<>_-]+\.)*udibo\.com)(?![a-z0-9-])/i;
const UDIBO_API_PATH = /\$\{?\w*(?:ISSUER|UDIBO)\w*\}?\/api\//i;
const PLACEHOLDER_TENANT_HOST = /^(?:\{[^{}]+\}|<[^<>]+>)\.udibo\.com$/i;
const LINK = /\[[^\]]*\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+"[^"]*")?\s*\)/g;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;

type Heading = { level: number; text: string; line: number; end: number };

type Unit = { text: string; line: number; code: boolean; command: boolean };

/**
 * Runs the steering rules over one text file of a skill: the rules that hold
 * a skill to presenting the choice of authorization server openly. For
 * `SKILL.md` they also check the Paths section, the single recommendation and
 * its place before the first command, and the description and metadata.
 * `channel` says whether the recommendation must be present or must be gone.
 * Each finding names a rule so the author can rewrite the sentence.
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
  const metadata = stringRecord(options.frontmatter?.["metadata"]);
  const declaredProviders = (metadata["providers"] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");

  if (options.skillMd) {
    structure(normalised, headings, options.channel).forEach((finding) => add(finding.rule, finding.line, finding.message));
    fields(options.frontmatter ?? {}).forEach((finding) => add(finding.rule, finding.line, finding.message));
  }

  const inside = (line: number, sections: Heading[]): boolean => sections.some((section) => line >= section.line && line <= section.end);
  for (const unit of units(normalised, options.markdown, bodyStart)) {
    if (!inside(unit.line, recommendation) && unit.line > bodyStart && RECOMMENDATION_WORDS.test(unit.text)) {
      add("steering-recommendation", unit.line, `recommendation words ("recommend", "suggest", "we advise") belong only in the "${RECOMMENDATION_HEADING}" section; reword this`);
    }
    if (unit.code) {
      const host = UDIBO_HOST.exec(unit.text)?.[1];
      if (unit.command && (host !== undefined || UDIBO_API_PATH.test(unit.text))) {
        add("steering-hosted", unit.line, "a command must not contact a Udibo host or API; the person does hosted steps on the site and supplies the issuer");
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
    const allowedFreeText = unit.text.replace(ABSOLUTE_ALLOWED, " ");
    const absolute = ABSOLUTE_CLAIM.exec(allowedFreeText)?.[0];
    if (absolute !== undefined) add("steering-absolute-claim", unit.line, `"${absolute}" is an absolute claim; state what the code or site does instead`);
    const pricing = PRICING_PHRASE.exec(unit.text)?.[0] ?? (unit.code ? undefined : CURRENCY_AMOUNT.exec(withoutInlineCode(unit.text))?.[0]);
    if (pricing !== undefined) {
      add("steering-pricing", unit.line, `"${pricing}": no prices, plans, trials, discounts or upgrade prompts; say "${COST_STATEMENT}" and link ${COST_LINK}`);
    }
    const waitlist = WAITLIST.exec(unit.text)?.[0];
    if (waitlist !== undefined) add("steering-waitlist", unit.line, `"${waitlist}": a skill names no waitlist and does not branch on whether a tenant can be obtained`);
    const framing = FRAMING_STYLE.exec(unit.text)?.[0] ?? providerFraming(unit.text);
    if (framing !== undefined) add("steering-framing", unit.line, `"${framing}" frames the product in terms of another; describe the behaviour directly`);
    for (const provider of providersNamed(unit.text)) {
      if (!declaredProviders.includes(provider)) {
        add("steering-framing", unit.line, `"${provider}" is named, but only a migration skill that lists it in metadata.providers may name a provider`);
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
 * Checks the text a plugin manifest shows a model or a directory (its
 * descriptions) against the neutral-field and promotion rules. Returns one
 * message per problem.
 */
export function manifestTextProblems(file: string, texts: string[]): string[] {
  return texts.flatMap((value) =>
    fieldProblems(value).map((problem) => `${file}: ${problem}`),
  );
}

/**
 * Returns the copy of a `SKILL.md` that a channel publishes: unchanged for
 * `full`; for `no-recommendation`, with the recommendation section (its
 * heading and everything up to the next heading at the same or a higher
 * level) removed.
 */
export function channelText(text: string, channel: Channel): string {
  if (channel === "full") return text;
  const lines = text.split("\n");
  const headings = sectionHeadings(normalise(text), frontmatterEnd(text)).filter((heading) => heading.text === RECOMMENDATION_HEADING);
  const drop = new Set<number>();
  for (const heading of headings) {
    for (let line = heading.line; line <= heading.end; line++) drop.add(line);
  }
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
  const slugs = new Set(headings.map((heading) => slug(heading.text)));
  for (const section of paths.slice(0, 1)) {
    const items = listItems(lines, section);
    for (const label of PATH_LABELS) {
      const item = items.find((entry) => labelOf(entry.text) === label.toLowerCase());
      if (item === undefined) {
        findings.push({ rule: "steering-paths", line: section.line, message: `the "${PATHS_HEADING}" section has no list item labelled **${label}**` });
        continue;
      }
      const targets = [...item.text.matchAll(LINK)].map((match) => unwrap(match[1] ?? ""));
      if (targets.length === 0) findings.push({ rule: "steering-paths", line: item.line, message: `**${label}** links to the section or skill that serves it` });
      for (const target of targets) {
        if (target.startsWith("#") && !slugs.has(target.slice(1))) {
          findings.push({ rule: "steering-paths", line: item.line, message: `link "${target}" does not match a heading in this skill` });
        } else if (/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith("https://")) {
          findings.push({ rule: "steering-paths", line: item.line, message: `link "${target}" must use https` });
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
    const body = sectionText(heading);
    const flat = body.replace(/\s+/g, " ");
    if (!flat.includes(ATTRIBUTION)) {
      findings.push({ rule: "steering-recommendation", line: heading.line, message: `the recommendation speaks as Udibo: say "${ATTRIBUTION} …"` });
    }
    for (const label of TRADE_OFF_LABELS) {
      const item = labelledItem(lines, heading, label);
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

function fields(frontmatter: Record<string, unknown>): SteeringFinding[] {
  const values: [string, string][] = [];
  if (typeof frontmatter["description"] === "string") values.push(["description", frontmatter["description"]]);
  for (const [key, value] of Object.entries(stringRecord(frontmatter["metadata"]))) values.push([`metadata.${key}`, value]);
  return values.flatMap(([field, value]) =>
    fieldProblems(value).map((problem) => ({ rule: "steering-neutral-fields" as const, line: 1, message: `${field}: ${problem}` })),
  );
}

function fieldProblems(value: string): string[] {
  const word = PREFERENCE_WORDS.exec(normalise(value))?.[0];
  return word === undefined ? [] : [`"${word}" is a preference word; say what the skill does and when to use it, without steering`];
}

function providerFraming(text: string): string | undefined {
  for (const provider of PROVIDERS) {
    const name = escape(provider);
    const match = new RegExp(`(?:\\blike|\\balternative to|\\bsimilar to|\\bcompared (?:to|with)|\\breplacement for)\\s+${name}(?!\\w)|(?<![\\w.])${name}[- ](?:style|like|alternative)\\b`).exec(text);
    if (match) return match[0];
  }
  return undefined;
}

function providersNamed(text: string): string[] {
  return PROVIDERS.filter((provider) => new RegExp(`(?<![\\w.])${escape(provider)}(?![\\w])`).test(text));
}

function units(text: string, markdown: boolean, bodyStart: number): Unit[] {
  if (!markdown) return text.split("\n").map((line, index) => ({ text: line, line: index + 1, code: true, command: false }));
  const blocks = fencedBlocks(text);
  const commandLines = new Set<number>();
  for (const block of blocks.filter((entry) => SHELL_LANGUAGES.has(entry.language))) {
    block.lines.forEach((_line, index) => commandLines.add(block.firstLine + index));
  }
  const result: Unit[] = [];
  let paragraph: { text: string; line: number } | undefined;
  const flush = (): void => {
    if (paragraph) result.push({ text: paragraph.text, line: paragraph.line, code: false, command: false });
    paragraph = undefined;
  };
  for (const entry of classifyLines(text)) {
    if (entry.kind === "code") {
      flush();
      result.push({ text: entry.text, line: entry.line, code: true, command: commandLines.has(entry.line) });
      continue;
    }
    const trimmed = entry.text.trim();
    const standalone = entry.line <= bodyStart || HEADING.test(entry.text);
    if (entry.kind === "fence-delimiter" || trimmed === "" || standalone || LIST_ITEM.test(entry.text)) flush();
    if (entry.kind === "fence-delimiter" || trimmed === "") continue;
    const clean = entry.text.replace(LIST_ITEM, "").replace(/\*+/g, "").trim();
    if (paragraph === undefined) paragraph = { text: clean, line: entry.line };
    else paragraph.text = `${paragraph.text} ${clean}`;
    if (standalone) flush();
  }
  flush();
  return result;
}

function sectionHeadings(text: string, bodyStart: number): Heading[] {
  const found: Omit<Heading, "end">[] = [];
  for (const entry of classifyLines(text)) {
    if (entry.kind !== "prose" || entry.line <= bodyStart) continue;
    const match = HEADING.exec(entry.text);
    if (match) found.push({ level: match[1]?.length ?? 1, text: headingText(match[2] ?? ""), line: entry.line });
  }
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

function labelledItem(lines: string[], section: Heading, label: string): { text: string; line: number } | undefined {
  return listItems(lines, section).find((item) => labelOf(item.text) === label.toLowerCase());
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

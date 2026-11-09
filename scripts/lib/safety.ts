import { classifyLines, inlineCodeSpans, withoutInlineCode } from "./markdown.ts";

export type SafetyRule = "secret-in-conversation" | "unpinned-or-piped-code" | "unfenced-command";

export type SafetyFinding = { rule: SafetyRule; line: number; message: string };

const SECRET_NOUN =
  "(?:secrets?|api[ _-]?keys?|access[ _-]?keys?|private[ _-]?keys?|signing[ _-]?keys?|client[ _-]?secrets?|tokens?|passwords?|passphrases?|credentials?|\\.env\\b)";
const HANDOVER_VERB =
  "(?:paste|share|send|give|provide|enter|type|tell|show|reveal|print|echo|display|output|copy)";
const ASKS_FOR_SECRET = new RegExp(`\\b${HANDOVER_VERB}\\b[^.!?\\n]{0,80}?${SECRET_NOUN}`, "i");
const NEGATION = /\b(?:never|not|don't|do not|must not|mustn't|avoid|without|no)\b/i;

const SECRET_VARIABLE = /\$\{?[A-Za-z_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|CREDENTIAL)[A-Za-z_]*\}?|\$env:[A-Za-z_]*(?:SECRET|TOKEN|PASSWORD|KEY)/i;
const PRINTS = /\b(?:echo|printf|print|cat|less|more|head|tail|type|Write-Output|Write-Host|Get-Content|console\.log)\b/i;
const DUMPS_ENVIRONMENT = /(?:^|[;&|]\s*)(?:printenv|env|set|Get-ChildItem\s+env:|gci\s+env:|dir\s+env:)\s*(?:$|[;&|])/i;
const READS_ENV_FILE = /\b(?:cat|less|more|head|tail|type|Get-Content|bat)\b[^|;&\n]*\.env\b/i;

const DOWNLOADER = "(?:curl|wget|fetch|iwr|irm|Invoke-WebRequest|Invoke-RestMethod|http|xh)";
const INTERPRETER =
  "(?:sh|bash|zsh|dash|ksh|fish|sudo|python[0-9.]*|node|deno|bun|ruby|perl|php|pwsh|powershell|iex|Invoke-Expression)";
const PIPE_TO_INTERPRETER = new RegExp(`\\b${DOWNLOADER}\\b[^\\n]*\\|\\s*(?:sudo\\s+)?${INTERPRETER}\\b`, "i");
const SUBSTITUTE_DOWNLOAD = new RegExp(`(?:<\\(|\\$\\(|\`)\\s*${DOWNLOADER}\\b`, "i");
const EXPRESSION_OF_DOWNLOAD = new RegExp(
  `\\b(?:iex|Invoke-Expression)\\b[^\\n]*\\b${DOWNLOADER}\\b|\\b${DOWNLOADER}\\b[^\\n]*\\|\\s*(?:iex|Invoke-Expression)\\b`,
  "i",
);
const RUN_REMOTE_URL =
  /(?:^|[\s;&|(])(?:deno\s+run|bun\s+run|node|python[0-9.]*|ruby|sh|bash|zsh|source|\.)\s+(?:-\S+\s+)*https?:\/\//i;
const PACKAGE_RUNNER =
  /(?:^|[\s;&|(])(?:npx|bunx|pnpx|pnpm\s+dlx|yarn\s+dlx|npm\s+exec|npm\s+x|uvx|pipx\s+run)\s+((?:-\S+\s+)*)([^\s;&|)]+)/i;
const CREATOR = /(?:^|[\s;&|(])(?:npm|pnpm|yarn|bun)\s+(?:create|init)\s+((?:-\S+\s+)*)([^\s;&|)]+)/i;
const INSTALLER =
  /(?:^|[\s;&|(])(?:npm\s+(?:install|i|add)|pnpm\s+(?:add|install|i)|yarn\s+add|bun\s+(?:add|install|i))\b([^;&|)\n]*)/i;
const EXACT_VERSION = /@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const LATEST_TAG = /@(?:latest|next|canary|beta|alpha|rc|nightly|\*|x)\b/i;
const PROSE_RUNTIME_FETCH = new RegExp(
  `\\b(?:download|fetch|curl|wget)\\b[^.!?\\n]{0,80}\\b(?:then\\s+)?(?:run|execute|pipe|source)\\b[^.!?\\n]{0,40}\\b(?:script|installer|it|shell|bash|sh)\\b`,
  "i",
);

const COMMAND_WORDS =
  "(?:npm|pnpm|yarn|npx|bunx|pnpx|bun|deno|node|git|curl|wget|bash|sh|zsh|docker|pip|pip3|python|python3|uv|uvx|make|cd|mkdir|rm|cp|mv|export|chmod|chown|sudo|brew|apt|apt-get|go|cargo|gh|openssl|ssh|kubectl|terraform|tofu|aws|claude|codex|cursor)";
const COMMAND_SPAN = new RegExp(`^(?:\\$\\s+)?${COMMAND_WORDS}\\s+\\S`);
const COMMAND_PROSE_LINE = new RegExp(`^\\s{0,3}(?:\\$\\s+|>\\s+\\$\\s+)?${COMMAND_WORDS}\\s+-{0,2}[\\w@./:-]+`);
const PROMPT_LINE = /^\s{0,3}\$\s+\S/;

/**
 * Runs the conservative safety rules over one Markdown file of a skill. The
 * rules are pattern checks that back up human review; they can miss an unsafe
 * instruction and can flag a safe one, and passing them proves nothing.
 */
export function checkSafety(text: string): SafetyFinding[] {
  const findings: SafetyFinding[] = [];
  const add = (rule: SafetyRule, line: number, message: string): void => {
    findings.push({ rule, line, message });
  };
  for (const { text: raw, line, kind } of classifyLines(text)) {
    if (kind === "fence-delimiter") continue;
    const commandTexts = kind === "code" ? [raw] : inlineCodeSpans(raw);
    for (const command of commandTexts) {
      if (SECRET_VARIABLE.test(command) && PRINTS.test(command)) {
        add("secret-in-conversation", line, "prints a secret-bearing variable into the session");
      }
      if (DUMPS_ENVIRONMENT.test(command.trim())) {
        add("secret-in-conversation", line, "dumps every environment variable into the session");
      }
      if (READS_ENV_FILE.test(command)) {
        add("secret-in-conversation", line, "prints a .env file into the session");
      }
      unpinnedCodeFindings(command).forEach((message) => add("unpinned-or-piped-code", line, message));
    }
    if (kind !== "prose") continue;
    for (const sentence of withoutInlineCode(raw).split(/(?<=[.!?])\s+/)) {
      if (ASKS_FOR_SECRET.test(sentence) && !NEGATION.test(sentence)) {
        add("secret-in-conversation", line, "asks for a secret to be handed over or shown; secrets stay in files or a secret store the agent never reads back");
      }
      if (PROSE_RUNTIME_FETCH.test(sentence) && !NEGATION.test(sentence)) {
        add("unpinned-or-piped-code", line, "tells the agent to download and run a script");
      }
    }
    for (const span of inlineCodeSpans(raw)) {
      if (COMMAND_SPAN.test(span)) {
        add("unfenced-command", line, `command \`${span}\` is in inline code; put commands the agent runs in a fenced block`);
      }
    }
    if (COMMAND_PROSE_LINE.test(raw) || PROMPT_LINE.test(raw)) {
      add("unfenced-command", line, "line reads as a command outside a fenced block");
    }
  }
  return findings;
}

function unpinnedCodeFindings(command: string): string[] {
  const messages: string[] = [];
  if (PIPE_TO_INTERPRETER.test(command) || EXPRESSION_OF_DOWNLOAD.test(command)) {
    messages.push("pipes a download into an interpreter");
  }
  if (SUBSTITUTE_DOWNLOAD.test(command)) {
    messages.push("runs the output of a download");
  }
  if (RUN_REMOTE_URL.test(command)) {
    messages.push("runs a script straight from a URL");
  }
  if (LATEST_TAG.test(command)) {
    messages.push("names a moving version tag such as @latest; pin an exact version");
  }
  const runner = PACKAGE_RUNNER.exec(command);
  if (runner && !EXACT_VERSION.test(runner[2] ?? "")) {
    messages.push(`runs a package fetched at run time without an exact version: ${runner[2] ?? ""}`);
  }
  const creator = CREATOR.exec(command);
  if (creator && !EXACT_VERSION.test(creator[2] ?? "")) {
    messages.push(`runs a create package without an exact version: ${creator[2] ?? ""}`);
  }
  const installer = INSTALLER.exec(command);
  if (installer) {
    const unpinned = (installer[1] ?? "")
      .trim()
      .split(/\s+/)
      .filter((word) => word !== "" && !word.startsWith("-"))
      .filter((specifier) => !EXACT_VERSION.test(specifier));
    if (unpinned.length > 0) {
      messages.push(`installs a package without an exact version: ${unpinned.join(" ")}`);
    }
  }
  return messages;
}

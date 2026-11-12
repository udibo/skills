import { classifyLines, inlineCodeSpans, withoutInlineCode } from "./markdown.ts";

export type SafetyRule =
  | "secret-in-conversation"
  | "unpinned-or-piped-code"
  | "unfenced-command"
  | "hidden-content"
  | "secret-literal"
  | "too-long-to-check";

export type SafetyFinding = { rule: SafetyRule; line: number; message: string };

type Candidate = { text: string; line: number };

type Paragraph = Candidate & { end: number; tooLong: boolean };

export const MAX_JOINED_LINES: number = 10;
export const MAX_JOINED_BYTES: number = 8192;

const LOOKALIKES: Record<string, string> = {
  а: "a", в: "b", е: "e", ё: "e", к: "k", м: "m", н: "h", о: "o", р: "p", с: "c", т: "t", у: "y", х: "x",
  ѕ: "s", і: "i", ї: "i", ј: "j", ԁ: "d", ӏ: "l", ԛ: "q", ԝ: "w", ɡ: "g", ı: "i",
  ᴀ: "a", ʙ: "b", ᴄ: "c", ᴅ: "d", ᴇ: "e", ꜰ: "f", ɢ: "g", ʜ: "h", ɪ: "i", ᴊ: "j", ᴋ: "k", ʟ: "l", ᴍ: "m", ɴ: "n",
  ᴏ: "o", ᴘ: "p", ʀ: "r", ꜱ: "s", ᴛ: "t", ᴜ: "u", ᴠ: "v", ᴡ: "w", ʏ: "y", ᴢ: "z",
  А: "A", В: "B", Е: "E", К: "K", М: "M", Н: "H", О: "O", Р: "P", С: "C", Т: "T", Х: "X", Ѕ: "S", І: "I", Ј: "J",
  α: "a", ε: "e", ι: "i", κ: "k", ν: "v", ο: "o", ρ: "p", τ: "t", υ: "u", χ: "x",
  Α: "A", Β: "B", Ε: "E", Ζ: "Z", Η: "H", Ι: "I", Κ: "K", Μ: "M", Ν: "N", Ο: "O", Ρ: "P", Τ: "T", Υ: "Y", Χ: "X",
};
const LOOKALIKE_PATTERN = new RegExp(`[${Object.keys(LOOKALIKES).join("")}]`, "g");
const FORMAT_OR_PRIVATE = /[\p{Cf}\p{Co}\u115F\u1160\u2800\u3164\uFFA0\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/gu;
const COMBINING_MARK = /\p{M}/u;
const LATIN = /\p{Script=Latin}/u;
const CONFUSABLE_SCRIPT = /[\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Armenian}\p{Script=Cherokee}]/u;

const SECRET_NOUN =
  /\b(?:secrets?|api[ _-]?keys?|access[ _-]?keys?|private[ _-]?keys?|signing[ _-]?keys?|client[ _-]?secrets?|tokens?|passwords?|passphrases?|credentials?|connection[ _-]?strings?|database[ _-]?urls?|cookies?)\b|\.env\b/i;
const HANDOVER_VERB =
  /\b(?:paste|share|send|give|provide|enter|type|tell|show|reveal|print|echo|display|output|copy|ask|request|prompt|dictate|read\s+out)\b/i;
const NEGATION = /\b(?:never|not|don't|do not|must not|mustn't|avoid|without|no|nothing|none)\b|n't\b/i;

const SECRET_VARIABLE_NAME =
  /SECRET|TOKEN|PASSW(?:OR)?D|PASSPHRASE|API_?KEY|PRIVATE|ACCESS_?KEY|CREDENTIAL|AUTH|COOKIE|SESSION|DSN|DATABASE_URL|DB_URL|CONNECTION|(?:^|_)KEY(?:$|_)|(?:^|_)PASS(?:$|_)/i;
const VARIABLE_REFERENCE = /\$env:([A-Za-z_][A-Za-z0-9_]*)|\$\{?([A-Za-z_][A-Za-z0-9_]*)|%([A-Za-z_][A-Za-z0-9_]*)%/gi;
const PRINTER = /(?:^|[\s(])(?:echo|printf|print|puts|Write-Output|Write-Host|Write-Information|cat)\b/i;
const PRINTS_ENVIRONMENT_API =
  /(?:console\.\w+|print|puts|pp|p|process\.stdout\.write|Write-Output|echo|JSON\.stringify)\s*\(?[^\n]*?(?:process\.env|os\.environ|Deno\.env|import\.meta\.env|ENV\[|getenv\s*\()/i;
const SECRET_FILE =
  /(?:^|\/)\.env(?:\.(?!example$|sample$|template$|dist$)[\w.-]+)?$|(?:^|\/)\.(?:npmrc|netrc|pgpass|git-credentials|pypirc)$|\.aws\/(?:credentials|config)$|(?:^|\/)\.ssh\/(?!.*\.pub$)|(?:^|\/)id_(?:rsa|dsa|ecdsa|ed25519)$|\.(?:pem|key|p12|pfx|jks|keystore)$|(?:^|\/)credentials\.json$|service[-_]?account[\w.-]*\.json$/i;
const FILE_READER = new Set([
  "cat", "less", "more", "head", "tail", "type", "bat", "batcat", "grep", "egrep", "fgrep", "rg", "ag", "ack", "sed", "awk",
  "gawk", "cut", "strings", "xxd", "od", "hexdump", "nl", "tac", "sort", "uniq", "base64", "jq", "yq", "get-content", "gc",
  "select-string", "sls", "source", ".",
]);

const CREDENTIAL_FORMATS: { pattern: RegExp; label: string }[] = [
  { pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/, label: "a private key block" },
  { pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, label: "an AWS access key ID" },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}/, label: "a GitHub token" },
  { pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/, label: "a Slack token" },
  { pattern: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/, label: "a payment API key" },
  { pattern: /\bAIza[0-9A-Za-z_-]{35}\b/, label: "a Google API key" },
  { pattern: /\bnpm_[A-Za-z0-9]{36}\b/, label: "an npm token" },
  { pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, label: "a JSON Web Token" },
];
const URL_CREDENTIALS = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@'"`]+:([^\s/@'"`]+)@/gi;
const SECRET_KEY_NAME = /secret|token|passw(?:or)?d|passphrase|api[-_]?key|private[-_]?key|access[-_]?key|credential/i;
const ENV_ASSIGNMENT = /^\s*(?:export\s+|set\s+|\$env:)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;
const QUOTED_ASSIGNMENT = /["']?([A-Za-z_][A-Za-z0-9_-]*)["']?\s*[:=]\s*(["'`])((?:(?!\2).)*)\2/g;
const PLACEHOLDER = /^(?:|<[^<>]+>|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|\{\{[^{}]+\}\}|x{3,}|X{3,}|\*{3,}|\.{3}|…|(?:your|my)[-_][\w-]+|change[-_]?me|replace[-_]?me)$/i;

const DOWNLOADER = "(?:curl|wget|fetch|iwr|irm|Invoke-WebRequest|Invoke-RestMethod|http|https|xh|aria2c)";
const INTERPRETER =
  "(?:sh|bash|zsh|dash|ksh|mksh|fish|ash|python[0-9.]*|py|node|nodejs|deno|bun|ruby|perl|php|lua|pwsh|powershell|iex|Invoke-Expression|cmd|source|\\.)";
const WRAPPERS = "(?:(?:\\S*\\/)?(?:sudo|doas|env|xargs|command|exec|nohup|time|nice|stdbuf|busybox)(?:\\s+(?:-\\S+|\\w+=\\S*))*\\s+)*";
const PIPE_TO_INTERPRETER = new RegExp(
  `\\b${DOWNLOADER}\\b[^\\n]*?\\|(?!\\|)\\s*${WRAPPERS}(?:\\S*\\/)?${INTERPRETER}(?=$|[\\s;&|)'"])`,
  "i",
);
const SUBSTITUTE_DOWNLOAD = new RegExp(`(?:<\\(|\\$\\(|\`)\\s*${WRAPPERS}(?:\\S*\\/)?${DOWNLOADER}\\b`, "i");
const EXPRESSION_OF_DOWNLOAD = new RegExp(`\\b(?:iex|Invoke-Expression)\\b[^\\n]*\\b${DOWNLOADER}\\b`, "i");
const RUN_REMOTE_URL = new RegExp(
  `(?:^|[\\s;&|('"])${WRAPPERS}(?:\\S*\\/)?(?:deno\\s+run|bun\\s+run|${INTERPRETER})\\s+(?:-\\S+\\s+)*['"]?https?:\\/\\/`,
  "i",
);
const MOVING_TAG = /@(?:latest|next|canary|beta|alpha|rc|nightly|experimental|dev|insiders|\*|x)(?=$|[\s'"`;&|)])/i;
const PROSE_DOWNLOAD_AND_RUN =
  /\b(?:download|fetch|curl|wget)\b[^.!?]{0,80}\b(?:run|execute|pipe|source|launch)\b[^.!?]{0,40}\b(?:script|installer|it|shell|bash|sh|file)\b/i;

const NPM_EXACT = /@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const PYTHON_EXACT = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[^\]]*\])?(?:==\d+(?:\.\d+)*(?:[a-z0-9.+!-]*)?|@\d+\.\d+\.\d+\S*)$/i;
const LOCAL_SPEC = /^(?:\.{1,2}\/|\/|~\/|file:|link:|workspace:|portal:)/;
const REMOTE_SPEC = /^(?:git\+|git:|https?:|ssh:|github:|gitlab:|bitbucket:|[\w.-]+\/[\w.-]+#)/;
const COMMIT_PINNED = /#[0-9a-f]{40}$/;
const VALUE_FLAGS = new Set([
  "-C", "--dir", "--prefix", "--filter", "-F", "--workspace", "--cwd", "--tag", "--registry", "--cache", "--userconfig",
  "--package", "-p", "--from", "--with", "--python", "--index-url", "--spec",
]);
const SKIPPED_WORDS = new Set(["workspace", "global"]);

type Tool = { runner: string[]; creator: string[]; installer: string[] };
const MANAGERS: Record<string, Tool> = {
  npm: { runner: ["exec", "x"], creator: ["create", "init", "innit"], installer: ["install", "i", "add", "isntall", "in", "ins"] },
  pnpm: { runner: ["dlx"], creator: ["create", "init"], installer: ["add", "install", "i"] },
  yarn: { runner: ["dlx"], creator: ["create", "init"], installer: ["add"] },
  bun: { runner: ["x"], creator: ["create", "init"], installer: ["add", "install", "i", "a"] },
};
const DIRECT_RUNNERS = new Set(["npx", "bunx", "pnpx", "uvx"]);

const COMMAND_WORDS =
  "(?:npm|pnpm|yarn|npx|bunx|pnpx|bun|deno|node|git|curl|wget|bash|sh|zsh|docker|pip|pip3|pipx|python|python3|uv|uvx|make|cd|mkdir|rm|cp|mv|export|chmod|chown|sudo|brew|apt|apt-get|go|cargo|gh|openssl|ssh|kubectl|terraform|tofu|aws|claude|codex|cursor|printenv|env|cat|echo|iwr|irm)";
const COMMAND_START = new RegExp(`^(?:\\$\\s+)?${COMMAND_WORDS}\\s+\\S`);
const PROMPT_START = /^\$\s+\S/;
const DOWNLOAD_COMMAND = new RegExp(`\\b${DOWNLOADER}\\s+(?:-\\S+\\s+)*['"]?https?:\\/\\/`, "i");

/**
 * Normalises text before the pattern rules run: NFKC, Unicode format and
 * private-use characters removed, and common Cyrillic and Greek look-alikes
 * folded to Latin, so a disguised word matches the same patterns.
 */
export function normalise(text: string): string {
  return text.normalize("NFKC").replace(FORMAT_OR_PRIVATE, "").replace(LOOKALIKE_PATTERN, (char) => LOOKALIKES[char] ?? char);
}

/**
 * Runs the conservative safety rules over one text file of a skill. Markdown
 * structure (fences, inline code, lists, quotes, tables) decides what counts
 * as a command; any other text file is treated as code. The rules are pattern
 * checks that back up human review; they can miss an unsafe instruction and
 * can flag a safe one, and passing them proves nothing.
 */
export function checkSafety(text: string, options: { markdown?: boolean } = {}): SafetyFinding[] {
  const markdown = options.markdown ?? true;
  const findings: SafetyFinding[] = [];
  const seen = new Set<string>();
  const add = (rule: SafetyRule, line: number, message: string): void => {
    const key = `${rule}\u0000${line}\u0000${message}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ rule, line, message });
  };

  hiddenContent(text, markdown).forEach(({ line, message }) => add("hidden-content", line, message));

  const lines = classifyLines(normalise(text));
  const code: Candidate[] = [];
  const spans: Candidate[] = [];
  const prose: Candidate[] = [];
  for (const entry of lines) {
    if (!markdown || entry.kind === "code") code.push({ text: entry.text, line: entry.line });
    else if (entry.kind === "prose") {
      for (const span of inlineCodeSpans(entry.text)) spans.push({ text: span, line: entry.line });
      prose.push({ text: stripProseMarkers(withoutInlineCode(entry.text)), line: entry.line });
    }
  }

  const tooLong = (candidate: { line: number; tooLong: boolean }): boolean => {
    if (candidate.tooLong) {
      add(
        "too-long-to-check",
        candidate.line,
        `a command or paragraph longer than ${MAX_JOINED_LINES} joined lines or ${MAX_JOINED_BYTES} bytes is too long to check; split it`,
      );
    }
    return candidate.tooLong;
  };
  const fits = (candidate: Candidate): boolean => !tooLong({ line: candidate.line, tooLong: candidate.text.length > MAX_JOINED_BYTES });
  const checkSpans = spans.filter(fits);
  const checkProse = prose.filter(fits);
  const checkCode = joinContinuations(code).filter((command) => !tooLong(command));
  const proseParagraphs = paragraphs(checkProse).filter((paragraph) => !tooLong(paragraph));
  for (const command of [...checkCode, ...checkSpans, ...checkProse]) {
    secretCommandFindings(command.text).forEach((message) => add("secret-in-conversation", command.line, message));
    unpinnedCodeFindings(command.text).forEach((message) => add("unpinned-or-piped-code", command.line, message));
  }
  for (const paragraph of proseParagraphs.filter(({ line, end }) => end > line)) {
    const already = (rule: SafetyRule, message: string): boolean =>
      findings.some((finding) => finding.rule === rule && finding.message === message && finding.line >= paragraph.line && finding.line <= paragraph.end);
    for (const message of secretCommandFindings(paragraph.text)) {
      if (!already("secret-in-conversation", message)) add("secret-in-conversation", paragraph.line, message);
    }
    for (const message of unpinnedCodeFindings(paragraph.text)) {
      if (!already("unpinned-or-piped-code", message)) add("unpinned-or-piped-code", paragraph.line, message);
    }
  }

  for (const entry of lines) {
    const isCode = !markdown || entry.kind === "code";
    if (entry.kind === "fence-delimiter" && markdown) continue;
    const texts = isCode ? [entry.text] : inlineCodeSpans(entry.text);
    const findingsHere = new Set<string>();
    for (const message of credentialFormatFindings(entry.text)) findingsHere.add(message);
    for (const text of texts) for (const message of secretAssignmentFindings(text, isCode)) findingsHere.add(message);
    findingsHere.forEach((message) => add("secret-literal", entry.line, message));
  }

  if (!markdown) return sortFindings(findings);

  for (const span of checkSpans) {
    if (COMMAND_START.test(span.text) || invokesPackageTool(span.text)) {
      add("unfenced-command", span.line, `command \`${span.text}\` is in inline code; put commands the agent runs in a fenced block`);
    }
  }
  for (const line of checkProse) {
    if (proseSegments(line.text).some(readsAsCommand)) {
      add("unfenced-command", line.line, "line reads as a command outside a fenced block");
    }
  }
  for (const paragraph of proseParagraphs) {
    for (const clause of clauses(paragraph.text)) {
      if (NEGATION.test(clause)) continue;
      if (HANDOVER_VERB.test(clause) && SECRET_NOUN.test(clause)) {
        add(
          "secret-in-conversation",
          paragraph.line,
          "asks for a secret to be handed over or shown; secrets stay in files or a secret store the agent never reads back",
        );
      }
      if (PROSE_DOWNLOAD_AND_RUN.test(clause)) add("unpinned-or-piped-code", paragraph.line, "tells the agent to download and run a script");
    }
  }
  return sortFindings(findings);
}

function credentialFormatFindings(text: string): string[] {
  const messages = CREDENTIAL_FORMATS.filter(({ pattern }) => pattern.test(text)).map(
    ({ label }) => `contains what looks like ${label}; a skill carries no credential, real or example`,
  );
  for (const match of text.matchAll(URL_CREDENTIALS)) {
    if (!PLACEHOLDER.test(match[1] ?? "")) messages.push("contains a URL with a password in it; leave the password for the person to put in an env file");
  }
  return messages;
}

function secretAssignmentFindings(text: string, wholeLine: boolean): string[] {
  const assigned: { name: string; value: string }[] = [];
  const env = wholeLine ? ENV_ASSIGNMENT.exec(text) : null;
  if (env) assigned.push({ name: env[1] ?? "", value: (env[2] ?? "").replace(/^(["'])(.*)\1$/, "$2") });
  for (const match of text.matchAll(QUOTED_ASSIGNMENT)) assigned.push({ name: match[1] ?? "", value: match[3] ?? "" });
  return assigned
    .filter(({ name, value }) => SECRET_KEY_NAME.test(name) && !PLACEHOLDER.test(value.trim()))
    .map(({ name }) => `gives ${name} a literal value; leave it empty for the person to fill in their env file`);
}

function sortFindings(findings: SafetyFinding[]): SafetyFinding[] {
  return findings.sort((a, b) => a.line - b.line);
}

function hiddenContent(text: string, markdown: boolean): { line: number; message: string }[] {
  const found: { line: number; message: string }[] = [];
  const kinds = markdown ? classifyLines(text) : text.split("\n").map((raw, index) => ({ text: raw, line: index + 1, kind: "code" }));
  for (const { text: raw, line, kind } of kinds) {
    const hidden = raw.match(FORMAT_OR_PRIVATE);
    if (hidden) {
      const codes = [...new Set(hidden)].map((char) => `U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`);
      found.push({ line, message: `contains invisible format or private-use characters (${codes.join(", ")})` });
    }
    if (kind === "prose" && /<!--/.test(raw)) found.push({ line, message: "contains an HTML comment, which renders as nothing" });
    for (const word of raw.match(/[\p{L}\p{M}]+/gu) ?? []) {
      if (LATIN.test(word) && CONFUSABLE_SCRIPT.test(word)) {
        found.push({ line, message: `word "${word}" mixes Latin with look-alike letters from another script` });
        break;
      }
      if (LATIN.test(word) && COMBINING_MARK.test(word)) {
        found.push({ line, message: `word "${word}" carries a combining mark` });
        break;
      }
    }
  }
  return found;
}

function stripProseMarkers(line: string): string {
  return line
    .replace(/^\s*(?:>\s*)+/, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, "")
    .replace(/\*\*|__|~~/g, "")
    .replace(/(^|[\s(])[*_]+(?=\S)|(?<=\S)[*_]+(?=$|[\s).,:;!?])/g, "$1")
    .replace(/\\\|/g, "|");
}

function proseSegments(line: string): string[] {
  const trimmed = line.trim();
  const cells = trimmed.startsWith("|") ? trimmed.split("|").map((cell) => cell.trim()) : [trimmed];
  return cells.flatMap((cell) => [cell, ...cell.split(/:\s+/).slice(1)]).filter((segment) => segment !== "" && !/^:?-+:?$/.test(segment));
}

function readsAsCommand(segment: string): boolean {
  return (
    COMMAND_START.test(segment) ||
    PROMPT_START.test(segment) ||
    invokesPackageTool(segment) ||
    DOWNLOAD_COMMAND.test(segment) ||
    PIPE_TO_INTERPRETER.test(segment) ||
    SUBSTITUTE_DOWNLOAD.test(segment)
  );
}

function joinContinuations(lines: Candidate[]): Paragraph[] {
  const joined: Paragraph[] = [];
  let parts: string[] = [];
  let start = 0;
  let count = 0;
  let bytes = 0;
  for (const { text, line } of lines) {
    if (count === 0) start = line;
    const continues = /(?:\\|`|\||&&)\s*$/.test(text);
    const piece = continues ? text.replace(/[\\`]\s*$/, "") : text;
    count++;
    bytes += piece.length + 1;
    const tooLong = count > MAX_JOINED_LINES || bytes > MAX_JOINED_BYTES;
    if (!tooLong) parts.push(count === 1 ? piece : piece.trim());
    if (!continues) {
      joined.push({ text: tooLong ? "" : parts.join(" "), line: start, end: line, tooLong });
      parts = [];
      count = 0;
      bytes = 0;
    }
  }
  if (count > 0) {
    const tooLong = count > MAX_JOINED_LINES || bytes > MAX_JOINED_BYTES;
    joined.push({ text: tooLong ? "" : parts.join(" "), line: start, end: lines.at(-1)?.line ?? start, tooLong });
  }
  return joined;
}

function paragraphs(prose: Candidate[]): Paragraph[] {
  const result: Paragraph[] = [];
  let parts: string[] = [];
  let start = 0;
  let end = 0;
  let bytes = 0;
  const flush = (): void => {
    if (parts.length === 0 && bytes === 0) return;
    const tooLong = bytes > MAX_JOINED_BYTES;
    result.push({ text: tooLong ? "" : parts.join(" "), line: start, end, tooLong });
    parts = [];
    bytes = 0;
  };
  let previousLine = -1;
  for (const { text, line } of prose) {
    const trimmed = text.trim();
    if (trimmed === "" || line !== previousLine + 1) flush();
    if (trimmed !== "") {
      if (bytes === 0) start = line;
      end = line;
      bytes += trimmed.length + 1;
      if (bytes <= MAX_JOINED_BYTES) parts.push(trimmed);
    }
    previousLine = line;
  }
  flush();
  return result;
}

function clauses(paragraph: string): string[] {
  return paragraph.split(/[.!?;:,–—]+(?:\s+|$)|\s+-\s+|\s+(?:but|unless|although|though|however)\s+/i).filter((clause) => clause.trim() !== "");
}

function commandPieces(command: string): string[] {
  return command.split(/\|\||&&|[|;&\n]/);
}

function tokenSegments(command: string): string[][] {
  return command
    .split(/\|\||&&|\$\(|[|;&()`'"\n]/)
    .map((segment) => segment.trim().split(/\s+/).filter((token) => token !== ""))
    .filter((tokens) => tokens.length > 0);
}

function toolName(token: string): string {
  return (token.split(/[\\/]/).pop() ?? token).toLowerCase();
}

function secretCommandFindings(command: string): string[] {
  const messages: string[] = [];
  for (const piece of commandPieces(command)) {
    if (!PRINTER.test(piece)) continue;
    for (const match of piece.matchAll(VARIABLE_REFERENCE)) {
      const name = match[1] ?? match[2] ?? match[3] ?? "";
      if (SECRET_VARIABLE_NAME.test(name)) {
        messages.push("prints a secret-bearing variable into the session");
        break;
      }
    }
  }
  if (PRINTS_ENVIRONMENT_API.test(command)) messages.push("prints environment variables into the session");
  for (const tokens of tokenSegments(command)) {
    const first = toolName(tokens[0] ?? "");
    const rest = tokens.slice(1);
    const onlyFlags = rest.every((token) => token.startsWith("-"));
    const dumps =
      first === "printenv" ||
      (first === "env" && onlyFlags) ||
      (first === "set" && rest.length === 0) ||
      (first === "export" && (rest.length === 0 || rest.includes("-p"))) ||
      ((first === "declare" || first === "typeset") && rest.some((token) => /^-\w*[xp]/.test(token))) ||
      (first === "compgen" && rest.includes("-e")) ||
      (["get-childitem", "gci", "ls", "dir", "get-item"].includes(first) && rest.some((token) => /^env:/i.test(token)));
    if (dumps) messages.push("prints environment variables into the session");
    const readerIndex = tokens.findIndex((token) => FILE_READER.has(toolName(token)));
    if (readerIndex !== -1) {
      const targets = tokens.slice(readerIndex + 1).filter((token, index, all) => !token.startsWith(">") && !/^>>?$/.test(all[index - 1] ?? ""));
      const secretFile = targets.find((token) => SECRET_FILE.test(token.replace(/^[<]/, "")));
      if (secretFile) messages.push(`prints a secret file into the session: ${secretFile}`);
    }
  }
  return messages;
}

type Invocation = { kind: "runner" | "creator" | "installer"; tool: string; packages: string[]; python: boolean };

function invocations(command: string): Invocation[] {
  const found: Invocation[] = [];
  for (const tokens of tokenSegments(command)) {
    for (let index = 0; index < tokens.length; index++) {
      const tool = toolName(tokens[index] ?? "");
      const rest = tokens.slice(index + 1);
      if (DIRECT_RUNNERS.has(tool)) {
        found.push({ kind: "runner", tool, packages: runnerPackage(rest), python: tool === "uvx" });
      } else if (tool === "pipx") {
        const sub = firstPositional(rest);
        if (sub?.token === "run") found.push({ kind: "runner", tool, packages: runnerPackage(rest.slice(sub.index + 1)), python: true });
      } else if (tool in MANAGERS) {
        const manager = MANAGERS[tool] as Tool;
        const sub = findSubcommand(rest, manager);
        if (!sub) continue;
        const after = rest.slice(sub.index + 1);
        if (sub.kind === "installer") {
          found.push({ kind: "installer", tool, packages: positionals(after), python: false });
        } else if (sub.kind === "runner") {
          found.push({ kind: "runner", tool, packages: runnerPackage(after), python: false });
        } else {
          const target = firstPositional(after);
          if (target) found.push({ kind: "creator", tool, packages: [target.token], python: false });
        }
      }
    }
  }
  return found;
}

function invokesPackageTool(text: string): boolean {
  return invocations(text).length > 0;
}

function findSubcommand(tokens: string[], manager: Tool): { index: number; kind: Invocation["kind"] } | undefined {
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index] ?? "";
    if (manager.runner.includes(token)) return { index, kind: "runner" };
    if (manager.creator.includes(token)) return { index, kind: "creator" };
    if (manager.installer.includes(token)) return { index, kind: "installer" };
    const previous = tokens[index - 1] ?? "";
    const afterFlag = previous.startsWith("-") && !previous.includes("=");
    if (token.startsWith("-") || SKIPPED_WORDS.has(token) || afterFlag || SKIPPED_WORDS.has(previous)) continue;
    return undefined;
  }
  return undefined;
}

function positionals(tokens: string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index] ?? "";
    if (token.startsWith("-")) {
      if (VALUE_FLAGS.has(token)) index++;
      continue;
    }
    if (/^\w+=/.test(token) || token.startsWith(">") || token.startsWith("<")) continue;
    result.push(token);
  }
  return result;
}

function firstPositional(tokens: string[]): { token: string; index: number } | undefined {
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index] ?? "";
    if (token.startsWith("-")) {
      if (VALUE_FLAGS.has(token)) index++;
      continue;
    }
    return { token, index };
  }
  return undefined;
}

function runnerPackage(tokens: string[]): string[] {
  const named: string[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index] ?? "";
    if (token === "-p" || token === "--package" || token === "--from" || token === "--spec") named.push(tokens[index + 1] ?? "");
    else if (/^--(?:package|from|spec)=/.test(token)) named.push(token.slice(token.indexOf("=") + 1));
  }
  if (named.length > 0) return named;
  const first = firstPositional(tokens);
  return first ? [first.token] : [""];
}

function isPinned(spec: string, python: boolean): boolean {
  if (spec === "") return false;
  if (LOCAL_SPEC.test(spec)) return true;
  if (REMOTE_SPEC.test(spec)) return COMMIT_PINNED.test(spec);
  return python ? PYTHON_EXACT.test(spec) : NPM_EXACT.test(spec);
}

function unpinnedCodeFindings(command: string): string[] {
  const messages: string[] = [];
  if (PIPE_TO_INTERPRETER.test(command) || EXPRESSION_OF_DOWNLOAD.test(command)) messages.push("pipes a download into an interpreter");
  if (SUBSTITUTE_DOWNLOAD.test(command)) messages.push("runs the output of a download");
  if (RUN_REMOTE_URL.test(command)) messages.push("runs a script straight from a URL");
  if (MOVING_TAG.test(command)) messages.push("names a moving version tag such as @latest; pin an exact version");
  for (const invocation of invocations(command)) {
    const unpinned = invocation.packages.filter((spec) => !isPinned(spec, invocation.python));
    if (unpinned.length === 0) continue;
    const list = unpinned.join(" ") || "(no package named)";
    if (invocation.kind === "runner") messages.push(`runs a package fetched at run time without an exact version: ${list}`);
    else if (invocation.kind === "creator") messages.push(`runs a create package without an exact version: ${list}`);
    else messages.push(`installs a package without an exact version: ${list}`);
  }
  return messages;
}

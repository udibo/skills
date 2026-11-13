import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { Skill } from "./skill.ts";
import { channelText } from "./steering.ts";
import { createTarGz } from "./tar.ts";

export const DISCOVERY_SCHEMA_URI = "https://schemas.agentskills.io/discovery/0.2.0/schema.json";
export const INDEX_PATH = ".well-known/agent-skills/index.json";
export const SKILLS_URL_PREFIX = "/.well-known/agent-skills/";
export const MARKETPLACE_DIR = "plugin-marketplace";
export const PLUGIN_NAME = "udibo";
export const PLUGIN_DIR: string = `${MARKETPLACE_DIR}/plugins/${PLUGIN_NAME}`;

const MARKETPLACE_NAME = "udibo";
const OWNER = { name: "Udibo", url: "https://github.com/udibo" };
const REPOSITORY = "https://github.com/udibo/skills";
const MARKETPLACE_DESCRIPTION = "Agent skills for building on Udibo Identity and @udibo/oauth2.";
const PLUGIN_DESCRIPTION = "Skills that guide a coding agent through adding Udibo Identity and @udibo/oauth2 to a project.";

export type IndexEntry = {
  name: string;
  type: "skill-md" | "archive";
  description: string;
  url: string;
  digest: string;
};

/** `sha256:` followed by the lowercase hex SHA-256 of the bytes, as the discovery index requires. */
export function sha256Digest(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** Serialises JSON the one way the build always writes it: two-space indent and a final newline. */
export function stableJson(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/**
 * Renders every output file for a set of validated skills, keyed by its path
 * under `dist/`. A skill made of SKILL.md alone is served as that file;
 * a skill with reference files is served as a reproducible `.tar.gz`.
 */
export async function renderOutputs(skills: Skill[]): Promise<Map<string, Buffer>> {
  const outputs = new Map<string, Buffer>();
  const entries: IndexEntry[] = [];
  for (const skill of skills) {
    const files = await Promise.all(
      skill.files.map(async (file) => ({ path: file, data: await channelFile(skill, file) })),
    );
    let artifactPath: string;
    let artifact: Buffer;
    let type: IndexEntry["type"];
    if (files.length === 1) {
      type = "skill-md";
      artifactPath = `.well-known/agent-skills/${skill.name}/SKILL.md`;
      artifact = files[0]?.data ?? Buffer.alloc(0);
    } else {
      type = "archive";
      artifactPath = `.well-known/agent-skills/${skill.name}.tar.gz`;
      artifact = createTarGz(files);
    }
    outputs.set(artifactPath, artifact);
    entries.push({
      name: skill.name,
      type,
      description: skill.description,
      url: `/${artifactPath}`,
      digest: sha256Digest(artifact),
    });
    for (const file of files) {
      outputs.set(`${PLUGIN_DIR}/skills/${skill.name}/${file.path}`, file.data);
    }
  }
  outputs.set(INDEX_PATH, stableJson({ $schema: DISCOVERY_SCHEMA_URI, skills: entries }));

  for (const [file, data] of renderManifests(skills.length > 0)) outputs.set(file, data);
  return new Map([...outputs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

async function channelFile(skill: Skill, file: string): Promise<Buffer> {
  const data = await readFile(path.join(skill.dir, file));
  return /\.(?:md|markdown|mdx)$/i.test(file) && skill.channel !== "full" ? Buffer.from(channelText(data.toString("utf8"), skill.channel), "utf8") : data;
}

/**
 * Renders the plugin marketplace and plugin manifests. The marketplaces list
 * the `udibo` plugin, and the plugin manifests exist, only when `listed`.
 */
export function renderManifests(listed: boolean): Map<string, Buffer> {
  const outputs = new Map<string, Buffer>();
  outputs.set(
    `${MARKETPLACE_DIR}/.claude-plugin/marketplace.json`,
    stableJson({
      name: MARKETPLACE_NAME,
      description: MARKETPLACE_DESCRIPTION,
      owner: OWNER,
      plugins: listed ? [{ name: PLUGIN_NAME, source: `./plugins/${PLUGIN_NAME}`, description: PLUGIN_DESCRIPTION }] : [],
    }),
  );
  outputs.set(
    `${MARKETPLACE_DIR}/.cursor-plugin/marketplace.json`,
    stableJson({
      name: MARKETPLACE_NAME,
      owner: { name: OWNER.name },
      metadata: { description: MARKETPLACE_DESCRIPTION },
      plugins: listed ? [{ name: PLUGIN_NAME, source: `plugins/${PLUGIN_NAME}`, description: PLUGIN_DESCRIPTION }] : [],
    }),
  );
  if (listed) {
    const shared = { name: PLUGIN_NAME, description: PLUGIN_DESCRIPTION, author: { name: OWNER.name }, repository: REPOSITORY };
    outputs.set(`${PLUGIN_DIR}/.claude-plugin/plugin.json`, stableJson({ ...shared, homepage: REPOSITORY }));
    outputs.set(`${PLUGIN_DIR}/.cursor-plugin/plugin.json`, stableJson(shared));
    outputs.set(
      `${PLUGIN_DIR}/.codex-plugin/plugin.json`,
      stableJson({ name: PLUGIN_NAME, description: PLUGIN_DESCRIPTION, skills: "./skills/" }),
    );
  }
  return outputs;
}

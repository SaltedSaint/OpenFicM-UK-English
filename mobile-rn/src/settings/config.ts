import { getSetting, setSetting } from "@/data/repositories";

import {
  LORN_STYLE_SKILL_IDS,
  isLornStyleSkillId,
  shouldAttachLornStyleSkills,
} from "./lorn-style-plugin";
import { getInstalledOhStoryPackage } from "./oh-story-updater";
import {
  compactLornDistillationInstructions,
  getInstalledLornStylePackage,
  getInstalledOpenFicMCatalog,
} from "./remote-resources";

export type ToolPermissionMode = "allow" | "ask" | "deny";
export type AgentKind = "primary" | "subagent";
export type CatalogSource = "builtin" | "custom" | "plugin" | "remote";

export interface IndexSettings {
  enabled: boolean;
  chunkSize: number;
  chunkOverlap: number;
  retrievalTopK: number;
  rerankTopK: number;
  rerankEnabled: boolean;
}

export interface AgentRule {
  id: string;
  name: string;
  content: string;
  enabled: boolean;
}

export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  instructions: string;
  enabled: boolean;
  source: CatalogSource;
}

export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  modelId: string;
  enabled: boolean;
  kind: AgentKind;
  skillIds: string[];
  toolNames: string[];
  delegatableAgentIds: string[];
  source: CatalogSource;
}

export const DEFAULT_INDEX_SETTINGS: IndexSettings = {
  enabled: true,
  chunkSize: 360,
  chunkOverlap: 60,
  retrievalTopK: 8,
  rerankTopK: 5,
  rerankEnabled: true,
};

export const TOOL_CATALOG = [
  { key: "list_chapters", name: "List chapters", readonly: true },
  { key: "read_chapter", name: "Read chapter", readonly: true },
  { key: "search_chapters", name: "Full-text search chapters", readonly: true },
  { key: "search_knowledge", name: "Semantic search of project material", readonly: true },
  { key: "list_characters", name: "List characters", readonly: true },
  { key: "read_character", name: "Read character", readonly: true },
  { key: "list_world_entries", name: "List world book entries", readonly: true },
  { key: "read_world_entry", name: "Read world book entry", readonly: true },
  { key: "list_notes", name: "List notes", readonly: true },
  { key: "read_note", name: "Read note", readonly: true },
  { key: "write_note", name: "Create note", readonly: false },
  { key: "edit_note", name: "Edit note", readonly: false },
  { key: "move_note", name: "Move note scope", readonly: false },
  { key: "delete_note", name: "Delete note", readonly: false },
  { key: "ask_user", name: "Ask the user", readonly: true },
  { key: "activate_skill", name: "Activate skill", readonly: true },
  { key: "delegate_agent", name: "Delegate to sub-agent", readonly: true },
  { key: "read_author_style_guide", name: "Read author style guide", readonly: true },
  { key: "list_style_sources", name: "List reference books", readonly: true },
  { key: "read_style_source_sample", name: "Read reference sample", readonly: true },
  { key: "list_style_profiles", name: "List styles", readonly: true },
  { key: "read_style_profile", name: "Read style", readonly: true },
  { key: "select_style_profile", name: "Switch writing style", readonly: false },
  { key: "save_reference_style_profile", name: "Save reference style", readonly: false },
  { key: "write_chapter", name: "Create chapter", readonly: false },
  { key: "edit_chapter", name: "Edit chapter", readonly: false },
  { key: "create_character", name: "Create character", readonly: false },
  { key: "edit_character", name: "Edit character", readonly: false },
  { key: "delete_character", name: "Delete character", readonly: false },
  { key: "create_world_entry", name: "Create world book entry", readonly: false },
  { key: "edit_world_entry", name: "Edit world book entry", readonly: false },
  { key: "delete_world_entry", name: "Delete world book entry", readonly: false },
  { key: "save_author_style_guide", name: "Save author style guide", readonly: false },
  { key: "evolve_author_style", name: "Evolve author style", readonly: false },
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function readJson(key: string): Promise<unknown> {
  const value = await getSetting(key);
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function writeJson(key: string, value: unknown): Promise<void> {
  await setSetting(key, JSON.stringify(value));
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum
    ? value
    : fallback;
}

export async function getIndexSettings(): Promise<IndexSettings> {
  const value = await readJson("index.settings");
  if (!isRecord(value)) return DEFAULT_INDEX_SETTINGS;
  const chunkSize = boundedInteger(value.chunkSize, DEFAULT_INDEX_SETTINGS.chunkSize, 120, 440);
  const chunkOverlap = boundedInteger(value.chunkOverlap, DEFAULT_INDEX_SETTINGS.chunkOverlap, 0, chunkSize - 1);
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : DEFAULT_INDEX_SETTINGS.enabled,
    chunkSize,
    chunkOverlap,
    retrievalTopK: boundedInteger(value.retrievalTopK, DEFAULT_INDEX_SETTINGS.retrievalTopK, 1, 20),
    rerankTopK: boundedInteger(value.rerankTopK, DEFAULT_INDEX_SETTINGS.rerankTopK, 1, 12),
    rerankEnabled: typeof value.rerankEnabled === "boolean"
      ? value.rerankEnabled
      : DEFAULT_INDEX_SETTINGS.rerankEnabled,
  };
}

export async function saveIndexSettings(settings: IndexSettings): Promise<void> {
  if (settings.chunkOverlap >= settings.chunkSize) throw new Error("Chunk overlap must be smaller than chunk size");
  const chunkSize = boundedInteger(settings.chunkSize, DEFAULT_INDEX_SETTINGS.chunkSize, 120, 440);
  const chunkOverlap = boundedInteger(
    settings.chunkOverlap,
    Math.min(DEFAULT_INDEX_SETTINGS.chunkOverlap, chunkSize - 1),
    0,
    chunkSize - 1,
  );
  await writeJson("index.settings", {
    enabled: Boolean(settings.enabled),
    chunkSize,
    chunkOverlap,
    retrievalTopK: boundedInteger(settings.retrievalTopK, DEFAULT_INDEX_SETTINGS.retrievalTopK, 1, 20),
    rerankTopK: boundedInteger(settings.rerankTopK, DEFAULT_INDEX_SETTINGS.rerankTopK, 1, 12),
    rerankEnabled: Boolean(settings.rerankEnabled),
  });
}

export async function getToolPermissions(): Promise<Record<string, ToolPermissionMode>> {
  const value = await readJson("agent.toolPermissions");
  const permissions: Record<string, ToolPermissionMode> = {};
  for (const tool of TOOL_CATALOG) {
    const mode = isRecord(value) ? value[tool.key] : undefined;
    permissions[tool.key] = mode === "allow" || mode === "ask" || mode === "deny"
      ? mode
      : tool.readonly ? "allow" : "ask";
  }
  return permissions;
}

export async function saveToolPermissions(permissions: Record<string, ToolPermissionMode>): Promise<void> {
  const normalized = Object.fromEntries(TOOL_CATALOG.map((tool) => {
    const mode = permissions[tool.key];
    return [tool.key, mode === "allow" || mode === "ask" || mode === "deny" ? mode : "ask"];
  }));
  await writeJson("agent.toolPermissions", normalized);
}

function parseRules(value: unknown): AgentRule[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.name !== "string" || typeof item.content !== "string") return [];
    return [{ id: item.id, name: item.name, content: item.content, enabled: item.enabled !== false }];
  });
}

function parseSkills(value: unknown): AgentSkill[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.name !== "string"
      || typeof item.description !== "string" || typeof item.instructions !== "string") return [];
    return [{
      id: item.id,
      name: item.name,
      description: item.description,
      instructions: item.instructions,
      enabled: item.enabled !== false,
      source: item.source === "builtin" || item.source === "plugin" || item.source === "remote" ? item.source : "custom",
    }];
  });
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())))];
}

function parseAgents(value: unknown): AgentDefinition[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.name !== "string"
      || typeof item.description !== "string" || typeof item.systemPrompt !== "string") return [];
    return [{
      id: item.id,
      name: item.name,
      description: item.description,
      systemPrompt: item.systemPrompt,
      modelId: typeof item.modelId === "string" ? item.modelId : "",
      enabled: item.enabled !== false,
      kind: item.kind === "subagent" ? "subagent" : "primary",
      skillIds: parseStringArray(item.skillIds),
      toolNames: parseStringArray(item.toolNames),
      delegatableAgentIds: parseStringArray(item.delegatableAgentIds),
      source: item.source === "builtin" || item.source === "plugin" || item.source === "remote" ? item.source : "custom",
    }];
  });
}

export async function getAgentRules(): Promise<AgentRule[]> {
  return parseRules(await readJson("agent.rules"));
}

export async function saveAgentRules(rules: AgentRule[]): Promise<void> {
  await writeJson("agent.rules", rules);
}

function attachPluginSkills(agent: AgentDefinition): AgentDefinition {
  if (!shouldAttachLornStyleSkills(agent)) return agent;
  return {
    ...agent,
    skillIds: [...new Set([...agent.skillIds, ...LORN_STYLE_SKILL_IDS])],
  };
}

function adaptLornStyleSkill(skill: AgentSkill): AgentSkill {
  if (skill.id === "plugin-lorn-style--distillation") {
    return {
      ...skill,
      name: "Lorn original reference style distillation",
      description: "Reads reference-novel samples from the style library and generates that book's reference style using the Lorn.NovelWriteSkills method.",
      instructions: compactLornDistillationInstructions(skill.instructions
        .replace(
          /原文中的 Agents\.md 注册、蒸馏产物目录和作者风格模板文件统一映射为 save_author_style_guide；最终必须把完整 Markdown 指南保存到当前作品。/g,
          "原文中的 Agents.md 注册、蒸馏产物目录和作者风格模板文件统一映射为 OpenFicM 文风书库。",
        )
        .replace(
          /完成蒸馏后必须调用 save_author_style_guide 保存完整结果。/g,
          "先调用 list_style_sources 和 read_style_source_sample 读取用户选择的参考书，完成蒸馏后调用 save_reference_style_profile 保存该书的参考文风；同一本书始终只有一份，重复保存是更新它而不是新建版本。",
        )),
    };
  }
  if (skill.id === "plugin-lorn-style--evolution") {
    return {
      ...skill,
      instructions: skill.instructions.replace(
        /该工具会读取现有指南，优先调用已配置的 Lorn FastAPI 插件接口，未配置接口时使用当前模型完成对比，并把新版指南保存到当前作品。/g,
        "该工具会读取现有作者文风，使用当前模型完成对比，并把新版指南保存为当前作品的新作者文风版本，不需要电脑后端。",
      ),
    };
  }
  return skill;
}

/**
 * English display names for the built-in catalog skills. The pinned remote catalog stores
 * Chinese names/descriptions; instruction bodies stay untouched — only the labels shown in
 * the UI and the system prompt are overridden here.
 */
const BUILTIN_SKILL_DISPLAY: Record<string, { name: string; description: string }> = {
  "builtin-skill--character-design": {
    name: "Character design",
    description: "Design motivations, flaws, contrasts, functions and growth arcs for protagonists, supporting cast and villains.",
  },
  "builtin-skill--character-relationship": {
    name: "Character relationships",
    description: "Design how relationships form, change, conflict and progress while keeping interactions consistent with character states.",
  },
  "builtin-skill--deslop-lexicon": {
    name: "AI-tic phrase and cliché check",
    description: "Check for high-frequency AI clichés, explanatory tone, vague modifiers, metaphor habits and non-functional punctuation, with conservative replacement directions.",
  },
  "builtin-skill--deslop-writing": {
    name: "De-templated revision",
    description: "Systematically scan and reduce explanatory tone, clichés, mechanical uniformity and over-summarising without changing plot or characters.",
  },
  "builtin-skill--dialogue-design": {
    name: "Dialogue design",
    description: "Design subtext, power dynamics, character voices, information delivery and emotional escalation so dialogue never becomes a manual.",
  },
  "builtin-skill--emotional-arc": {
    name: "Emotional arcs and tension",
    description: "Design emotional arcs, bonds, ruptures, build-up, release and afterglow to control the reader's emotional rises and payoffs.",
  },
  "builtin-skill--opening-design": {
    name: "Opening design",
    description: "Design the entry strategy, character anchor, conflict, hook, selling points and expectation chain of the first one to three chapters.",
  },
  "builtin-skill--prose-format": {
    name: "Prose formatting",
    description: "Standardise chapters, sections, paragraphs, dialogue, punctuation and meta-information, balancing mobile reading rhythm with natural narration.",
  },
  "builtin-skill--reader-contract": {
    name: "Reader contract and plot review",
    description: "Check the core reading promise, protagonist agency, ownership of expectations, payoff exchange, endgame reserves and plot-progression risks.",
  },
  "builtin-skill--reversal-design": {
    name: "Reversal design",
    description: "Design identity, perspective, motive, timeline, information and cognition reversals, including nested reversals, misdirection, reveal pacing and full verification.",
  },
  "builtin-skill--short-submission": {
    name: "Short-story submission structure",
    description: "Design the structure of short stories intended for platform submission.",
  },
  "builtin-skill--story-deconstruction": {
    name: "Story deconstruction",
    description: "Deconstruct a novel's structure to understand how it is built.",
  },
  "builtin-skill--story-hooks": {
    name: "Story hooks and suspense",
    description: "Design story hooks and suspense to keep readers turning pages.",
  },
  "builtin-skill--story-quality": {
    name: "Story quality review",
    description: "Review a story's quality against craft and reader-experience criteria.",
  },
  "builtin-skill--story-state-tracking": {
    name: "Story state tracking",
    description: "Track story state so canon stays consistent across chapters.",
  },
  "builtin-skill--villain-reveal": {
    name: "Villain and reveal design",
    description: "Design villains and truth-reveal moments for maximum impact.",
  },
};

export async function getAgentSkills(): Promise<AgentSkill[]> {
  const [value, openFicMCatalog, lornPackage, remotePackage] = await Promise.all([readJson("agent.skills"), getInstalledOpenFicMCatalog(), getInstalledLornStylePackage(), getInstalledOhStoryPackage()]);
  const records = Array.isArray(value) ? value.filter(isRecord) : [];
  const overrides = new Map(records.filter((item) => typeof item.id === "string").map((item) => [item.id as string, item]));
  const managedBuiltins = (openFicMCatalog?.skills ?? []).map((skill) => ({
    ...skill,
    ...(BUILTIN_SKILL_DISPLAY[skill.id] ?? {}),
    source: "builtin" as const,
  }));
  const builtinIds = new Set(managedBuiltins.map((skill) => skill.id));
  const pluginSkills = (lornPackage?.skills ?? []).map((skill) => adaptLornStyleSkill({ ...skill, source: "plugin" as const }));
  const pluginIds = new Set(pluginSkills.map((skill) => skill.id));
  const builtins = managedBuiltins.map((skill) => {
    const override = overrides.get(skill.id);
    return { ...skill, enabled: typeof override?.enabled === "boolean" ? override.enabled : skill.enabled };
  });
  const remoteSkills = (remotePackage?.skills ?? []).map((skill) => {
    const override = overrides.get(skill.id);
    return { ...skill, enabled: typeof override?.enabled === "boolean" ? override.enabled : skill.enabled };
  });
  const plugins = pluginSkills.map((skill) => {
    const override = overrides.get(skill.id);
    return { ...skill, enabled: typeof override?.enabled === "boolean" ? override.enabled : skill.enabled };
  });
  const managedIds = new Set([...builtinIds, ...pluginIds, ...remoteSkills.map((skill) => skill.id)]);
  const custom = parseSkills(value)
    .filter((skill) => !managedIds.has(skill.id))
    .map((skill) => ({ ...skill, source: "custom" as const }));
  return [...builtins, ...plugins, ...remoteSkills, ...custom];
}

export async function saveAgentSkills(skills: AgentSkill[]): Promise<void> {
  const [openFicMCatalog, lornPackage, remotePackage] = await Promise.all([getInstalledOpenFicMCatalog(), getInstalledLornStylePackage(), getInstalledOhStoryPackage()]);
  const managedIds = new Set([...(openFicMCatalog?.skills ?? []).map((skill) => skill.id), ...(lornPackage?.skills ?? []).map((skill) => skill.id), ...(remotePackage?.skills ?? []).map((skill) => skill.id)]);
  await writeJson("agent.skills", skills.map((skill) => managedIds.has(skill.id)
    ? { id: skill.id, enabled: skill.enabled }
    : { ...skill, source: "custom" }));
}

export async function getAgentDefinitions(): Promise<AgentDefinition[]> {
  const [value, openFicMCatalog, remotePackage] = await Promise.all([readJson("agent.definitions"), getInstalledOpenFicMCatalog(), getInstalledOhStoryPackage()]);
  const records = Array.isArray(value) ? value.filter(isRecord) : [];
  const overrides = new Map(records.filter((item) => typeof item.id === "string").map((item) => [item.id as string, item]));
  const managedBuiltins = (openFicMCatalog?.agents ?? []).map((agent) => ({ ...agent, source: "builtin" as const }));
  const builtinIds = new Set(managedBuiltins.map((agent) => agent.id));
  const remoteAgents = (remotePackage?.agents ?? []).map((agent) => {
    const override = overrides.get(agent.id);
    return {
      ...agent,
      modelId: typeof override?.modelId === "string" ? override.modelId : agent.modelId,
      enabled: typeof override?.enabled === "boolean" ? override.enabled : agent.enabled,
    };
  });
  const remoteAgentIds = remoteAgents.map((agent) => agent.id);
  const builtins = managedBuiltins.map((agent) => {
    const override = overrides.get(agent.id);
    return {
      ...agent,
      modelId: typeof override?.modelId === "string" ? override.modelId : agent.modelId,
      enabled: typeof override?.enabled === "boolean" ? override.enabled : agent.enabled,
      delegatableAgentIds: agent.kind === "primary"
        ? [...new Set([...agent.delegatableAgentIds, ...remoteAgentIds])]
        : agent.delegatableAgentIds,
    };
  });
  const managedIds = new Set([...builtinIds, ...remoteAgentIds]);
  const custom = parseAgents(value)
    .filter((agent) => !managedIds.has(agent.id))
    .map((agent) => ({ ...agent, source: "custom" as const }));
  return [...builtins, ...remoteAgents, ...custom].map(attachPluginSkills);
}

export async function saveAgentDefinitions(agents: AgentDefinition[]): Promise<void> {
  const [openFicMCatalog, remotePackage] = await Promise.all([getInstalledOpenFicMCatalog(), getInstalledOhStoryPackage()]);
  const managedIds = new Set([...(openFicMCatalog?.agents ?? []).map((agent) => agent.id), ...(remotePackage?.agents ?? []).map((agent) => agent.id)]);
  await writeJson("agent.definitions", agents.map((agent) => managedIds.has(agent.id)
    ? { id: agent.id, enabled: agent.enabled, modelId: agent.modelId }
    : { ...agent, source: "custom" }));
}

export function isManagedPluginSkill(skill: AgentSkill): boolean {
  return skill.source === "plugin" && isLornStyleSkillId(skill.id);
}

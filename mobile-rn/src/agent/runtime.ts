import { callModel } from "@/llm/client";
import type { AgentMessage, AgentToolCall, AgentToolDefinition } from "@/llm/types";
import { createId } from "@/lib/id";
import { styleProfileLabel } from "@/lib/style-label";
import {
  getAgentDefinitions,
  getAgentRules,
  getAgentSkills,
  getToolPermissions,
  TOOL_CATALOG,
  type AgentDefinition,
  type AgentRule,
  type AgentSkill,
  type ToolPermissionMode,
} from "@/settings/config";
import { getProviderApiKey, getSetting, listModels, listProviders, setSetting } from "@/data/repositories";
import {
  getActiveStyleProfile,
  getActiveStyleSelection,
  listStyleProfiles,
  setActiveStyleProfile,
} from "@/data/style-repositories";
import {
  evolveAuthorStyle,
  shouldInjectAuthorStyleGuide,
} from "@/settings/lorn-style-plugin";
import type {
  AgentClarificationQuestion,
  AgentClarificationRequest,
  AgentClarificationResponse,
  AgentRunTrace,
  AgentTraceEvent,
  ChatMessage,
  ModelSelection,
  Note,
  Project,
  StyleProfile,
} from "@/types";

import { listNotes, noteScope } from "@/data/note-repositories";

import { agentTools, executeAgentTool } from "./tools";

const MAX_AGENT_ITERATIONS = 12;
const MAX_DELEGATION_DEPTH = 1;
// 主智能体与全部子智能体共享同一个请求预算，避免一条消息把中转站的 RPM 打满。
const MAX_TOTAL_MODEL_REQUESTS = 24;
const MAX_TRACE_STRING_LENGTH = 700;
export const AGENT_CANCELLED_MESSAGE = "This task was cancelled";
// 提示词里只列笔记标题，正文交给 read_note 按需加载，避免每次请求都背上全部笔记内容。
const MAX_PROMPT_NOTE_TITLES = 40;
// English output contract: remote skill/reference material is mostly Chinese, so this declares a
// priority higher than any of it and is repeated at the top and bottom of the system prompt.
const ENGLISH_OUTPUT_CONTRACT = "Language contract (highest priority): reply and write all prose in English (UK). Any instructions, skill manuals, reference samples or source text in another language are methodology or evidence only — never mirror their language; translate rather than repeat them verbatim.";
const CHARACTER_CONSISTENCY_TOOL_NAMES = new Set([
  "list_characters",
  "read_character",
  "create_character",
  "edit_character",
]);
const WORLD_CONSISTENCY_TOOL_NAMES = new Set([
  "list_world_entries",
  "read_world_entry",
  "create_world_entry",
  "edit_world_entry",
]);

type ToolApproval = (name: string, args: Record<string, unknown>) => Promise<boolean>;
type AskUser = (request: AgentClarificationRequest) => Promise<AgentClarificationResponse>;
type TraceListener = (trace: AgentRunTrace) => void;

type RuntimeCatalog = {
  agents: AgentDefinition[];
  rules: AgentRule[];
  skills: AgentSkill[];
  permissions: Record<string, ToolPermissionMode>;
  historyLimit: number;
  compressSystemPrompts: boolean;
  styleSelectionConfigured: boolean;
  activeStyleProfile: StyleProfile | null;
  availableStyleProfiles: StyleProfile[];
  notes: Note[];
};

type LoopResult = {
  content: string;
  consistencyRequired: boolean;
  characterConsistencyChecked: boolean;
  worldConsistencyChecked: boolean;
  consistencyEventId: string | null;
};

type TraceEventDraft = Omit<AgentTraceEvent, "id" | "startedAt" | "completedAt">;

type RequestBudget = { remaining: number };

type LoopInput = {
  project: Project;
  selection: ModelSelection;
  history: AgentMessage[];
  catalog: RuntimeCatalog;
  agent: AgentDefinition;
  consistencyReason: string | null;
  consistencyEventId: string | null;
  approveTool?: ToolApproval;
  askUser?: AskUser;
  recorder: TraceRecorder;
  requiredSkill: AgentSkill | null;
  userRequest: string;
  depth: number;
  budget: RequestBudget;
  signal?: AbortSignal;
};

export interface AgentRunResult {
  content: string;
  trace: AgentRunTrace;
}

export class AgentRunError extends Error {
  readonly trace: AgentRunTrace;

  constructor(message: string, trace: AgentRunTrace) {
    super(message);
    this.name = "AgentRunError";
    this.trace = trace;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error(AGENT_CANCELLED_MESSAGE);
}

function cloneTrace(trace: AgentRunTrace): AgentRunTrace {
  return { ...trace, events: trace.events.map((event) => ({ ...event })) };
}

function createTraceRecorder(
  agent: AgentDefinition,
  collaborationSuggested: boolean,
  onTrace?: TraceListener,
) {
  let trace: AgentRunTrace = {
    version: 1,
    id: createId(),
    status: "running",
    primaryAgentId: agent.id,
    primaryAgentName: agent.name,
    collaborationRequired: collaborationSuggested,
    startedAt: new Date().toISOString(),
    events: [],
  };

  const publish = () => onTrace?.(cloneTrace(trace));
  publish();

  return {
    add(event: TraceEventDraft): string {
      const id = createId();
      trace = {
        ...trace,
        events: [...trace.events, { ...event, id, startedAt: new Date().toISOString() }],
      };
      publish();
      return id;
    },
    update(id: string, patch: Partial<Omit<AgentTraceEvent, "id" | "startedAt">>): void {
      const completedAt = patch.status === "completed" || patch.status === "error"
        ? patch.completedAt ?? new Date().toISOString()
        : patch.completedAt;
      trace = {
        ...trace,
        events: trace.events.map((event) => event.id === id
          ? { ...event, ...patch, completedAt }
          : event),
      };
      publish();
    },
    complete(): void {
      trace = { ...trace, status: "completed", completedAt: new Date().toISOString() };
      publish();
    },
    fail(message: string): void {
      const completedAt = new Date().toISOString();
      trace = {
        ...trace,
        status: "error",
        completedAt,
        events: trace.events.map((event) => event.status === "running" || event.status === "waiting"
          ? {
            ...event,
            status: "error",
            detail: event.detail ? `${event.detail}\n${message}` : message,
            completedAt,
          }
          : event),
      };
      publish();
    },
    snapshot(): AgentRunTrace {
      return cloneTrace(trace);
    },
  };
}

type TraceRecorder = ReturnType<typeof createTraceRecorder>;

function truncate(value: string, maximum = MAX_TRACE_STRING_LENGTH): string {
  const normalized = value.trim();
  return normalized.length > maximum ? `${normalized.slice(0, maximum)}…` : normalized;
}

function compactTraceValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return truncate(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (value === undefined) return undefined;
  if (depth >= 3) return Array.isArray(value) ? `[${value.length} items]` : "[object]";
  if (Array.isArray(value)) {
    const items = value.slice(0, 8).map((item) => compactTraceValue(item, depth + 1));
    if (value.length > items.length) items.push(`…${value.length - items.length} more items`);
    return items;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value).slice(0, 12);
    const output = Object.fromEntries(entries.map(([key, item]) => [key, compactTraceValue(item, depth + 1)]));
    if (Object.keys(value).length > entries.length) output["…"] = `${Object.keys(value).length - entries.length} more items`;
    return output;
  }
  return String(value);
}

function formatTracePayload(value: unknown): string | undefined {
  const compact = compactTraceValue(value);
  if (compact === undefined) return undefined;
  const output = typeof compact === "string" ? compact : JSON.stringify(compact, null, 2);
  return output.trim() || undefined;
}

function toolDisplayName(name: string): string {
  return TOOL_CATALOG.find((tool) => tool.key === name)?.name ?? name;
}

function toolResultDetail(name: string, result: Record<string, unknown>): string {
  const count = (key: string) => Array.isArray(result[key]) ? result[key].length : 0;
  if (name === "list_chapters") return `Read ${count("chapters")} chapters`;
  if (name === "list_characters") return `Read ${count("characters")} characters`;
  if (name === "list_world_entries") return `Read ${count("entries")} world book entries`;
  if (name === "list_notes") return `Read ${count("notes")} notes`;
  if (name === "read_note") return `Read note: ${isRecord(result.note) ? String(result.note.title ?? "") : ""}`.trim();
  if (name === "search_chapters" || name === "search_knowledge") return `Found ${count("results")} relevant items`;
  if (name === "read_chapter") return `Read chapter: ${isRecord(result.chapter) ? String(result.chapter.title ?? "") : ""}`.trim();
  if (name === "read_character") return `Read character: ${isRecord(result.character) ? String(result.character.name ?? "") : ""}`.trim();
  if (name === "read_world_entry") return `Read world entry: ${isRecord(result.entry) ? String(result.entry.name ?? "") : ""}`.trim();
  if (name === "read_author_style_guide") return result.exists === true ? "Read the author style guide" : "This project has no author style guide yet";
  if (name === "list_style_sources") return `Read ${count("sources")} reference books`;
  if (name === "list_style_profiles") return `Read ${count("profiles")} style profiles`;
  if (name === "read_style_source_sample") return `Read reference sample: ${isRecord(result.source) ? String(result.source.title ?? "") : ""}`.trim();
  if (name === "read_style_profile") return `Read style: ${isRecord(result.profile) ? String(result.profile.name ?? "") : ""}`.trim();
  if (name === "select_style_profile") return `Switched writing style: ${String(result.active_profile_name ?? "")}`;
  if (name === "save_reference_style_profile") return `Saved reference style: ${String(result.name ?? "")}`;
  if (name === "save_author_style_guide") return "Saved the author style guide";
  if (name === "evolve_author_style") return `Evolved and saved the author style guide · ${String(result.source ?? "")}`;
  if (typeof result.title === "string") return `Done: ${result.title}`;
  if (typeof result.name === "string") return `Done: ${result.name}`;
  return result.success === true ? "Done" : "Returned a result";
}

function latestUserRequest(history: ChatMessage[]): string {
  return [...history].reverse().find((message) => message.role === "user")?.content.trim() ?? "";
}

function requiresKnowledgeSynchronization(content: string): boolean {
  const hasKnowledgeSubject = /(创作思路|世界观|世界书|设定|角色|人物|关系|背景|阵营|势力|地点|规则|能力|剧情|情节|worldview|world book|setting|lore|canon|character|relationship|background|faction|location|rule|ability|plot|storyline)/i.test(content);
  const hasDecision = /(我想|我准备|我决定|确定|设定为|改成|改为|调整|新增|加入|删除|取消|更新|同步|补充|以后|接下来|让.+(?:成为|会|要)|i want|i plan|i(?:'ve| have) decided|i decided|set (?:it )?to|change (?:it )?to|adjust|add|introduce|remove|delete|cancel|update|sync(?:hronise|hronize)?|supplement|from now on|going forward|next|make .+ (?:become|will|should))/i.test(content);
  return hasKnowledgeSubject && hasDecision;
}

function requiresAgentCollaboration(content: string): boolean {
  if (/(多智能体|子智能体|agent|协作|分工|multi-agent|sub-?agents?|collaborat|divide (?:the )?work)/i.test(content)) return true;
  const hasAction = /(帮我|请|需要|设计|规划|分析|审查|检查|完善|调整|生成|构建|梳理|推演|help|please|need|design|plan|analys|analy[sz]e|review|check|improve|adjust|generate|build|organi[sz]e|reason)/i.test(content);
  const dimensions = [
    /(章节|正文|文风|对话|chapter|prose|writing style|dialogue)/i,
    /(剧情|情节|大纲|节奏|伏笔|plot|storyline|outline|pacing|foreshadow)/i,
    /(角色|人物|关系|弧光|character|relationship|character arc)/i,
    /(世界观|世界书|设定|背景|势力|worldview|world book|lore|setting|background|faction)/i,
  ].filter((pattern) => pattern.test(content)).length;
  return hasAction && (dimensions >= 2 || (dimensions >= 1 && content.length >= 80));
}

function isWritingRequest(content: string): boolean {
  return /(正文|章节|续写|扩写|改写|重写|润色|仿写|写作|写(?:一|这|第|下|后|个).{0,8}章|prose|chapter|continue writing|keep writing|expand|rewrite|rephrase|polish|write (?:a|the|this|next|another)|draft)/i.test(content);
}

function requiredSkillForRequest(
  catalog: RuntimeCatalog,
  agent: AgentDefinition,
  request: string,
): AgentSkill | null {
  const skills = enabledSkillsForAgent(catalog, agent);
  const lornSkillId = /(更新我的文风|保存并进化文风|update my (?:writing )?style|save and evolve (?:my )?style)/i.test(request)
    ? "plugin-lorn-style--evolution"
    : /(蒸馏文风|分析小说文风|提取文笔\s*DNA|distill (?:the )?style|extract (?:the )?(?:style|writing) DNA|analys(?:e|is) (?:the )?(?:novel|writing) style|analy[sz]e (?:the )?(?:novel|writing) style)/i.test(request)
      ? "plugin-lorn-style--distillation"
      : null;
  if (lornSkillId) return skills.find((skill) => skill.id === lornSkillId) ?? null;
  if (!requiresAgentCollaboration(request) && !requiresKnowledgeSynchronization(request)) return null;
  const preferredIds = /(审查|检查|质量|复盘|review|check|quality|retrospective)/i.test(request)
    ? ["builtin-skill--story-quality", "builtin-skill--reader-contract"]
    : /(角色|人物|对白|对话|关系|character|relationship|dialogue)/i.test(request)
      ? ["builtin-skill--character-design", "builtin-skill--character-relationship", "builtin-skill--dialogue-design"]
      : /(正文|章节|续写|扩写|改写|润色|prose|chapter|continue|expand|rewrite|polish)/i.test(request)
        ? ["builtin-skill--prose-format", "builtin-skill--story-quality", "builtin-skill--deslop-writing"]
        : /(世界观|世界书|设定|背景|阵营|势力|创作思路|worldview|world book|lore|setting|background|faction)/i.test(request)
          ? ["builtin-skill--story-state-tracking", "builtin-skill--story-hooks"]
          : ["builtin-skill--story-state-tracking", "builtin-skill--story-quality"];
  return preferredIds.map((id) => skills.find((skill) => skill.id === id)).find(Boolean) ?? skills[0] ?? null;
}

function requiredArgument(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing argument ${key}`);
  return value.trim();
}

function normalizeQuestions(args: Record<string, unknown>): AgentClarificationQuestion[] {
  if (!Array.isArray(args.questions) || args.questions.length < 1 || args.questions.length > 3) {
    throw new Error("ask_user must provide 1 to 3 independent questions each time");
  }
  return args.questions.map((item, index) => {
    if (!isRecord(item)) throw new Error(`Question ${index + 1} has an invalid format`);
    const title = typeof item.title === "string" ? truncate(item.title, 160) : "";
    if (!title) throw new Error(`Question ${index + 1} is missing a title`);
    const description = typeof item.description === "string" ? truncate(item.description, 500) : undefined;
    if (!Array.isArray(item.options) || item.options.length > 5) {
      throw new Error(`Question "${title}" may have at most 5 options`);
    }
    const seen = new Set<string>();
    const options = item.options.flatMap((option) => {
      if (!isRecord(option) || typeof option.label !== "string") return [];
      const label = truncate(option.label, 80);
      if (!label || seen.has(label)) return [];
      seen.add(label);
      return [{
        label,
        description: typeof option.description === "string" ? truncate(option.description, 240) : undefined,
      }];
    });
    return { title, description, options };
  });
}

function enabledSkillsForAgent(catalog: RuntimeCatalog, agent: AgentDefinition): AgentSkill[] {
  const allowedIds = new Set(agent.skillIds);
  return catalog.skills.filter((skill) => skill.enabled && (!allowedIds.size || allowedIds.has(skill.id)));
}

function enabledDelegates(catalog: RuntimeCatalog, agent: AgentDefinition): AgentDefinition[] {
  const allowedIds = new Set(agent.delegatableAgentIds);
  return catalog.agents.filter((candidate) => candidate.enabled && candidate.kind === "subagent" && allowedIds.has(candidate.id));
}

function toolsForAgent(agent: AgentDefinition): AgentToolDefinition[] {
  const allowed = new Set(agent.toolNames.length ? agent.toolNames : agentTools.map((tool) => tool.name));
  allowed.add("ask_user");
  allowed.add("read_author_style_guide");
  allowed.add("save_author_style_guide");
  allowed.add("evolve_author_style");
  allowed.add("list_style_sources");
  allowed.add("read_style_source_sample");
  allowed.add("list_style_profiles");
  allowed.add("read_style_profile");
  allowed.add("select_style_profile");
  allowed.add("save_reference_style_profile");
  if (agent.kind !== "primary") allowed.delete("delegate_agent");
  return agentTools.filter((tool) => allowed.has(tool.name));
}

function systemPrompt(input: {
  project: Project;
  catalog: RuntimeCatalog;
  agent: AgentDefinition;
  consistencyReason: string | null;
  userRequest: string;
}): string {
  const sections = [`You are the ${input.agent.name} agent of the OpenFicM mobile app. The current project is "${input.project.title}".
Project synopsis: ${input.project.description || "none"}
The project, chapters, characters, world book and chat history are stored on this device; the app only goes online when calling the model API the user configured.
Work strictly from the current project data returned by tools; never mix information from other projects into this one.
When the user clearly states a new creative decision, character change, world rule or plot fact, do not merely restate it in chat. First read the existing characters and world book, confirm it is canonical, then call the create/edit tools to sync it into the project. If it is still brainstorming, has several possible interpretations, or is not yet confirmed, call ask_user first and only then write; never treat an unconfirmed option as canonical.
After a chapter is added or changed, prefer judging from the current prose whether a character or world entry really changed, and call the matching create/edit tools for confirmed new facts. Do not block the current task with a token check, and do not re-read all material when nothing changed. Delete characters or world entries only when the user explicitly asks. All write tools remain subject to the user's permission approval.
When a preference or ambiguity would materially change the result, use ask_user to ask one to three independent questions; do not ask back on simple questions.
Never assume a skill's content from its name; when a task matches a skill description, first call activate_skill to load the full instructions. Tool arguments must strictly match their declarations.`];

  if (input.consistencyReason) {
    sections.push(`A change worth attention was detected in the project: ${input.consistencyReason}\nPrefer judging from the current task whether characters or the world book need syncing; write confirmed new facts into the matching material, and do not block this task with a token check.`);
  }
  if (input.agent.systemPrompt.trim()) {
    sections.push(`Current agent definition:\n${input.agent.systemPrompt.trim()}`);
  }
  if (input.catalog.activeStyleProfile && shouldInjectAuthorStyleGuide(input.agent, input.userRequest)) {
    const profile = input.catalog.activeStyleProfile;
    const profileType = profile.kind === "author" ? "author style" : "reference-novel style";
    sections.push(`The ${profileType} currently used for writing is "${styleProfileLabel(profile)}":\n${truncate(profile.guide, 16_000)}\n\nTreat this guide as an additional style constraint when generating or editing prose; it cannot override the user's explicit request this turn, factual consistency or safety boundaries. Do not copy sentences or proprietary expressions from the reference novel.`);
  }
  const enabledRules = input.catalog.rules.filter((rule) => rule.enabled && rule.content.trim());
  if (enabledRules.length) {
    sections.push(`Rules that must be followed:\n${enabledRules.map((rule) => `- ${rule.name}: ${rule.content.trim()}`).join("\n")}`);
  }
  if (input.catalog.notes.length) {
    const scopeLabel = { project: "book", volume: "volume", chapter: "chapter" } as const;
    const listed = input.catalog.notes.slice(0, MAX_PROMPT_NOTE_TITLES);
    const lines = listed.map((note) => `- [${scopeLabel[noteScope(note)]}] ${note.title} (id: ${note.id})`);
    if (input.catalog.notes.length > listed.length) {
      lines.push(`- ${input.catalog.notes.length - listed.length} more; call list_notes for the full list`);
    }
    sections.push(`Notes for the current project (titles only here; call read_note for the content):\n${lines.join("\n")}`);
  }
  sections.push("Outlines, plot directions and foreshadowing plans — content that has not yet happened in the prose — belong in notes; save them with write_note, not in the world book. The world book holds only established canon; mixing in unplanned ideas makes later writing treat them as fact.");

  const skills = enabledSkillsForAgent(input.catalog, input.agent);
  if (skills.length) {
    sections.push(`Skills that can be activated on demand:\n${skills.map((skill) => `- ${skill.name} (${skill.id}): ${skill.description}`).join("\n")}`);
  }
  const delegates = enabledDelegates(input.catalog, input.agent);
  if (delegates.length) {
    sections.push(`Sub-agents that can be delegated to:\n${delegates.map((agent) => `- ${agent.name} (${agent.id}): ${agent.description}`).join("\n")}\nCall delegate_agent only when an extra specialist perspective is needed; the delegated task must include the goal, project context, deliverable and constraints. Handle a single-pass continuation, polish or small edit yourself — do not spin up extra requests just to look organised. The primary agent integrates the results and must not forward a sub-agent's raw output to the user without judgement.`);
  }
  // Repeat the English contract last so it overrides any Chinese instructions quoted above.
  return [ENGLISH_OUTPUT_CONTRACT, sections.join("\n\n"), ENGLISH_OUTPUT_CONTRACT].join("\n\n");
}

function activePrimaryAgent(agents: AgentDefinition[], activeAgentId: string | null): AgentDefinition {
  const selected = agents.find((agent) => agent.id === activeAgentId && agent.enabled && agent.kind === "primary")
    ?? agents.find((agent) => agent.id === "builtin-agent--build" && agent.enabled)
    ?? agents.find((agent) => agent.enabled && agent.kind === "primary");
  if (!selected) throw new Error("No primary agent is available; enable one in Settings");
  return selected;
}

function latestStyleProfiles(profiles: StyleProfile[]): StyleProfile[] {
  const series = new Set<string>();
  return profiles.filter((profile) => {
    if (series.has(profile.seriesId)) return false;
    series.add(profile.seriesId);
    return true;
  });
}

async function ensureWritingStyleSelection(input: {
  projectId: string;
  request: string;
  catalog: RuntimeCatalog;
  askUser?: AskUser;
  recorder: TraceRecorder;
  agentName: string;
}): Promise<void> {
  if (!isWritingRequest(input.request)
    || input.catalog.styleSelectionConfigured
    || !input.catalog.availableStyleProfiles.length
    || !input.askUser) return;
  const profiles = latestStyleProfiles(input.catalog.availableStyleProfiles).slice(0, 4);
  const profileByLabel = new Map(profiles.map((profile) => [
    styleProfileLabel(profile),
    profile,
  ]));
  const eventId = input.recorder.add({
    kind: "question",
    status: "waiting",
    title: "Choose the writing style for this task",
    agentName: input.agentName,
    detail: "Confirm the style to inject before generating prose",
  });
  const response = await input.askUser({
    id: eventId,
    agentName: input.agentName,
    questions: [{
      title: "Which writing style should this prose use?",
      description: "Your choice is bound to this AI draft; after you revise it, the author style can evolve from it.",
      options: [
        ...profiles.map((profile, index) => ({
          label: `${styleProfileLabel(profile)}${index === 0 ? " (recommended)" : ""}`,
          description: profile.kind === "author" ? "Use the author style accumulated for this project" : "Use constraints distilled from imported reference novels",
        })),
        { label: "No style", description: "Follow only this turn's request and the project material" },
      ],
    }],
  });
  if (response.cancelled) {
    input.recorder.update(eventId, { status: "completed", detail: "Skipped the style choice this time" });
    return;
  }
  const answer = response.answers[0]?.answer.trim() ?? "";
  let selected: StyleProfile | null = null;
  if (!/no style|without style|none|不使用|不用/i.test(answer)) {
    const normalizedAnswer = answer.replace(/ \(recommended\)$/, "");
    selected = profileByLabel.get(normalizedAnswer)
      ?? profiles.find((profile) => profile.id === answer || profile.name === answer)
      ?? null;
    if (!selected) {
      input.recorder.update(eventId, { status: "error", detail: "Selected style not found" });
      throw new Error("The selected style could not be found; please choose again from the style library");
    }
  }
  await setActiveStyleProfile(input.projectId, selected?.id ?? null);
  input.catalog.styleSelectionConfigured = true;
  input.catalog.activeStyleProfile = selected;
  input.recorder.update(eventId, {
    status: "completed",
    detail: selected ? `Selected ${styleProfileLabel(selected)}` : "No style for this task",
  });
}

async function authorizeToolCall(
  call: AgentToolCall,
  permissions: Record<string, ToolPermissionMode>,
  approveTool?: ToolApproval,
): Promise<void> {
  const permission = permissions[call.name] ?? "ask";
  if (permission === "deny") throw new Error("This tool is disabled in Settings");
  if (permission === "ask") {
    const approved = approveTool ? await approveTool(call.name, call.arguments) : false;
    if (!approved) throw new Error("The user did not approve this tool call");
  }
}

async function selectionForAgent(agent: AgentDefinition, fallback: ModelSelection): Promise<ModelSelection> {
  if (!agent.modelId || agent.modelId === fallback.model.id) return fallback;
  const [models, providers] = await Promise.all([listModels(), listProviders()]);
  const model = models.find((item) => item.id === agent.modelId);
  if (!model) return fallback;
  const provider = providers.find((item) => item.id === model.providerId);
  if (!provider) return fallback;
  const apiKey = await getProviderApiKey(provider);
  if (!apiKey) return fallback;
  return { model, provider, apiKey };
}

async function runAgentLoop(input: LoopInput): Promise<LoopResult> {
  const prompt = systemPrompt({
    project: input.project,
    catalog: input.catalog,
    agent: input.agent,
    consistencyReason: input.consistencyReason,
    userRequest: input.userRequest,
  });
  // 长会话截取后第一条可能是 assistant；Anthropic 等协议要求首条非系统消息必须是 user，去掉前导 assistant。
  const trimmedHistory = input.history.slice(-input.catalog.historyLimit);
  while (trimmedHistory.length && trimmedHistory[0].role !== "user") trimmedHistory.shift();
  const messages: AgentMessage[] = [
    {
      role: "system",
      content: input.catalog.compressSystemPrompts
        ? prompt.split("\n").map((line) => line.trim()).filter(Boolean).join("\n")
        : prompt,
    },
    ...trimmedHistory,
  ];
  const tools = toolsForAgent(input.agent);
  const allowedToolNames = new Set(tools.map((tool) => tool.name));
  let consistencyRequired = Boolean(input.consistencyReason);
  let characterConsistencyChecked = false;
  let worldConsistencyChecked = false;
  let consistencyEventId = input.consistencyEventId;

  if (input.requiredSkill) {
    const skillEventId = input.recorder.add({
      kind: "skill",
      status: "running",
      title: "Activating skill: " + input.requiredSkill.name,
      agentName: input.agent.name,
      toolName: "activate_skill",
      detail: "Loading specialist instructions for this task",
      input: input.requiredSkill.description,
    });
    messages.push({
      role: "system",
      content: "Skill \"" + input.requiredSkill.name + "\" is now active. You must follow these complete instructions:\n" + input.requiredSkill.instructions,
    });
    input.recorder.update(skillEventId, {
      status: "completed",
      title: "Skill activated: " + input.requiredSkill.name,
      detail: input.requiredSkill.description,
    });
  }

  if (consistencyRequired && !consistencyEventId) {
    consistencyEventId = input.recorder.add({
      kind: "consistency",
      status: "running",
      title: "Checking characters and world book",
      agentName: input.agent.name,
      detail: input.consistencyReason ?? "Checking for project canon changes",
    });
  }

  for (let iteration = 0; iteration < MAX_AGENT_ITERATIONS; iteration += 1) {
    throwIfAborted(input.signal);
    if (input.budget.remaining <= 0) {
      throw new Error("This task reached the model request limit; split the request and try again");
    }
    input.budget.remaining -= 1;
    const turn = await callModel(input.selection, messages, tools, { signal: input.signal });
    messages.push({ role: "assistant", content: turn.content, toolCalls: turn.toolCalls });

    if (turn.toolCalls.length === 0) {
      if (consistencyRequired && consistencyEventId) {
        input.recorder.update(consistencyEventId, {
          status: "completed",
          detail: characterConsistencyChecked && worldConsistencyChecked
            ? "Checked characters and world book and synced the confirmed changes"
            : "Finished this turn's writing; no character or world book changes needed syncing",
        });
      }
      return {
        content: turn.content || "The model returned no content",
        consistencyRequired,
        characterConsistencyChecked,
        worldConsistencyChecked,
        consistencyEventId,
      };
    }

    for (const call of turn.toolCalls) {
      throwIfAborted(input.signal);
      const kind = call.name === "activate_skill"
        ? "skill"
        : call.name === "delegate_agent"
          ? "agent"
          : call.name === "ask_user"
            ? "question"
            : "tool";
      const permission = input.catalog.permissions[call.name] ?? "ask";
      const eventId = input.recorder.add({
        kind,
        status: permission === "ask" ? "waiting" : "running",
        title: toolDisplayName(call.name),
        agentName: input.agent.name,
        toolName: call.name,
        detail: permission === "ask" ? "Waiting for tool permission" : "Running",
        input: formatTracePayload(call.arguments),
      });
      try {
        if (!allowedToolNames.has(call.name)) throw new Error(`${input.agent.name} is not allowed to use tool ${call.name}`);
        await authorizeToolCall(call, input.catalog.permissions, input.approveTool);
        input.recorder.update(eventId, { status: "running", detail: "Running" });
        let result: Record<string, unknown>;
        let eventTitle = toolDisplayName(call.name);
        let eventDetail: string;

        if (call.name === "ask_user") {
          const questions = normalizeQuestions(call.arguments);
          if (!input.askUser) throw new Error("This screen cannot receive structured answers");
          input.recorder.update(eventId, {
            status: "waiting",
            title: `${input.agent.name} needs confirmation`,
            detail: `Waiting for answers to ${questions.length} question(s)`,
          });
          const response = await input.askUser({ id: eventId, agentName: input.agent.name, questions });
          result = { cancelled: response.cancelled, answers: response.answers };
          eventTitle = `Questions from ${input.agent.name}`;
          eventDetail = response.cancelled ? "The user skipped these questions" : `Answered ${response.answers.length} question(s)`;
        } else if (call.name === "activate_skill") {
          const requested = requiredArgument(call.arguments, "skill_name");
          const skill = enabledSkillsForAgent(input.catalog, input.agent)
            .find((item) => item.id === requested || item.name === requested);
          if (!skill) throw new Error(`Skill is not in the available list for ${input.agent.name}: ${requested}`);
          result = { skill_id: skill.id, skill_name: skill.name, instructions: skill.instructions };
          eventTitle = `Skill activated: ${skill.name}`;
          eventDetail = skill.description;
        } else if (call.name === "delegate_agent") {
          if (input.depth >= MAX_DELEGATION_DEPTH || input.agent.kind !== "primary") {
            throw new Error("Only a primary agent can delegate one level of sub-agents");
          }
          const agentId = requiredArgument(call.arguments, "agent_id");
          const childAgent = enabledDelegates(input.catalog, input.agent).find((agent) => agent.id === agentId);
          if (!childAgent) throw new Error(`Sub-agent is not on the delegation allow-list: ${agentId}`);
          const task = requiredArgument(call.arguments, "task");
          eventTitle = `${childAgent.name} is collaborating`;
          input.recorder.update(eventId, { title: eventTitle, detail: "Reading the project and handling the task" });
          const childSelection = await selectionForAgent(childAgent, input.selection);
          const childResult = await runAgentLoop({
            ...input,
            selection: childSelection,
            history: [{ role: "user", content: task }],
            agent: childAgent,
            consistencyReason: null,
            consistencyEventId: null,
            requiredSkill: requiredSkillForRequest(input.catalog, childAgent, task),
            userRequest: task,
            depth: input.depth + 1,
          });
          result = { agent_id: childAgent.id, agent_name: childAgent.name, result: childResult.content };
          eventDetail = `${childAgent.name} returned a result`;
        } else if (call.name === "evolve_author_style") {
          const evolved = await evolveAuthorStyle({
            projectId: input.project.id,
            aiDraft: requiredArgument(call.arguments, "ai_draft"),
            authorRevision: requiredArgument(call.arguments, "author_revision"),
            selection: input.selection,
          });
          input.catalog.styleSelectionConfigured = true;
          input.catalog.activeStyleProfile = evolved.profile;
          input.catalog.availableStyleProfiles = [
            evolved.profile,
            ...input.catalog.availableStyleProfiles.filter((profile) => profile.id !== evolved.profile.id),
          ];
          result = {
            success: true,
            source: evolved.source,
            profile_id: evolved.profile.id,
            version: evolved.profile.version,
            guide_characters: evolved.guide.length,
          };
          eventDetail = toolResultDetail(call.name, result);
        } else {
          result = await executeAgentTool(input.project.id, call.name, call.arguments);
          eventDetail = toolResultDetail(call.name, result);
          if (call.name === "save_author_style_guide" || call.name === "select_style_profile") {
            input.catalog.styleSelectionConfigured = true;
            input.catalog.activeStyleProfile = await getActiveStyleProfile(input.project.id);
          }
          if (call.name === "save_reference_style_profile") {
            input.catalog.availableStyleProfiles = await listStyleProfiles(input.project.id);
          }
          if ((call.name === "write_chapter" || call.name === "edit_chapter") && input.depth === 0) {
            consistencyRequired = true;
            characterConsistencyChecked = false;
            worldConsistencyChecked = false;
            if (!consistencyEventId) {
              consistencyEventId = input.recorder.add({
                kind: "consistency",
                status: "running",
                title: "Checking characters and world book",
                agentName: input.agent.name,
                detail: "Chapter content changed; checking related canon",
              });
            } else {
              input.recorder.update(consistencyEventId, {
                status: "running",
                completedAt: undefined,
                detail: "Chapter content changed; re-checking related canon",
              });
            }
          } else if (consistencyRequired) {
            if (CHARACTER_CONSISTENCY_TOOL_NAMES.has(call.name)) characterConsistencyChecked = true;
            if (WORLD_CONSISTENCY_TOOL_NAMES.has(call.name)) worldConsistencyChecked = true;
            if (characterConsistencyChecked && worldConsistencyChecked && consistencyEventId) {
              input.recorder.update(consistencyEventId, {
                status: "completed",
                detail: "Characters and world book have both been checked",
              });
            }
          }
        }
        input.recorder.update(eventId, {
          status: "completed",
          title: eventTitle,
          detail: eventDetail,
          output: call.name === "activate_skill"
            ? undefined
            : formatTracePayload(result),
        });
        messages.push({ role: "tool", content: JSON.stringify(result), toolCallId: call.id, toolName: call.name });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        input.recorder.update(eventId, { status: "error", detail: message });
        messages.push({
          role: "tool",
          content: JSON.stringify({ error: message }),
          toolCallId: call.id,
          toolName: call.name,
        });
      }
    }
  }
  throw new Error(`${input.agent.name} made too many tool calls; this task was stopped`);
}

export async function runAgent(input: {
  project: Project;
  selection: ModelSelection;
  history: ChatMessage[];
  agentId?: string | null;
  approveTool?: ToolApproval;
  askUser?: AskUser;
  onTrace?: TraceListener;
  /** 外部取消信号：停止按钮或切换作品时中止本次运行。 */
  signal?: AbortSignal;
}): Promise<AgentRunResult> {
  throwIfAborted(input.signal);
  const consistencyKey = `agent.pendingConsistency.${input.project.id}`;
  const [rules, skills, agents, permissions, activeAgentId, historyLimitValue, compressValue, pendingConsistency, styleSelection, availableStyleProfiles, notes] = await Promise.all([
    getAgentRules(),
    getAgentSkills(),
    getAgentDefinitions(),
    getToolPermissions(),
    getSetting("agent.activeDefinitionId"),
    getSetting("context.historyLimit"),
    getSetting("context.compressSystemPrompts"),
    getSetting(consistencyKey),
    getActiveStyleSelection(input.project.id),
    listStyleProfiles(input.project.id),
    listNotes(input.project.id),
  ]);
  const parsedHistoryLimit = Number(historyLimitValue);
  const catalog: RuntimeCatalog = {
    rules,
    skills,
    agents,
    permissions,
    historyLimit: Number.isInteger(parsedHistoryLimit) && parsedHistoryLimit >= 4 && parsedHistoryLimit <= 100
      ? parsedHistoryLimit
      : 30,
    compressSystemPrompts: compressValue === "true",
    styleSelectionConfigured: styleSelection.configured,
    activeStyleProfile: styleSelection.profile,
    availableStyleProfiles,
    notes,
  };
  const agent = activePrimaryAgent(agents, input.agentId ?? activeAgentId);
  const userRequest = latestUserRequest(input.history);
  const delegates = enabledDelegates(catalog, agent);
  const collaborationSuggested = requiresAgentCollaboration(userRequest)
    && delegates.length > 0
    && toolsForAgent(agent).some((tool) => tool.name === "delegate_agent")
    && permissions.delegate_agent !== "deny";
  const consistencyReason = pendingConsistency
    || (requiresKnowledgeSynchronization(userRequest)
      ? "The user provided a creative decision this turn that may affect characters or the world book"
      : null);
  const requiredSkill = requiredSkillForRequest(catalog, agent, userRequest);
  const recorder = createTraceRecorder(agent, collaborationSuggested, input.onTrace);

  try {
    await ensureWritingStyleSelection({
      projectId: input.project.id,
      request: userRequest,
      catalog,
      askUser: input.askUser,
      recorder,
      agentName: agent.name,
    });
    const result = await runAgentLoop({
      project: input.project,
      selection: input.selection,
      history: input.history
        .filter((message) => !(message.role === "assistant" && message.metadata?.taskStatus === "failed"))
        .map((message) => ({ role: message.role, content: message.content })),
      catalog,
      agent,
      consistencyReason,
      consistencyEventId: null,
      approveTool: input.approveTool,
      askUser: input.askUser,
      recorder,
      requiredSkill,
      userRequest,
      depth: 0,
      budget: { remaining: MAX_TOTAL_MODEL_REQUESTS },
      signal: input.signal,
    });
    if (result.consistencyRequired) {
      await setSetting(consistencyKey, "");
    }
    recorder.complete();
    return { content: result.content, trace: recorder.snapshot() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recorder.fail(message);
    throw new AgentRunError(message, recorder.snapshot());
  }
}

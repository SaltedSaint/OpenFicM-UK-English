import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";

import { Button, ErrorNotice, Field, Header, Screen } from "@/components/ui";
import {
  getSetting,
  listModels,
  setSetting,
} from "@/data/repositories";
import { createId } from "@/lib/id";
import { exportBackup } from "@/lib/backup";
import { useAppStore } from "@/store/app-store";
import {
  DEFAULT_INDEX_SETTINGS,
  getAgentDefinitions,
  getAgentRules,
  getAgentSkills,
  getIndexSettings,
  getToolPermissions,
  saveAgentDefinitions,
  saveAgentRules,
  saveAgentSkills,
  saveIndexSettings,
  saveToolPermissions,
  TOOL_CATALOG,
  type AgentDefinition,
  type AgentRule,
  type AgentSkill,
  type IndexSettings,
  type ToolPermissionMode,
} from "@/settings/config";
import { clearProjectIndex, getProjectIndexStats, indexProject } from "@/search/indexer";
import { getLocalModelStatus, warmUpLocalModels } from "@/search/local-models";
import {
  getRuntimeResourceState,
  installMissingRuntimeResources,
  LOCAL_MODEL_INFO,
  type RuntimeResourceState,
} from "@/settings/remote-resources";
import {
  checkOhStoryRelease,
  compareOhStoryVersions,
  getOhStoryUpdateState,
  installOhStoryRelease,
  rollbackOhStoryPackage,
  type OhStoryRelease,
  type OhStoryUpdateState,
} from "@/settings/oh-story-updater";
import {
  checkAppUpdate,
  getLastAppUpdateCheck,
  CURRENT_APP_VERSION,
  type AppUpdateInfo,
} from "@/settings/app-update";
import { colors, radius, spacing } from "@/theme";
import type { Model } from "@/types";

export type SettingsCategory =
  | "general"
  | "connections"
  | "models"
  | "index"
  | "context"
  | "style"
  | "agent-tools"
  | "rules"
  | "skills"
  | "agents"
  | "advanced";

const TITLES: Record<Exclude<SettingsCategory, "models">, string> = {
  general: "General",
  connections: "Connections",
  index: "Index",
  context: "Context",
  style: "Author style",
  "agent-tools": "Tool permissions",
  rules: "Rules",
  skills: "Skills",
  agents: "Agents",
  advanced: "Advanced",
};

const EMPTY_OH_STORY_STATE: OhStoryUpdateState = { installed: null, previous: null, lastCheck: null };

function SettingRow({ label, value, onPress, destructive = false }: {
  label: string;
  value?: string;
  onPress?: () => void;
  destructive?: boolean;
}) {
  return (
    <Pressable disabled={!onPress} onPress={onPress} style={styles.settingRow}>
      <Text style={[styles.settingLabel, destructive && styles.dangerText]}>{label}</Text>
      {value ? <Text numberOfLines={2} style={styles.settingValue}>{value}</Text> : null}
      {onPress ? <Ionicons name="chevron-forward" size={18} color={colors.textMuted} /> : null}
    </Pressable>
  );
}

function ToggleRow({ label, value, onChange }: { label: string; value: boolean; onChange: (value: boolean) => void }) {
  return (
    <View style={styles.settingRow}>
      <Text style={styles.settingLabel}>{label}</Text>
      <Switch value={value} onValueChange={onChange} trackColor={{ false: colors.border, true: colors.primary }} />
    </View>
  );
}

export function SettingsCategoryScreen({ category, onBack }: { category: Exclude<SettingsCategory, "models">; onBack: () => void }) {
  const projectId = useAppStore((state) => state.currentProjectId);
  const refreshData = useAppStore((state) => state.refreshData);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [indexSettings, setIndexSettings] = useState<IndexSettings>(DEFAULT_INDEX_SETTINGS);
  const [indexStats, setIndexStats] = useState({ sources: 0, chunks: 0 });
  const [indexProgress, setIndexProgress] = useState("");
  const [rules, setRules] = useState<AgentRule[]>([]);
  const [skills, setSkills] = useState<AgentSkill[]>([]);
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [availableModels, setAvailableModels] = useState<Model[]>([]);
  const [permissions, setPermissions] = useState<Record<string, ToolPermissionMode>>({});
  const [activeAgentId, setActiveAgentId] = useState("");
  const [ruleName, setRuleName] = useState("");
  const [ruleContent, setRuleContent] = useState("");
  const [skillName, setSkillName] = useState("");
  const [skillDescription, setSkillDescription] = useState("");
  const [skillInstructions, setSkillInstructions] = useState("");
  const [agentName, setAgentName] = useState("");
  const [agentDescription, setAgentDescription] = useState("");
  const [agentPrompt, setAgentPrompt] = useState("");
  const [agentModelId, setAgentModelId] = useState("");
  const [historyLimit, setHistoryLimit] = useState("30");
  const [compression, setCompression] = useState(false);
  const [autoSaveDelay, setAutoSaveDelay] = useState("1000");
  const [editorFontSize, setEditorFontSize] = useState("17");
  const [requestTimeout, setRequestTimeout] = useState("120000");
  const [maxAttempts, setMaxAttempts] = useState("3");
  const [maxServerErrorAttempts, setMaxServerErrorAttempts] = useState("2");
  const [maxRateLimitAttempts, setMaxRateLimitAttempts] = useState("1");
  const [retryOnTimeout, setRetryOnTimeout] = useState(false);
  const [ohStoryState, setOhStoryState] = useState<OhStoryUpdateState>(EMPTY_OH_STORY_STATE);
  const [ohStoryProgress, setOhStoryProgress] = useState("");
  const [ohStoryBusy, setOhStoryBusy] = useState(false);
  const [resourceState, setResourceState] = useState<RuntimeResourceState | null>(null);
  const [resourceProgress, setResourceProgress] = useState("");
  const [resourceBusy, setResourceBusy] = useState(false);
  const [appUpdate, setAppUpdate] = useState<AppUpdateInfo | null>(null);
  const [appUpdateBusy, setAppUpdateBusy] = useState(false);
  const [appUpdateError, setAppUpdateError] = useState<string | null>(null);
  const [backupBusy, setBackupBusy] = useState(false);

  const runBackup = async () => {
    setBackupBusy(true);
    setError(null);
    try {
      await exportBackup();
    } catch (backupError) {
      setError(backupError instanceof Error ? backupError.message : String(backupError));
    } finally {
      setBackupBusy(false);
    }
  };

  const checkForAppUpdate = async () => {
    setAppUpdateBusy(true);
    setAppUpdateError(null);
    try {
      setAppUpdate(await checkAppUpdate());
    } catch (updateError) {
      setAppUpdateError(updateError instanceof Error ? updateError.message : String(updateError));
    } finally {
      setAppUpdateBusy(false);
    }
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextIndex, nextRules, nextSkills, nextAgents, nextPermissions, active, history, compress, autoSave, fontSize, timeout, attempts, serverAttempts, rateLimitAttempts, retryOnTimeoutValue, nextModels, nextOhStoryState, nextResourceState] = await Promise.all([
        getIndexSettings(),
        getAgentRules(),
        getAgentSkills(),
        getAgentDefinitions(),
        getToolPermissions(),
        getSetting("agent.activeDefinitionId"),
        getSetting("context.historyLimit"),
        getSetting("context.compressSystemPrompts"),
        getSetting("general.autoSaveDelay"),
        getSetting("general.editorFontSize"),
        getSetting("connections.requestTimeout"),
        getSetting("connections.maxAttempts"),
        getSetting("connections.maxServerErrorAttempts"),
        getSetting("connections.maxRateLimitAttempts"),
        getSetting("connections.retryOnTimeout"),
        listModels(),
        getOhStoryUpdateState(),
        getRuntimeResourceState(),
      ]);
      setAppUpdate(await getLastAppUpdateCheck());
      setIndexSettings(nextIndex);
      setRules(nextRules);
      setSkills(nextSkills);
      setAgents(nextAgents);
      setPermissions(nextPermissions);
      const activeAgent = nextAgents.find((agent) => agent.id === active && agent.enabled && agent.kind === "primary")
        ?? nextAgents.find((agent) => agent.id === "builtin-agent--build" && agent.enabled)
        ?? nextAgents.find((agent) => agent.enabled && agent.kind === "primary");
      const nextActiveAgentId = activeAgent?.id ?? "";
      setActiveAgentId(nextActiveAgentId);
      if (nextActiveAgentId !== (active ?? "")) await setSetting("agent.activeDefinitionId", nextActiveAgentId);
      setHistoryLimit(history ?? "30");
      setCompression(compress === "true");
      setAutoSaveDelay(autoSave ?? "1000");
      setEditorFontSize(fontSize ?? "17");
      setRequestTimeout(timeout ?? "120000");
      setMaxAttempts(attempts ?? "3");
      setMaxServerErrorAttempts(serverAttempts ?? "2");
      setMaxRateLimitAttempts(rateLimitAttempts ?? "1");
      setRetryOnTimeout(retryOnTimeoutValue === "true");
      setAvailableModels(nextModels);
      setOhStoryState(nextOhStoryState);
      setResourceState(nextResourceState);
      if (projectId) setIndexStats(await getProjectIndexStats(projectId));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useFocusEffect(useCallback(() => {
    void load();
  }, [load]));

  const savePreference = async (key: string, value: string) => {
    setSaving(true);
    setError(null);
    try {
      await setSetting(key, value);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  };

  const downloadResources = async () => {
    setResourceBusy(true);
    setError(null);
    setResourceProgress("Preparing to fetch runtime resources…");
    try {
      const next = await installMissingRuntimeResources((item) => {
        if (item.totalBytes && item.totalBytes > 0 && item.bytesWritten !== undefined) {
          setResourceProgress(`${item.label} · ${Math.min(100, Math.round(item.bytesWritten / item.totalBytes * 100))}%`);
        } else {
          setResourceProgress(item.total > 1 ? `${item.label} · ${item.completed}/${item.total}` : item.label);
        }
      });
      setResourceState(next);
      setResourceProgress("Warming up the local retrieval models…");
      await warmUpLocalModels();
      setResourceProgress("All runtime resources are ready");
    } catch (resourceError) {
      setError(resourceError instanceof Error ? resourceError.message : String(resourceError));
      setResourceState(await getRuntimeResourceState().catch(() => null));
    } finally {
      setResourceBusy(false);
    }
  };

  const saveIndex = async (next: IndexSettings) => {
    setSaving(true);
    setError(null);
    try {
      await saveIndexSettings(next);
      setIndexSettings(await getIndexSettings());
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  };

  const rebuildIndex = async () => {
    if (!projectId) {
      setError("Open a project from the shelf first");
      return;
    }
    setSaving(true);
    setIndexProgress("Preparing index…");
    setError(null);
    try {
      await indexProject(projectId, {
        force: true,
        onProgress: ({ completed, total, title }) => setIndexProgress(total ? `${completed}/${total} · ${title}` : title),
      });
      setIndexStats(await getProjectIndexStats(projectId));
      setIndexProgress("Index complete");
    } catch (indexError) {
      setError(indexError instanceof Error ? indexError.message : String(indexError));
    } finally {
      setSaving(false);
    }
  };

  const persistManagedState = async <T,>(
    next: T,
    persist: (value: T) => Promise<void>,
    apply: (value: T) => void,
  ): Promise<boolean> => {
    setError(null);
    try {
      await persist(next);
      apply(next);
      return true;
    } catch (persistError) {
      setError(persistError instanceof Error ? persistError.message : String(persistError));
      return false;
    }
  };

  const addRule = async () => {
    if (!ruleName.trim() || !ruleContent.trim()) return;
    const next = [...rules, { id: createId(), name: ruleName.trim(), content: ruleContent.trim(), enabled: true }];
    if (!await persistManagedState(next, saveAgentRules, setRules)) return;
    setRuleName("");
    setRuleContent("");
  };

  const addSkill = async () => {
    if (!skillName.trim() || !skillInstructions.trim()) return;
    const skill: AgentSkill = {
      id: createId(),
      name: skillName.trim(),
      description: skillDescription.trim(),
      instructions: skillInstructions.trim(),
      enabled: true,
      source: "custom",
    };
    const next = [...skills, skill];
    if (!await persistManagedState(next, saveAgentSkills, setSkills)) return;
    setSkillName("");
    setSkillDescription("");
    setSkillInstructions("");
  };

  const addAgent = async () => {
    if (!agentName.trim() || !agentPrompt.trim()) return;
    const agent: AgentDefinition = {
      id: createId(),
      name: agentName.trim(),
      description: agentDescription.trim(),
      systemPrompt: agentPrompt.trim(),
      modelId: agentModelId,
      enabled: true,
      kind: "primary",
      skillIds: skills.filter((skill) => skill.enabled).map((skill) => skill.id),
      toolNames: TOOL_CATALOG.map((tool) => tool.key),
      delegatableAgentIds: agents.filter((agent) => agent.enabled && agent.kind === "subagent").map((agent) => agent.id),
      source: "custom",
    };
    const next = [...agents, agent];
    if (!await persistManagedState(next, saveAgentDefinitions, setAgents)) return;
    setAgentName("");
    setAgentDescription("");
    setAgentPrompt("");
    setAgentModelId("");
  };

  const cyclePermission = async (key: string) => {
    const current = permissions[key] ?? "ask";
    const nextMode: ToolPermissionMode = current === "allow" ? "ask" : current === "ask" ? "deny" : "allow";
    const next = { ...permissions, [key]: nextMode };
    await persistManagedState(next, saveToolPermissions, setPermissions);
  };

  const selectAgent = async (agent: AgentDefinition) => {
    if (!agent.enabled || agent.kind !== "primary") return;
    try {
      await setSetting("agent.activeDefinitionId", agent.id);
      setActiveAgentId(agent.id);
    } catch (selectError) {
      setError(selectError instanceof Error ? selectError.message : String(selectError));
    }
  };

  const toggleAgent = async (agentId: string, enabled: boolean) => {
    const next = agents.map((agent) => agent.id === agentId ? { ...agent, enabled } : agent);
    try {
      await saveAgentDefinitions(next);
      setAgents(next);
      if (!enabled && activeAgentId === agentId) {
        const fallback = next.find((agent) => agent.enabled && agent.kind === "primary");
        const fallbackId = fallback?.id ?? "";
        await setSetting("agent.activeDefinitionId", fallbackId);
        setActiveAgentId(fallbackId);
      }
    } catch (toggleError) {
      setError(toggleError instanceof Error ? toggleError.message : String(toggleError));
    }
  };

  const removeAgent = async (agentId: string) => {
    const next = agents.filter((agent) => agent.id !== agentId || agent.source === "builtin");
    try {
      await saveAgentDefinitions(next);
      setAgents(next);
      if (activeAgentId === agentId) {
        const fallback = next.find((agent) => agent.enabled && agent.kind === "primary");
        const fallbackId = fallback?.id ?? "";
        await setSetting("agent.activeDefinitionId", fallbackId);
        setActiveAgentId(fallbackId);
      }
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : String(removeError));
    }
  };

  const reloadOhStoryCatalog = async () => {
    const [nextState, nextSkills, nextAgents] = await Promise.all([
      getOhStoryUpdateState(),
      getAgentSkills(),
      getAgentDefinitions(),
    ]);
    setOhStoryState(nextState);
    setSkills(nextSkills);
    setAgents(nextAgents);
    refreshData();
  };

  const checkOhStory = async () => {
    setOhStoryBusy(true);
    setError(null);
    setOhStoryProgress("Checking the GitHub release…");
    try {
      const release = await checkOhStoryRelease();
      setOhStoryState((current) => ({ ...current, lastCheck: release }));
      const hasUpdate = !ohStoryState.installed
        || compareOhStoryVersions(release.version, ohStoryState.installed.version) > 0;
      const sourceChanged = Boolean(
        (ohStoryState.installed?.commitSha ?? ohStoryState.installed?.treeSha)
        && compareOhStoryVersions(release.version, ohStoryState.installed.version) === 0
        && release.commitSha !== (ohStoryState.installed.commitSha ?? ohStoryState.installed.treeSha),
      );
      setOhStoryProgress(sourceChanged
        ? `The source revision for ${release.version} changed; a silent same-version overwrite was blocked`
        : hasUpdate ? `Found ${release.version}` : `Already on the latest version ${release.version}`);
    } catch (checkError) {
      setError(checkError instanceof Error ? checkError.message : String(checkError));
      setOhStoryProgress("");
    } finally {
      setOhStoryBusy(false);
    }
  };

  const installOhStory = async (release: OhStoryRelease) => {
    setOhStoryBusy(true);
    setError(null);
    setOhStoryProgress(`Preparing to update to ${release.version}`);
    try {
      const installed = await installOhStoryRelease(release, ({ completed, total }) => {
        setOhStoryProgress(`Downloading and verifying ${completed}/${total}`);
      });
      await reloadOhStoryCatalog();
      setOhStoryProgress(`Installed ${installed.version}`);
    } catch (installError) {
      setError(installError instanceof Error ? installError.message : String(installError));
    } finally {
      setOhStoryBusy(false);
    }
  };

  const confirmOhStoryInstall = (release: OhStoryRelease) => {
    Alert.alert(
      "Update the oh-story content pack",
      `This installs the 7 skills and 6 mobile-compatible sub-agents of ${release.version}. Only Markdown is imported; no scripts or hooks are run.`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Update", onPress: () => void installOhStory(release) },
      ],
    );
  };

  const confirmOhStoryRollback = () => {
    const previous = ohStoryState.previous;
    if (!previous) return;
    Alert.alert("Roll back the oh-story content pack", `Restore ${previous.version}? The current version is kept so you can roll back again.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Roll back",
        onPress: () => {
          setOhStoryBusy(true);
          setError(null);
          void rollbackOhStoryPackage()
            .then(async (restored) => {
              await reloadOhStoryCatalog();
              setOhStoryProgress(`Restored ${restored.version}`);
            })
            .catch((rollbackError) => setError(rollbackError instanceof Error ? rollbackError.message : String(rollbackError)))
            .finally(() => setOhStoryBusy(false));
        },
      },
    ]);
  };

  const ohStoryUpdateAvailable = Boolean(
    ohStoryState.lastCheck
    && (!ohStoryState.installed
      || compareOhStoryVersions(ohStoryState.lastCheck.version, ohStoryState.installed.version) > 0),
  );

  if (loading) return <Screen><Header title={TITLES[category]} onBack={onBack} /><View style={styles.loading}><ActivityIndicator color={colors.primary} /></View></Screen>;

  return (
    <Screen scroll>
      <Header title={TITLES[category]} onBack={onBack} />
      {error ? <View style={styles.errorWrap}><ErrorNotice message={error} onRetry={() => void load()} /></View> : null}
      {category === "general" ? (
        <View style={styles.section}>
          <Field label="Auto-save delay (ms)" value={autoSaveDelay} onChangeText={setAutoSaveDelay} onBlur={() => void savePreference("general.autoSaveDelay", autoSaveDelay)} keyboardType="number-pad" />
          <Field label="Editor font size" value={editorFontSize} onChangeText={setEditorFontSize} onBlur={() => void savePreference("general.editorFontSize", editorFontSize)} keyboardType="number-pad" />
          <SettingRow label="Data location" value="On-device SQLite · API keys use SecureStore" />
          <Button label={backupBusy ? "Exporting" : "Export a full data backup"} variant="secondary" onPress={() => void runBackup()} disabled={backupBusy} loading={backupBusy} />
          <Text style={styles.fieldHint}>The backup includes every project, character, world book, note, style, setting and reference book, packed as a zip and saved through system sharing; see the note inside the archive for how to restore.</Text>
        </View>
      ) : null}
      {category === "connections" ? (
        <View style={styles.section}>
          <Field label="Model request timeout (ms)" value={requestTimeout} onChangeText={setRequestTimeout} onBlur={() => void savePreference("connections.requestTimeout", requestTimeout)} keyboardType="number-pad" />
          <Field label="Max attempts on network error (1-5)" value={maxAttempts} onChangeText={setMaxAttempts} onBlur={() => void savePreference("connections.maxAttempts", maxAttempts)} keyboardType="number-pad" />
          <Field label="Max attempts on server error (1-3)" value={maxServerErrorAttempts} onChangeText={setMaxServerErrorAttempts} onBlur={() => void savePreference("connections.maxServerErrorAttempts", maxServerErrorAttempts)} keyboardType="number-pad" />
          <Field label="Max attempts on rate limit (429) (1-3)" value={maxRateLimitAttempts} onChangeText={setMaxRateLimitAttempts} onBlur={() => void savePreference("connections.maxRateLimitAttempts", maxRateLimitAttempts)} keyboardType="number-pad" />
          <Text style={styles.fieldHint}>Attempt counts include the first request; rate limiting is not retried by default, to avoid amplifying throttling at a relay.</Text>
          <ToggleRow label="Resend automatically after a timeout (may double-bill)" value={retryOnTimeout} onChange={(value) => {
            setRetryOnTimeout(value);
            void savePreference("connections.retryOnTimeout", String(value));
          }} />
          <SettingRow label="Providers and models" value="Managed in the Models category" />
          <SettingRow label="Network boundary" value="The app goes online only when calling the model API you configured; project data stays on this device" />
        </View>
      ) : null}
      {category === "index" ? (
        <View style={styles.section}>
          <ToggleRow label="Enable the local semantic index" value={indexSettings.enabled} onChange={(value) => void saveIndex({ ...indexSettings, enabled: value })} />
          <ToggleRow label="Enable the local reranking model" value={indexSettings.rerankEnabled} onChange={(value) => void saveIndex({ ...indexSettings, rerankEnabled: value })} />
          <Field label="Chunk size (characters)" value={String(indexSettings.chunkSize)} onChangeText={(value) => setIndexSettings({ ...indexSettings, chunkSize: Number(value) || 120 })} onBlur={() => void saveIndex(indexSettings)} keyboardType="number-pad" />
          <Field label="Chunk overlap (characters)" value={String(indexSettings.chunkOverlap)} onChangeText={(value) => setIndexSettings({ ...indexSettings, chunkOverlap: Number(value) || 0 })} onBlur={() => void saveIndex(indexSettings)} keyboardType="number-pad" />
          <Field label="Retrieval count" value={String(indexSettings.retrievalTopK)} onChangeText={(value) => setIndexSettings({ ...indexSettings, retrievalTopK: Number(value) || 1 })} onBlur={() => void saveIndex(indexSettings)} keyboardType="number-pad" />
          <Field label="Rerank count" value={String(indexSettings.rerankTopK)} onChangeText={(value) => setIndexSettings({ ...indexSettings, rerankTopK: Number(value) || 1 })} onBlur={() => void saveIndex(indexSettings)} keyboardType="number-pad" />
          <Text style={styles.statusText}>Current index: {indexStats.sources} sources · {indexStats.chunks} chunks</Text>
          <Button label={saving ? "Indexing" : "Rebuild the current project index"} onPress={() => void rebuildIndex()} disabled={!projectId || saving} loading={saving} />
          {indexProgress ? <Text style={styles.progressText}>{indexProgress}</Text> : null}
        </View>
      ) : null}
      {category === "context" ? (
        <View style={styles.section}>
          <Field label="Recent messages to keep" value={historyLimit} onChangeText={setHistoryLimit} onBlur={() => void savePreference("context.historyLimit", historyLimit)} keyboardType="number-pad" />
          <ToggleRow label="Compress system prompts" value={compression} onChange={(value) => {
            setCompression(value);
            void savePreference("context.compressSystemPrompts", String(value));
          }} />
        </View>
      ) : null}
      {category === "style" ? (
        <View style={styles.section}>
          <SettingRow label="Style library" value="Re-open it from the settings menu" />
        </View>
      ) : null}
      {category === "agent-tools" ? (
        <View style={styles.section}>
          <Text style={styles.sectionHint}>Tap a permission to cycle through: Allow, Ask, Deny.</Text>
          {TOOL_CATALOG.map((tool) => (
            <Pressable key={tool.key} onPress={() => void cyclePermission(tool.key)} style={styles.permissionRow}>
              <View style={styles.permissionText}>
                <Text style={styles.settingLabel}>{tool.name}</Text>
                <Text style={styles.settingValue}>{tool.key}</Text>
              </View>
              <Text style={[styles.permissionMode, permissions[tool.key] === "deny" && styles.dangerText]}>
                {permissions[tool.key] === "allow" ? "Allow" : permissions[tool.key] === "deny" ? "Deny" : "Ask"}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {category === "rules" ? (
        <View style={styles.section}>
          {rules.map((rule) => (
            <View key={rule.id} style={styles.manageRow}>
              <View style={styles.manageText}>
                <Text style={styles.settingLabel}>{rule.name}</Text>
                <Text numberOfLines={3} style={styles.settingValue}>{rule.content}</Text>
              </View>
              <Switch value={rule.enabled} onValueChange={(enabled) => {
                const next = rules.map((item) => item.id === rule.id ? { ...item, enabled } : item);
                void persistManagedState(next, saveAgentRules, setRules);
              }} trackColor={{ false: colors.border, true: colors.primary }} />
              <Pressable accessibilityLabel="Delete rule" onPress={() => {
                const next = rules.filter((item) => item.id !== rule.id);
                void persistManagedState(next, saveAgentRules, setRules);
              }} style={styles.iconButton}><Ionicons name="trash-outline" size={19} color={colors.textMuted} /></Pressable>
            </View>
          ))}
          <Field label="Rule name" value={ruleName} onChangeText={setRuleName} />
          <Field label="Rule content" value={ruleContent} onChangeText={setRuleContent} multiline style={styles.multiline} />
          <Button label="Add rule" onPress={() => void addRule()} disabled={!ruleName.trim() || !ruleContent.trim()} />
        </View>
      ) : null}
      {category === "skills" ? (
        <View style={styles.section}>
          {skills.map((skill) => (
            <View key={skill.id} style={styles.manageRow}>
              <View style={styles.manageText}>
                <Text style={styles.settingLabel}>{skill.name}</Text>
                <Text numberOfLines={2} style={styles.settingValue}>{skill.description || skill.instructions}</Text>
                <Text style={styles.modelHint}>
                  {skill.source === "builtin" ? "OpenFicM built-in pack" : skill.source === "plugin" ? "Lorn style plugin" : skill.source === "remote" ? "oh-story updated skill" : "Custom skill"} · activated on demand
                </Text>
              </View>
              <Switch value={skill.enabled} onValueChange={(enabled) => {
                const next = skills.map((item) => item.id === skill.id ? { ...item, enabled } : item);
                void persistManagedState(next, saveAgentSkills, setSkills);
              }} trackColor={{ false: colors.border, true: colors.primary }} />
              {skill.source === "custom" ? (
                <Pressable accessibilityLabel="Delete skill" onPress={() => {
                  const next = skills.filter((item) => item.id !== skill.id);
                  void persistManagedState(next, saveAgentSkills, setSkills);
                }} style={styles.iconButton}><Ionicons name="trash-outline" size={19} color={colors.textMuted} /></Pressable>
              ) : <View style={styles.iconButton}><Ionicons name="lock-closed-outline" size={18} color={colors.textMuted} /></View>}
            </View>
          ))}
          <Field label="Skill name" value={skillName} onChangeText={setSkillName} />
          <Field label="Skill description" value={skillDescription} onChangeText={setSkillDescription} />
          <Field label="Skill instructions" value={skillInstructions} onChangeText={setSkillInstructions} multiline style={styles.multiline} />
          <Button label="Add skill" onPress={() => void addSkill()} disabled={!skillName.trim() || !skillInstructions.trim()} />
        </View>
      ) : null}
      {category === "agents" ? (
        <View style={styles.section}>
          {agents.map((agent) => (
            <View key={agent.id} style={[styles.manageRow, activeAgentId === agent.id && styles.activeRow]}>
              <View style={styles.manageText}>
                <Text style={styles.settingLabel}>{agent.name}</Text>
                <Text numberOfLines={2} style={styles.settingValue}>{agent.description || agent.systemPrompt}</Text>
                <Text style={styles.modelHint}>
                  {agent.source === "builtin" ? "OpenFicM built-in pack" : agent.source === "remote" ? "oh-story update" : "Custom"} · {agent.kind === "primary" ? "Primary agent" : "Sub-agent"} · {agent.skillIds.length} skills
                </Text>
                {agent.modelId ? <Text style={styles.modelHint}>{availableModels.find((model) => model.id === agent.modelId)?.name ?? "Model deleted"}</Text> : null}
              </View>
              <Switch value={agent.enabled} onValueChange={(enabled) => void toggleAgent(agent.id, enabled)} trackColor={{ false: colors.border, true: colors.primary }} />
              {agent.kind === "primary" ? (
                <Pressable accessibilityLabel={`Select ${agent.name} as primary agent`} disabled={!agent.enabled} onPress={() => void selectAgent(agent)} style={styles.iconButton}>
                  <Ionicons name={activeAgentId === agent.id ? "radio-button-on" : "radio-button-off"} size={21} color={activeAgentId === agent.id ? colors.primary : colors.textMuted} />
                </Pressable>
              ) : <View style={styles.iconButton}><Ionicons name="git-branch-outline" size={20} color={colors.textMuted} /></View>}
              {agent.source === "custom" ? (
                <Pressable accessibilityLabel="Delete agent" onPress={() => void removeAgent(agent.id)} style={styles.iconButton}>
                  <Ionicons name="trash-outline" size={19} color={colors.textMuted} />
                </Pressable>
              ) : <View style={styles.iconButton}><Ionicons name="lock-closed-outline" size={18} color={colors.textMuted} /></View>}
            </View>
          ))}
          <Field label="Agent name" value={agentName} onChangeText={setAgentName} />
          <Field label="Agent description" value={agentDescription} onChangeText={setAgentDescription} />
          <Field label="System prompt" value={agentPrompt} onChangeText={setAgentPrompt} multiline style={styles.multiline} />
          <Text style={styles.sectionHint}>Agent model</Text>
          <View style={styles.modelChoices}>
            <Pressable onPress={() => setAgentModelId("")} style={[styles.modelChoice, !agentModelId && styles.modelChoiceActive]}>
              <Text style={styles.modelChoiceText}>Follow global</Text>
            </Pressable>
            {availableModels.map((model) => (
              <Pressable key={model.id} onPress={() => setAgentModelId(model.id)} style={[styles.modelChoice, agentModelId === model.id && styles.modelChoiceActive]}>
                <Text numberOfLines={1} style={styles.modelChoiceText}>{model.name}</Text>
              </Pressable>
            ))}
          </View>
          <Button label="Add agent" onPress={() => void addAgent()} disabled={!agentName.trim() || !agentPrompt.trim()} />
        </View>
      ) : null}
      {category === "advanced" ? (
        <View style={styles.section}>
          <Text style={styles.subsectionTitle}>App version</Text>
          <SettingRow label="Current version" value={CURRENT_APP_VERSION} />
          <SettingRow
            label="Latest version"
            value={appUpdate ? `${appUpdate.latestVersion}${appUpdate.hasUpdate ? " (update available)" : " (up to date)"}` : "Not checked yet"}
          />
          {appUpdate?.checkedAt ? (
            <SettingRow label="Last checked" value={new Date(appUpdate.checkedAt).toLocaleString()} />
          ) : null}
          <Button
            label={appUpdateBusy ? "Checking" : "Check for app updates"}
            onPress={() => void checkForAppUpdate()}
            disabled={appUpdateBusy}
            loading={appUpdateBusy}
          />
          {appUpdate?.hasUpdate ? (
            <Button
              label={`Go to download ${appUpdate.latestVersion}`}
              onPress={() => void Linking.openURL(appUpdate.releaseUrl)}
            />
          ) : null}
          {appUpdateError ? <Text style={styles.progressText}>{appUpdateError}</Text> : null}
          {appUpdate?.hasUpdate && appUpdate.notes ? (
            <Text style={styles.updateNotes} numberOfLines={12}>{appUpdate.notes}</Text>
          ) : null}
          <View style={styles.subsectionDivider} />
          <Text style={styles.subsectionTitle}>oh-story content pack</Text>
          <SettingRow label="Local version" value={ohStoryState.installed?.version ?? "Not installed"} />
          <SettingRow label="Latest found" value={ohStoryState.lastCheck ? `${ohStoryState.lastCheck.version} · ${ohStoryState.lastCheck.commitSha.slice(0, 8)}` : "Not checked yet"} />
          {ohStoryState.installed ? (
            <>
              <SettingRow
                label="Installed content"
                value={`${ohStoryState.installed.skills.length} skills · ${ohStoryState.installed.agents.length} sub-agents · ${ohStoryState.installed.sha256.slice(0, 12)}`}
              />
              {ohStoryState.installed.commitSha || ohStoryState.installed.treeSha ? (
                <SettingRow label="Source revision" value={(ohStoryState.installed.commitSha ?? ohStoryState.installed.treeSha ?? "").slice(0, 12)} />
              ) : null}
            </>
          ) : null}
          <Button label={ohStoryBusy ? "Working" : "Check the GitHub release"} onPress={() => void checkOhStory()} disabled={ohStoryBusy} loading={ohStoryBusy && ohStoryProgress.includes("Checking")} />
          {ohStoryUpdateAvailable && ohStoryState.lastCheck ? (
            <Button label={`Update to ${ohStoryState.lastCheck.version}`} onPress={() => confirmOhStoryInstall(ohStoryState.lastCheck as OhStoryRelease)} disabled={ohStoryBusy} />
          ) : null}
          {ohStoryState.previous ? (
            <Button label={`Roll back to ${ohStoryState.previous.version}`} variant="secondary" onPress={confirmOhStoryRollback} disabled={ohStoryBusy} />
          ) : null}
          {ohStoryProgress ? <Text style={styles.progressText}>{ohStoryProgress}</Text> : null}
          <View style={styles.subsectionDivider} />
          <Text style={styles.subsectionTitle}>Local retrieval models</Text>
          <SettingRow label="Embedding model" value={`${LOCAL_MODEL_INFO.embedding.name} · about 25 MB`} />
          <SettingRow label="Rerank model" value={`${LOCAL_MODEL_INFO.rerank.name} · about 209 MB`} />
          <SettingRow label="Current load state" value={`Embedding: ${getLocalModelStatus().embeddingLoaded ? "loaded" : "not loaded"} · Rerank: ${getLocalModelStatus().rerankLoaded ? "loaded" : "not loaded"}`} />
          <SettingRow label="Runtime resource status" value={resourceState?.ready ? "Complete" : `Missing ${resourceState?.missing.length ?? "unknown"} item(s)`} />
          <Button label={resourceBusy ? "Fetching" : "Fetch missing resources"} onPress={() => void downloadResources()} disabled={resourceBusy} loading={resourceBusy} />
          {resourceProgress ? <Text style={styles.progressText}>{resourceProgress}</Text> : null}
          <Button label="Clear the current project index" variant="secondary" onPress={() => {
            if (!projectId) return;
            Alert.alert("Clear index", "This deletes only the index, not chapter, character or world book data.", [
              { text: "Cancel", style: "cancel" },
              { text: "Clear", style: "destructive", onPress: () => void clearProjectIndex(projectId).then(() => setIndexStats({ sources: 0, chunks: 0 })) },
            ]);
          }} disabled={!projectId} />
        </View>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  loading: { flex: 1, alignItems: "center", justifyContent: "center" },
  errorWrap: { padding: spacing.lg, paddingBottom: 0 },
  section: { gap: spacing.md, padding: spacing.lg },
  subsectionTitle: { color: colors.text, fontSize: 17, fontWeight: "700" },
  subsectionDivider: { height: StyleSheet.hairlineWidth, marginVertical: spacing.sm, backgroundColor: colors.border },
  sectionHint: { color: colors.textMuted, fontSize: 13, lineHeight: 19 },
  fieldHint: { color: colors.textMuted, fontSize: 12, lineHeight: 18, marginTop: -spacing.sm },
  settingRow: { minHeight: 52, flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingVertical: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  settingLabel: { flex: 1, color: colors.text, fontSize: 15, fontWeight: "600" },
  settingValue: { flex: 1, color: colors.textMuted, fontSize: 13, lineHeight: 19, textAlign: "right" },
  permissionRow: { minHeight: 60, flexDirection: "row", alignItems: "center", gap: spacing.md, paddingVertical: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  permissionText: { flex: 1, minWidth: 0 },
  permissionMode: { minWidth: 64, color: colors.primary, fontSize: 13, fontWeight: "700", textAlign: "right" },
  manageRow: { minHeight: 68, flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingVertical: spacing.sm, paddingLeft: spacing.md, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm },
  activeRow: { borderColor: colors.primary, backgroundColor: "#E6F3EF" },
  manageText: { flex: 1, minWidth: 0, gap: spacing.xs },
  iconButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  multiline: { minHeight: 120 },
  progressText: { color: colors.primary, fontSize: 13 },
  updateNotes: { color: colors.textMuted, fontSize: 12, lineHeight: 18 },
  statusText: { color: colors.textMuted, fontSize: 13 },
  modelHint: { color: colors.primary, fontSize: 12 },
  modelChoices: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  modelChoice: { maxWidth: "100%", minHeight: 40, justifyContent: "center", paddingHorizontal: spacing.md, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm },
  modelChoiceActive: { borderColor: colors.primary, backgroundColor: "#E6F3EF" },
  modelChoiceText: { color: colors.text, fontSize: 13, fontWeight: "600" },
  dangerText: { color: colors.danger },
});

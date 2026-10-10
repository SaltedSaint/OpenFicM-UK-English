import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useNavigation } from "@react-navigation/native";
import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Alert, FlatList, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { Button, ErrorNotice, Field, Header, Screen, SheetBackdrop } from "@/components/ui";
import {
  deleteModel,
  deleteProvider,
  getProviderApiKey,
  getSetting,
  listModels,
  listProviders,
  saveModel,
  saveProvider,
  setSetting,
} from "@/data/repositories";
import { fetchProviderModels, type RemoteModel } from "@/llm/model-catalog";
import { DEFAULT_MAX_OUTPUT_TOKENS, MAX_CONFIGURED_OUTPUT_TOKENS } from "@/llm/limits";
import type { RootStackParamList } from "@/navigation/types";
import { SettingsCategoryScreen, type SettingsCategory } from "@/screens/settings-category-screen";
import { useAppStore } from "@/store/app-store";
import { colors, radius, spacing } from "@/theme";
import type { Model, OpenAiApiMode, Provider, ProviderType } from "@/types";

const providerDefaults: Record<ProviderType, { name: string; url: string }> = {
  "openai-compatible": { name: "OpenAI Compatible", url: "https://api.openai.com/v1" },
  "google-genai": { name: "Google Gemini", url: "https://generativelanguage.googleapis.com/v1beta" },
  anthropic: { name: "Anthropic", url: "https://api.anthropic.com/v1" },
};

const OPENAI_API_MODES: Array<{ id: OpenAiApiMode; label: string; hint: string }> = [
  { id: "chat-completions", label: "Chat Completions", hint: "POST /chat/completions; best compatibility" },
  { id: "responses", label: "Responses", hint: "POST /responses; OpenAI's newer API" },
];

const settingsCategories: Array<{
  id: SettingsCategory;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
}> = [
  { id: "general", label: "General", icon: "options-outline" },
  { id: "connections", label: "Connections", icon: "link-outline" },
  { id: "models", label: "Models & providers", icon: "hardware-chip-outline" },
  { id: "index", label: "Index", icon: "layers-outline" },
  { id: "context", label: "Context", icon: "document-text-outline" },
  { id: "style", label: "Author style", icon: "color-wand-outline" },
  { id: "agent-tools", label: "Tool permissions", icon: "shield-checkmark-outline" },
  { id: "rules", label: "Rules", icon: "list-outline" },
  { id: "skills", label: "Skills", icon: "flash-outline" },
  { id: "agents", label: "Agents", icon: "git-network-outline" },
  { id: "advanced", label: "Advanced", icon: "construct-outline" },
];

export function SettingsScreen() {
  const rootNavigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const revision = useAppStore((state) => state.dataRevision);
  const refreshData = useAppStore((state) => state.refreshData);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [activeModelId, setActiveModelId] = useState<string | null>(null);
  const [providerType, setProviderType] = useState<ProviderType>("openai-compatible");
  const [providerName, setProviderName] = useState(providerDefaults["openai-compatible"].name);
  const [baseUrl, setBaseUrl] = useState(providerDefaults["openai-compatible"].url);
  const [apiKey, setApiKey] = useState("");
  const [apiMode, setApiMode] = useState<OpenAiApiMode>("chat-completions");
  const [selectedProviderId, setSelectedProviderId] = useState("");
  const [modelName, setModelName] = useState("");
  const [modelId, setModelId] = useState("");
  const [temperature, setTemperature] = useState("0.8");
  const [maxTokens, setMaxTokens] = useState(String(DEFAULT_MAX_OUTPUT_TOKENS));
  const [saving, setSaving] = useState(false);
  const [savingModel, setSavingModel] = useState(false);
  const [fetchingProviderId, setFetchingProviderId] = useState<string | null>(null);
  const [modelPickerProvider, setModelPickerProvider] = useState<Provider | null>(null);
  const [remoteModels, setRemoteModels] = useState<RemoteModel[]>([]);
  const [modelFilter, setModelFilter] = useState("");
  const [addingRemoteModelId, setAddingRemoteModelId] = useState<string | null>(null);
  const [editingProvider, setEditingProvider] = useState<Provider | null>(null);
  const [editProviderName, setEditProviderName] = useState("");
  const [editProviderUrl, setEditProviderUrl] = useState("");
  const [editProviderApiMode, setEditProviderApiMode] = useState<OpenAiApiMode>("chat-completions");
  const [editProviderKey, setEditProviderKey] = useState("");
  const [savingProviderEdit, setSavingProviderEdit] = useState(false);
  const [editingModel, setEditingModel] = useState<Model | null>(null);
  const [editModelName, setEditModelName] = useState("");
  const [editModelTemperature, setEditModelTemperature] = useState("0.8");
  const [editModelMaxTokens, setEditModelMaxTokens] = useState(String(DEFAULT_MAX_OUTPUT_TOKENS));
  const [savingModelEdit, setSavingModelEdit] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState<SettingsCategory | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [nextProviders, nextModels, selected] = await Promise.all([listProviders(), listModels(), getSetting("activeModelId")]);
      setProviders(nextProviders);
      setModels(nextModels);
      const validSelected = selected && nextModels.some((model) => model.id === selected) ? selected : null;
      setActiveModelId(validSelected);
      setSelectedProviderId((current) => current && nextProviders.some((provider) => provider.id === current)
        ? current
        : nextProviders[0]?.id ?? "");
      if (selected && !validSelected) await setSetting("activeModelId", "");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, []);

  useFocusEffect(useCallback(() => {
    void load();
  }, [load, revision]));

  const modelsByProvider = useMemo(() => new Map(providers.map((provider) => [
    provider.id,
    models.filter((model) => model.providerId === provider.id),
  ])), [providers, models]);

  const chooseType = (type: ProviderType) => {
    setProviderType(type);
    setProviderName(providerDefaults[type].name);
    setBaseUrl(providerDefaults[type].url);
    setApiMode("chat-completions");
  };

  const addProvider = async () => {
    if (!providerName.trim() || !baseUrl.trim() || !apiKey.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const provider = await saveProvider({ name: providerName, type: providerType, baseUrl, apiKey, apiMode });
      setApiKey("");
      setSelectedProviderId(provider.id);
      refreshData();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally { setSaving(false); }
  };

  const addModel = async () => {
    if (!selectedProviderId || !modelName.trim() || !modelId.trim()) return;
    const parsedTemperature = Number(temperature);
    const parsedMaxTokens = Number(maxTokens);
    if (!Number.isFinite(parsedTemperature) || parsedTemperature < 0 || parsedTemperature > 2) {
      setError("Temperature must be between 0 and 2");
      return;
    }
    if (!Number.isInteger(parsedMaxTokens) || parsedMaxTokens < 1 || parsedMaxTokens > MAX_CONFIGURED_OUTPUT_TOKENS) {
      setError(`Maximum output tokens must be between 1 and ${MAX_CONFIGURED_OUTPUT_TOKENS}; a 1M figure is usually a context window, so do not enter 1000000`);
      return;
    }
    setSavingModel(true);
    setError(null);
    try {
      const model = await saveModel({
        providerId: selectedProviderId,
        name: modelName,
        modelId,
        temperature: parsedTemperature,
        maxTokens: parsedMaxTokens,
      });
      if (!activeModelId) {
        await setSetting("activeModelId", model.id);
        setActiveModelId(model.id);
      }
      setModelName("");
      setModelId("");
      refreshData();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSavingModel(false);
    }
  };

  const removeProvider = async (provider: Provider) => {
    try {
      await deleteProvider(provider);
      refreshData();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : String(deleteError));
    }
  };

  const selectModel = async (model: Model) => {
    try {
      await setSetting("activeModelId", model.id);
      setActiveModelId(model.id);
      refreshData();
    } catch (selectError) {
      setError(selectError instanceof Error ? selectError.message : String(selectError));
    }
  };

  const fetchRemoteModels = async (provider: Provider) => {
    setFetchingProviderId(provider.id);
    setError(null);
    try {
      const key = await getProviderApiKey(provider);
      const fetched = await fetchProviderModels(provider, key);
      if (!fetched.length) throw new Error("The provider returned no model usable for content generation");
      setRemoteModels(fetched);
      setModelFilter("");
      setModelPickerProvider(provider);
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : String(fetchError));
    } finally {
      setFetchingProviderId(null);
    }
  };

  // 一键添加用的参数：优先用“添加模型”表单里已经填好的温度/Token，非法或没填就用默认值，
  // 这样从模型列表点一下即可入库，不必再滚到页面底部按“添加模型”。
  const modelParams = (): { temperature: number; maxTokens: number } => {
    const parsedTemperature = Number(temperature);
    const parsedMaxTokens = Number(maxTokens);
    return {
      temperature: Number.isFinite(parsedTemperature) && parsedTemperature >= 0 && parsedTemperature <= 2
        ? parsedTemperature
        : 0.8,
      maxTokens: Number.isInteger(parsedMaxTokens) && parsedMaxTokens >= 1 && parsedMaxTokens <= MAX_CONFIGURED_OUTPUT_TOKENS
        ? parsedMaxTokens
        : DEFAULT_MAX_OUTPUT_TOKENS,
    };
  };

  const addRemoteModel = async (remote: RemoteModel) => {
    if (!modelPickerProvider) return;
    setAddingRemoteModelId(remote.id);
    setError(null);
    try {
      const model = await saveModel({
        providerId: modelPickerProvider.id,
        name: remote.name,
        modelId: remote.id,
        ...modelParams(),
      });
      if (!activeModelId) {
        await setSetting("activeModelId", model.id);
        setActiveModelId(model.id);
      }
      // 只刷新模型列表：弹层留在原地，可以接着加下一个，已添加的条目标成“已添加”。
      setModels(await listModels());
      refreshData();
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : String(addError));
    } finally {
      setAddingRemoteModelId(null);
    }
  };

  const addedRemoteModelIds = useMemo(() => new Set(
    models.filter((model) => model.providerId === modelPickerProvider?.id).map((model) => model.modelId),
  ), [models, modelPickerProvider]);

  const openProviderEdit = (provider: Provider) => {
    setEditingProvider(provider);
    setEditProviderName(provider.name);
    setEditProviderUrl(provider.baseUrl);
    setEditProviderApiMode(provider.apiMode);
    setEditProviderKey("");
    setError(null);
  };

  const saveProviderEdit = async () => {
    if (!editingProvider || !editProviderName.trim() || !editProviderUrl.trim()) return;
    setSavingProviderEdit(true);
    setError(null);
    try {
      await saveProvider({
        id: editingProvider.id,
        name: editProviderName,
        type: editingProvider.type,
        baseUrl: editProviderUrl,
        apiKey: editProviderKey,
        apiMode: editProviderApiMode,
      });
      setEditingProvider(null);
      await load();
      refreshData();
    } catch (editError) {
      setError(editError instanceof Error ? editError.message : String(editError));
    } finally {
      setSavingProviderEdit(false);
    }
  };

  const openModelEdit = (model: Model) => {
    setEditingModel(model);
    setEditModelName(model.name);
    setEditModelTemperature(String(model.temperature));
    setEditModelMaxTokens(String(model.maxTokens));
    setError(null);
  };

  const saveModelEdit = async () => {
    if (!editingModel || !editModelName.trim()) return;
    const parsedTemperature = Number(editModelTemperature);
    const parsedMaxTokens = Number(editModelMaxTokens);
    if (!Number.isFinite(parsedTemperature) || parsedTemperature < 0 || parsedTemperature > 2) {
      setError("Temperature must be between 0 and 2");
      return;
    }
    if (!Number.isInteger(parsedMaxTokens) || parsedMaxTokens < 1 || parsedMaxTokens > MAX_CONFIGURED_OUTPUT_TOKENS) {
      setError(`Maximum output tokens must be between 1 and ${MAX_CONFIGURED_OUTPUT_TOKENS}`);
      return;
    }
    setSavingModelEdit(true);
    setError(null);
    try {
      await saveModel({
        id: editingModel.id,
        providerId: editingModel.providerId,
        name: editModelName,
        modelId: editingModel.modelId,
        temperature: parsedTemperature,
        maxTokens: parsedMaxTokens,
      });
      setEditingModel(null);
      setModels(await listModels());
      refreshData();
    } catch (editError) {
      setError(editError instanceof Error ? editError.message : String(editError));
    } finally {
      setSavingModelEdit(false);
    }
  };

  const removeModel = async (model: Model) => {
    setError(null);
    try {
      await deleteModel(model);
      setModels(await listModels());
      if (activeModelId === model.id) setActiveModelId(null);
      refreshData();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : String(deleteError));
    }
  };

  const confirmDeleteModel = (model: Model) => {
    Alert.alert(
      "Delete model",
      `Delete "${model.name}" (${model.modelId})? If it is the default model, that choice is cleared too; the provider itself is kept.`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: () => void removeModel(model) },
      ],
    );
  };

  // 中转站常常返回几百个模型，按名称和 ID 做不区分大小写的子串过滤。
  const filteredRemoteModels = useMemo(() => {
    const keyword = modelFilter.trim().toLowerCase();
    if (!keyword) return remoteModels;
    return remoteModels.filter((model) => model.name.toLowerCase().includes(keyword)
      || model.id.toLowerCase().includes(keyword));
  }, [modelFilter, remoteModels]);

  if (activeCategory && activeCategory !== "models") {
    return <SettingsCategoryScreen category={activeCategory} onBack={() => setActiveCategory(null)} />;
  }

  if (!activeCategory) {
    return (
      <Screen scroll>
        <Header title="Settings" />
        <View style={styles.categoryList}>
          {settingsCategories.map((category) => (
            <Pressable
              key={category.id}
              onPress={() => {
                if (category.id === "style") rootNavigation.navigate("StyleLibrary");
                else setActiveCategory(category.id);
              }}
              style={({ pressed }) => [styles.categoryRow, pressed && styles.categoryRowPressed]}
            >
              <View style={styles.categoryIcon}><Ionicons name={category.icon} size={21} color={colors.primary} /></View>
              <Text style={styles.categoryLabel}>{category.label}</Text>
              <Ionicons name="chevron-forward" size={19} color={colors.textMuted} />
            </Pressable>
          ))}
        </View>
      </Screen>
    );
  }

  return (
    <Screen scroll>
      <Header title="Models & providers" onBack={() => setActiveCategory(null)} />
      {error ? <View style={styles.errorWrap}><ErrorNotice message={error} onRetry={() => void load()} /></View> : null}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Providers</Text>
        <View style={styles.segmented}>
          {(["openai-compatible", "google-genai", "anthropic"] as ProviderType[]).map((type) => (
            <Pressable key={type} onPress={() => chooseType(type)} style={[styles.segment, providerType === type && styles.segmentActive]}>
              <Text style={[styles.segmentText, providerType === type && styles.segmentTextActive]}>
                {type === "openai-compatible" ? "OpenAI" : type === "google-genai" ? "Gemini" : "Anthropic"}
              </Text>
            </Pressable>
          ))}
        </View>
        <Field label="Display name" value={providerName} onChangeText={setProviderName} />
        <Field label="Base URL" value={baseUrl} onChangeText={setBaseUrl} autoCapitalize="none" keyboardType="url" />
        {providerType === "openai-compatible" ? (
          <>
            <Text style={styles.fieldLabel}>API mode</Text>
            <View style={styles.segmented}>
              {OPENAI_API_MODES.map((mode) => (
                <Pressable key={mode.id} onPress={() => setApiMode(mode.id)} style={[styles.segment, apiMode === mode.id && styles.segmentActive]}>
                  <Text style={[styles.segmentText, apiMode === mode.id && styles.segmentTextActive]}>{mode.label}</Text>
                </Pressable>
              ))}
            </View>
            <Text style={styles.fieldHint}>
              {OPENAI_API_MODES.find((mode) => mode.id === apiMode)?.hint}. Most relays only implement the old API; choosing wrongly returns a 404.
            </Text>
          </>
        ) : null}
        <Field label="API Key" value={apiKey} onChangeText={setApiKey} autoCapitalize="none" secureTextEntry />
        <Button label="Save provider" onPress={() => void addProvider()} disabled={!providerName.trim() || !baseUrl.trim() || !apiKey.trim()} loading={saving} />
      </View>

      {providers.map((provider) => (
        <View key={provider.id} style={styles.providerBlock}>
          <View style={styles.providerHeader}>
            <View style={styles.providerInfo}>
              <Text style={styles.providerName}>{provider.name}</Text>
              <Text style={styles.providerUrl} numberOfLines={1}>
                {provider.baseUrl}
                {provider.type === "openai-compatible"
                  ? ` · ${provider.apiMode === "responses" ? "Responses API" : "Chat Completions"}`
                  : ""}
              </Text>
            </View>
            <View style={styles.providerActions}>
              <Pressable
                accessibilityLabel="Fetch model list"
                disabled={fetchingProviderId !== null}
                onPress={() => void fetchRemoteModels(provider)}
                style={styles.fetchButton}
              >
                {fetchingProviderId === provider.id
                  ? <ActivityIndicator size="small" color={colors.primary} />
                  : <Ionicons name="cloud-download-outline" size={18} color={colors.primary} />}
                <Text style={styles.fetchButtonText}>Fetch models</Text>
              </Pressable>
              <Pressable accessibilityLabel="Edit provider" onPress={() => openProviderEdit(provider)} style={styles.iconButton}>
                <Ionicons name="create-outline" size={20} color={colors.text} />
              </Pressable>
              <Pressable accessibilityLabel="Delete provider" onPress={() => {
                Alert.alert("Delete provider", `Delete ${provider.name} and all its models?`, [
                  { text: "Cancel", style: "cancel" },
                  { text: "Delete", style: "destructive", onPress: () => void removeProvider(provider) },
                ]);
              }} style={styles.iconButton}><Ionicons name="trash-outline" size={20} color={colors.danger} /></Pressable>
            </View>
          </View>
          {(modelsByProvider.get(provider.id) ?? []).map((model) => (
            <View key={model.id} style={styles.modelRow}>
              <Pressable accessibilityLabel={`Set ${model.name} as the default model`} onPress={() => void selectModel(model)} style={styles.modelSelect}>
                <Ionicons name={activeModelId === model.id ? "radio-button-on" : "radio-button-off"} size={20} color={activeModelId === model.id ? colors.primary : colors.textMuted} />
                <View style={styles.modelText}>
                  <Text style={styles.modelName}>{model.name}</Text>
                  <Text style={styles.modelId}>{model.modelId} · temperature {model.temperature} · max output {model.maxTokens}</Text>
                </View>
              </Pressable>
              <Pressable accessibilityLabel={`Edit ${model.name}`} onPress={() => openModelEdit(model)} style={styles.modelIconAction}>
                <Ionicons name="options-outline" size={19} color={colors.textMuted} />
              </Pressable>
              <Pressable accessibilityLabel={`Delete ${model.name}`} onPress={() => confirmDeleteModel(model)} style={styles.modelIconAction}>
                <Ionicons name="trash-outline" size={19} color={colors.danger} />
              </Pressable>
            </View>
          ))}
        </View>
      ))}

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Add a model</Text>
        <View style={styles.providerChoices}>
          {providers.map((provider) => (
            <Pressable key={provider.id} onPress={() => setSelectedProviderId(provider.id)} style={[styles.choice, selectedProviderId === provider.id && styles.choiceActive]}>
              <Text style={[styles.choiceText, selectedProviderId === provider.id && styles.choiceTextActive]}>{provider.name}</Text>
            </Pressable>
          ))}
        </View>
        <Field label="Model name" value={modelName} onChangeText={setModelName} placeholder="Gemini 2.5 Pro" />
        <Field label="Model ID" value={modelId} onChangeText={setModelId} autoCapitalize="none" placeholder="gemini-2.5-pro" />
        <Field label="Temperature" value={temperature} onChangeText={setTemperature} keyboardType="decimal-pad" />
        <Field label="Max output tokens" value={maxTokens} onChangeText={setMaxTokens} keyboardType="number-pad" />
        <Text style={styles.fieldHint}>A single reply length, not a context window; for a 1M-context model keep {DEFAULT_MAX_OUTPUT_TOKENS} or set as needed, up to {MAX_CONFIGURED_OUTPUT_TOKENS}.</Text>
        <Button label="Add model" onPress={() => void addModel()} disabled={!selectedProviderId || !modelName.trim() || !modelId.trim()} loading={savingModel} />
      </View>

      <Modal
        visible={modelPickerProvider !== null}
        transparent
        animationType="slide"
        onRequestClose={() => setModelPickerProvider(null)}
      >
        <SheetBackdrop onPress={() => setModelPickerProvider(null)}>
          <View style={styles.modelSheet}>
            <View style={styles.sheetHeader}>
              <View style={styles.providerInfo}>
                <Text style={styles.sectionTitle}>Choose a model</Text>
                <Text style={styles.providerUrl}>
                  {modelFilter.trim()
                    ? `${filteredRemoteModels.length} / ${remoteModels.length} models`
                    : `${remoteModels.length} models available · tap one to add`}
                </Text>
              </View>
              <Pressable accessibilityLabel="Close model list" onPress={() => setModelPickerProvider(null)} style={styles.iconButton}>
                <Ionicons name="close" size={24} color={colors.textMuted} />
              </Pressable>
            </View>
            <View style={styles.modelFilterWrap}>
              <Field
                label="Find a model"
                value={modelFilter}
                onChangeText={setModelFilter}
                placeholder="Enter part of the name or model ID"
                autoCapitalize="none"
                autoCorrect={false}
              />
              <Text style={styles.fieldHint}>
                Tap one to add it to this provider; the sheet stays open so you can add several. Parameters come from the temperature and max output tokens in Add a model; to tweak one, tap the settings icon on the model row after adding.
              </Text>
            </View>
            <FlatList
              data={filteredRemoteModels}
              keyExtractor={(item) => item.id}
              style={styles.modelSheetScroll}
              keyboardShouldPersistTaps="handled"
              ListEmptyComponent={(
                <Text style={styles.modelFilterEmpty}>
                  {remoteModels.length ? `No model matches "${modelFilter.trim()}"` : "No model list fetched yet"}
                </Text>
              )}
              renderItem={({ item }) => {
                const added = addedRemoteModelIds.has(item.id);
                const adding = addingRemoteModelId === item.id;
                return (
                  <Pressable
                    disabled={added || adding}
                    onPress={() => void addRemoteModel(item)}
                    style={styles.remoteModelRow}
                  >
                    <View style={styles.modelText}>
                      <Text style={styles.modelName}>{item.name}</Text>
                      <Text style={styles.modelId}>{item.id}</Text>
                    </View>
                    {adding
                      ? <ActivityIndicator size="small" color={colors.primary} />
                      : added
                        ? <Text style={styles.addedTag}>Added</Text>
                        : <Ionicons name="add-circle-outline" size={22} color={colors.primary} />}
                  </Pressable>
                );
              }}
            />
          </View>
        </SheetBackdrop>
      </Modal>

      <Modal visible={editingProvider !== null} transparent animationType="slide" onRequestClose={() => setEditingProvider(null)}>
        <SheetBackdrop onPress={() => setEditingProvider(null)}>
          <View style={styles.modelSheet}>
            <View style={styles.sheetHeader}>
              <View style={styles.providerInfo}>
                <Text style={styles.sectionTitle}>Edit provider</Text>
                <Text style={styles.providerUrl}>
                  {editingProvider?.type === "openai-compatible" ? "OpenAI-compatible" : editingProvider?.type === "google-genai" ? "Google Gemini" : "Anthropic"}. The type cannot be changed; create another provider if you need a different type.
                </Text>
              </View>
              <Pressable accessibilityLabel="Close provider editor" onPress={() => setEditingProvider(null)} style={styles.iconButton}>
                <Ionicons name="close" size={24} color={colors.textMuted} />
              </Pressable>
            </View>
            <ScrollView style={styles.editSheetScroll} contentContainerStyle={styles.editSheetBody} keyboardShouldPersistTaps="handled">
              <Field label="Display name" value={editProviderName} onChangeText={setEditProviderName} />
              <Field label="Base URL" value={editProviderUrl} onChangeText={setEditProviderUrl} autoCapitalize="none" keyboardType="url" />
              {editingProvider?.type === "openai-compatible" ? (
                <>
                  <Text style={styles.fieldLabel}>API mode</Text>
                  <View style={styles.segmented}>
                    {OPENAI_API_MODES.map((mode) => (
                      <Pressable
                        key={mode.id}
                        onPress={() => setEditProviderApiMode(mode.id)}
                        style={[styles.segment, editProviderApiMode === mode.id && styles.segmentActive]}
                      >
                        <Text style={[styles.segmentText, editProviderApiMode === mode.id && styles.segmentTextActive]}>{mode.label}</Text>
                      </Pressable>
                    ))}
                  </View>
                  <Text style={styles.fieldHint}>
                    {OPENAI_API_MODES.find((mode) => mode.id === editProviderApiMode)?.hint}. Most relays only implement the old API; choosing wrongly returns a 404.
                  </Text>
                </>
              ) : null}
              <Field label="API key (leave blank to keep the current one)" value={editProviderKey} onChangeText={setEditProviderKey} autoCapitalize="none" secureTextEntry placeholder="Leave blank to keep unchanged" />
              <Button label="Save changes" onPress={() => void saveProviderEdit()} disabled={!editProviderName.trim() || !editProviderUrl.trim()} loading={savingProviderEdit} />
            </ScrollView>
          </View>
        </SheetBackdrop>
      </Modal>

      <Modal visible={editingModel !== null} transparent animationType="slide" onRequestClose={() => setEditingModel(null)}>
        <SheetBackdrop onPress={() => setEditingModel(null)}>
          <View style={styles.modelSheet}>
            <View style={styles.sheetHeader}>
              <View style={styles.providerInfo}>
                <Text style={styles.sectionTitle}>Edit model</Text>
                <Text style={styles.providerUrl} numberOfLines={1}>{editingModel?.modelId}</Text>
              </View>
              <Pressable accessibilityLabel="Close model editor" onPress={() => setEditingModel(null)} style={styles.iconButton}>
                <Ionicons name="close" size={24} color={colors.textMuted} />
              </Pressable>
            </View>
            <ScrollView style={styles.editSheetScroll} contentContainerStyle={styles.editSheetBody} keyboardShouldPersistTaps="handled">
              <Field label="Model name" value={editModelName} onChangeText={setEditModelName} />
              <Field label="Temperature" value={editModelTemperature} onChangeText={setEditModelTemperature} keyboardType="decimal-pad" />
              <Field label="Max output tokens" value={editModelMaxTokens} onChangeText={setEditModelMaxTokens} keyboardType="number-pad" />
              <Text style={styles.fieldHint}>The model ID cannot be changed; this is a single-reply length limit, not a context window, up to {MAX_CONFIGURED_OUTPUT_TOKENS}.</Text>
              <Button label="Save changes" onPress={() => void saveModelEdit()} disabled={!editModelName.trim()} loading={savingModelEdit} />
            </ScrollView>
          </View>
        </SheetBackdrop>
      </Modal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  categoryList: { paddingVertical: spacing.sm },
  categoryRow: { minHeight: 58, flexDirection: "row", alignItems: "center", gap: spacing.md, paddingHorizontal: spacing.lg, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  categoryRowPressed: { backgroundColor: colors.surfaceMuted },
  categoryIcon: { width: 36, height: 36, alignItems: "center", justifyContent: "center", borderRadius: radius.sm, backgroundColor: "#E6F3EF" },
  categoryLabel: { flex: 1, color: colors.text, fontSize: 16, fontWeight: "600" },
  section: { padding: spacing.lg, gap: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  errorWrap: { paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  sectionTitle: { color: colors.text, fontSize: 18, fontWeight: "700" },
  segmented: { flexDirection: "row", padding: 3, borderRadius: radius.md, backgroundColor: colors.surfaceMuted },
  segment: { flex: 1, minHeight: 38, alignItems: "center", justifyContent: "center", borderRadius: radius.sm },
  segmentActive: { backgroundColor: colors.surface },
  segmentText: { color: colors.textMuted, fontSize: 13, fontWeight: "600" },
  segmentTextActive: { color: colors.primary },
  providerBlock: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  providerHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  providerActions: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  providerInfo: { flex: 1, minWidth: 0, marginRight: spacing.sm },
  providerName: { color: colors.text, fontSize: 16, fontWeight: "700" },
  providerUrl: { color: colors.textMuted, fontSize: 12, marginTop: 3 },
  iconButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  fetchButton: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: spacing.xs, paddingHorizontal: spacing.sm },
  fetchButtonText: { color: colors.primary, fontSize: 13, fontWeight: "700" },
  modelRow: { flexDirection: "row", alignItems: "center", gap: spacing.xs, paddingVertical: spacing.sm },
  modelSelect: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: spacing.md, paddingVertical: spacing.xs },
  modelIconAction: { width: 40, height: 44, alignItems: "center", justifyContent: "center" },
  addedTag: { color: colors.textMuted, fontSize: 12, fontWeight: "700" },
  fieldLabel: { color: colors.text, fontSize: 13, fontWeight: "600", marginBottom: -spacing.sm },
  editSheetBody: { gap: spacing.md, padding: spacing.lg, paddingBottom: spacing.xxl },
  modelText: { flex: 1 },
  modelName: { color: colors.text, fontSize: 15, fontWeight: "600" },
  modelId: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
  fieldHint: { color: colors.textMuted, fontSize: 12, lineHeight: 18, marginTop: -spacing.sm },
  providerChoices: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  choice: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md },
  choiceActive: { borderColor: colors.primary, backgroundColor: "#E6F3EF" },
  choiceText: { color: colors.textMuted, fontSize: 13 },
  choiceTextActive: { color: colors.primary, fontWeight: "700" },
  // 父层只有 maxHeight，ScrollView/FlatList 默认不收缩会把超出部分顶出可视区且滚不动，必须允许它收缩。
  modelSheetScroll: { flexShrink: 1 },
  editSheetScroll: { flexShrink: 1 },
  modelSheet: { maxHeight: "78%", paddingBottom: spacing.lg, borderTopLeftRadius: radius.md, borderTopRightRadius: radius.md, backgroundColor: colors.background },
  modelFilterWrap: { paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  modelFilterEmpty: { padding: spacing.lg, color: colors.textMuted, fontSize: 14, lineHeight: 20 },
  sheetHeader: { minHeight: 64, flexDirection: "row", alignItems: "center", paddingHorizontal: spacing.lg, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  remoteModelRow: { minHeight: 62, flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.lg, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
});

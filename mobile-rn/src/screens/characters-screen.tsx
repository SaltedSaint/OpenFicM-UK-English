import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { Ionicons } from "@expo/vector-icons";
import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import { KeyboardAwareScrollView, KeyboardAvoidingView } from "react-native-keyboard-controller";

import { Button, EmptyState, ErrorNotice, Field, Header, Screen } from "@/components/ui";
import { deleteCharacter, getProject, listCharacters, saveCharacter } from "@/data/repositories";
import { exportCharacters, type LibraryExportFormat } from "@/lib/export";
import type { RootStackParamList } from "@/navigation/types";
import { useAppStore } from "@/store/app-store";
import { colors, radius, spacing } from "@/theme";
import type { Character, Project } from "@/types";

export function CharactersScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const projectId = useAppStore((state) => state.currentProjectId);
  const [project, setProject] = useState<Project | null>(null);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editorVisible, setEditorVisible] = useState(false);
  const [editing, setEditing] = useState<Character | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isFavorited, setIsFavorited] = useState(false);

  const load = useCallback(async () => {
    if (!projectId) {
      setProject(null);
      setCharacters([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [nextProject, nextCharacters] = await Promise.all([getProject(projectId), listCharacters(projectId, query)]);
      if (!nextProject) throw new Error("Project not found");
      setProject(nextProject);
      setCharacters(nextCharacters);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [projectId, query]);

  useFocusEffect(useCallback(() => {
    void load();
  }, [load]));

  const openEditor = (character?: Character) => {
    setEditing(character ?? null);
    setName(character?.name ?? "");
    setDescription(character?.description ?? "");
    setIsFavorited(character?.isFavorited ?? false);
    setEditorVisible(true);
  };

  const submit = async () => {
    if (!projectId || !name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await saveCharacter({
        id: editing?.id,
        projectId,
        name,
        description,
        isFavorited,
      });
      setCharacters((current) => {
        const withoutSaved = current.filter((item) => item.id !== saved.id);
        return [saved, ...withoutSaved];
      });
      setEditorVisible(false);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  };

  const remove = (character: Character) => {
    Alert.alert("Delete character", `Delete "${character.name}"?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          void deleteCharacter(character.id)
            .then(() => setCharacters((current) => current.filter((item) => item.id !== character.id)))
            .catch((deleteError) => setError(deleteError instanceof Error ? deleteError.message : String(deleteError)));
        },
      },
    ]);
  };

  const runExport = async (items: Character[], format: LibraryExportFormat): Promise<void> => {
    if (!project || exporting) return;
    setExporting(true);
    setError(null);
    try {
      await exportCharacters(project, items, format);
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : String(exportError));
    } finally {
      setExporting(false);
    }
  };

  const chooseExport = (items: Character[], title: string) => {
    Alert.alert(title, "Choose an export format", [
      { text: "Cancel", style: "cancel" },
      { text: "JSON", onPress: () => void runExport(items, "json") },
      { text: "Markdown", onPress: () => void runExport(items, "markdown") },
    ]);
  };

  const exportAll = async (format: LibraryExportFormat): Promise<void> => {
    if (!projectId) return;
    setError(null);
    try {
      await runExport(await listCharacters(projectId), format);
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : String(exportError));
    }
  };

  const chooseBulkExport = () => {
    if (!projectId || !project || exporting) return;
    Alert.alert("Export all characters", "Choose an export format", [
      { text: "Cancel", style: "cancel" },
      { text: "JSON", onPress: () => void exportAll("json") },
      { text: "Markdown", onPress: () => void exportAll("markdown") },
    ]);
  };

  if (!projectId) return <Screen><Header title="Characters" onBack={() => navigation.goBack()} /><EmptyState title="Open a project from the shelf first" /></Screen>;

  return (
    <Screen>
      <Header
        title="Characters"
        onBack={() => navigation.goBack()}
        action={(
          <View style={styles.headerActions}>
            <Pressable accessibilityLabel="Export all characters" disabled={exporting} onPress={chooseBulkExport} style={styles.iconButton}>
              {exporting ? <ActivityIndicator size="small" color={colors.primary} /> : <Ionicons name="download-outline" size={22} color={colors.primary} />}
            </Pressable>
            <Pressable accessibilityLabel="New character" onPress={() => openEditor()} style={styles.iconButton}><Ionicons name="add" size={26} color={colors.primary} /></Pressable>
          </View>
        )}
      />
      <View style={styles.searchWrap}>
        <Field label="Search characters" value={query} onChangeText={setQuery} placeholder="Search by name or profile" returnKeyType="search" />
      </View>
      {error ? <View style={styles.errorWrap}><ErrorNotice message={error} onRetry={() => void load()} /></View> : null}
      <FlatList
        data={characters}
        keyExtractor={(item) => item.id}
        contentContainerStyle={characters.length ? styles.list : styles.emptyList}
        ListEmptyComponent={loading ? <ActivityIndicator color={colors.primary} /> : <EmptyState title="No characters yet" action={<Button label="New character" onPress={() => openEditor()} />} />}
        renderItem={({ item }) => (
          <Pressable onPress={() => openEditor(item)} style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
            <View style={styles.avatar}><Text style={styles.avatarText}>{item.name.slice(0, 1)}</Text></View>
            <View style={styles.rowText}>
              <View style={styles.nameLine}>
                <Text numberOfLines={1} style={styles.name}>{item.name}</Text>
                {item.isFavorited ? <Ionicons name="star" size={16} color={colors.accent} /> : null}
              </View>
              <Text numberOfLines={3} style={styles.description}>{item.description || "No character profile yet"}</Text>
            </View>
            <View style={styles.rowActions}>
              <Pressable accessibilityLabel={`Export character ${item.name}`} disabled={exporting} onPress={(event) => { event.stopPropagation(); chooseExport([item], `Export character "${item.name}"`); }} hitSlop={8} style={styles.iconButton}>
                <Ionicons name="download-outline" size={19} color={colors.textMuted} />
              </Pressable>
              <Pressable accessibilityLabel="Delete character" onPress={(event) => { event.stopPropagation(); remove(item); }} hitSlop={8} style={styles.iconButton}>
                <Ionicons name="trash-outline" size={19} color={colors.textMuted} />
              </Pressable>
            </View>
          </Pressable>
        )}
      />

      <Modal visible={editorVisible} transparent animationType="slide" onRequestClose={() => setEditorVisible(false)}>
        <KeyboardAvoidingView style={styles.modalBackdrop} behavior="height" automaticOffset>
          <View style={styles.modalBody}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>{editing ? "Edit character" : "New character"}</Text>
              <Pressable accessibilityLabel="Close character editor" onPress={() => setEditorVisible(false)} style={styles.iconButton}>
                <Ionicons name="close" size={24} color={colors.textMuted} />
              </Pressable>
            </View>
            <KeyboardAwareScrollView
              style={styles.formScroll}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
              bottomOffset={spacing.lg}
              extraKeyboardSpace={spacing.md}
              contentContainerStyle={styles.form}
            >
              <Field label="Character name" value={name} onChangeText={setName} autoFocus={!editing} />
              <Field label="Character profile" value={description} onChangeText={setDescription} multiline textAlignVertical="top" style={styles.descriptionInput} placeholder="Appearance, personality, background, relationships and writing notes" />
              <View style={styles.switchRow}>
                <Text style={styles.switchLabel}>Favourite character</Text>
                <Switch value={isFavorited} onValueChange={setIsFavorited} trackColor={{ false: colors.border, true: colors.primary }} />
              </View>
              <View style={styles.modalActions}>
                <Button label="Cancel" variant="secondary" onPress={() => setEditorVisible(false)} />
                <Button label="Save" onPress={() => void submit()} disabled={!name.trim()} loading={saving} />
              </View>
            </KeyboardAwareScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  headerActions: { flexDirection: "row", alignItems: "center" },
  iconButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  searchWrap: { padding: spacing.lg, paddingBottom: spacing.sm },
  errorWrap: { paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
  list: { paddingVertical: spacing.sm },
  emptyList: { flexGrow: 1 },
  row: { minHeight: 98, flexDirection: "row", alignItems: "center", gap: spacing.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  rowPressed: { backgroundColor: colors.surfaceMuted },
  avatar: { width: 52, height: 52, borderRadius: 26, alignItems: "center", justifyContent: "center", backgroundColor: colors.primary },
  avatarText: { color: "#FFFFFF", fontSize: 22, fontWeight: "700" },
  rowText: { flex: 1, minWidth: 0, gap: spacing.xs },
  rowActions: { flexDirection: "row", alignItems: "center" },
  nameLine: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  name: { flex: 1, color: colors.text, fontSize: 16, fontWeight: "700" },
  description: { color: colors.textMuted, fontSize: 13, lineHeight: 19 },
  modalBackdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: colors.overlay },
  modalBody: { maxHeight: "88%", padding: spacing.lg, borderTopLeftRadius: radius.md, borderTopRightRadius: radius.md, backgroundColor: colors.background },
  modalHeader: { minHeight: 52, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  modalTitle: { color: colors.text, fontSize: 20, fontWeight: "700" },
  // 父层只有 maxHeight，ScrollView 默认不收缩会把超出部分顶出可视区且滚不动，必须允许它收缩。
  formScroll: { flexShrink: 1 },
  form: { gap: spacing.lg, paddingVertical: spacing.sm },
  descriptionInput: { minHeight: 180 },
  switchRow: { minHeight: 50, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  switchLabel: { color: colors.text, fontSize: 15, fontWeight: "600" },
  modalActions: { flexDirection: "row", justifyContent: "flex-end", gap: spacing.sm },
});

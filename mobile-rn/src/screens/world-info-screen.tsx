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
import {
  deleteWorldInfoEntry,
  getOrCreateWorldInfo,
  getProject,
  listWorldInfoEntries,
  saveWorldInfo,
  saveWorldInfoEntry,
} from "@/data/repositories";
import { exportWorldInfo, type LibraryExportFormat } from "@/lib/export";
import type { RootStackParamList } from "@/navigation/types";
import { useAppStore } from "@/store/app-store";
import { colors, radius, spacing } from "@/theme";
import type { Project, WorldInfo, WorldInfoEntry } from "@/types";

export function WorldInfoScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const projectId = useAppStore((state) => state.currentProjectId);
  const [project, setProject] = useState<Project | null>(null);
  const [worldInfo, setWorldInfo] = useState<WorldInfo | null>(null);
  const [entries, setEntries] = useState<WorldInfoEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bookName, setBookName] = useState("");
  const [bookDescription, setBookDescription] = useState("");
  const [entryEditorVisible, setEntryEditorVisible] = useState(false);
  const [editingEntry, setEditingEntry] = useState<WorldInfoEntry | null>(null);
  const [entryName, setEntryName] = useState("");
  const [entryContent, setEntryContent] = useState("");
  const [entryEnabled, setEntryEnabled] = useState(true);

  const load = useCallback(async () => {
    if (!projectId) {
      setProject(null);
      setWorldInfo(null);
      setEntries([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [nextProject, nextWorldInfo] = await Promise.all([getProject(projectId), getOrCreateWorldInfo(projectId)]);
      if (!nextProject) throw new Error("Project not found");
      setProject(nextProject);
      setWorldInfo(nextWorldInfo);
      setBookName(nextWorldInfo.name);
      setBookDescription(nextWorldInfo.description);
      setEntries(await listWorldInfoEntries(nextWorldInfo.id));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useFocusEffect(useCallback(() => {
    void load();
  }, [load]));

  const saveBook = async () => {
    if (!worldInfo || !bookName.trim()) return;
    setSaving(true);
    setError(null);
    try {
      setWorldInfo(await saveWorldInfo({ id: worldInfo.id, projectId: worldInfo.projectId, name: bookName, description: bookDescription }));
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  };

  const openEntryEditor = (entry?: WorldInfoEntry) => {
    setEditingEntry(entry ?? null);
    setEntryName(entry?.name ?? "");
    setEntryContent(entry?.content ?? "");
    setEntryEnabled(entry?.isEnabled ?? true);
    setEntryEditorVisible(true);
  };

  const saveEntry = async () => {
    if (!worldInfo || !entryName.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await saveWorldInfoEntry({
        id: editingEntry?.id,
        worldInfoId: worldInfo.id,
        name: entryName,
        content: entryContent,
        isEnabled: entryEnabled,
      });
      setEntries((current) => [saved, ...current.filter((item) => item.id !== saved.id)].sort((left, right) => left.order - right.order));
      setEntryEditorVisible(false);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  };

  const removeEntry = (entry: WorldInfoEntry) => {
    Alert.alert("Delete world book entry", `Delete "${entry.name}"?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          void deleteWorldInfoEntry(entry.id)
            .then(() => setEntries((current) => current.filter((item) => item.id !== entry.id)))
            .catch((deleteError) => setError(deleteError instanceof Error ? deleteError.message : String(deleteError)));
        },
      },
    ]);
  };

  const runExport = async (items: WorldInfoEntry[], format: LibraryExportFormat) => {
    if (!project || !worldInfo || exporting) return;
    setExporting(true);
    setError(null);
    try {
      await exportWorldInfo(project, worldInfo, items, format);
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : String(exportError));
    } finally {
      setExporting(false);
    }
  };

  const chooseExport = (items: WorldInfoEntry[], title: string) => {
    Alert.alert(title, "Choose an export format", [
      { text: "Cancel", style: "cancel" },
      { text: "JSON", onPress: () => void runExport(items, "json") },
      { text: "Markdown", onPress: () => void runExport(items, "markdown") },
    ]);
  };

  if (!projectId) return <Screen><Header title="World book" onBack={() => navigation.goBack()} /><EmptyState title="Open a project from the shelf first" /></Screen>;

  return (
    <Screen>
      <Header
        title="World book"
        onBack={() => navigation.goBack()}
        action={(
          <View style={styles.headerActions}>
            <Pressable accessibilityLabel="Export the whole world book" disabled={exporting || !entries.length} onPress={() => chooseExport(entries, "Export all world book entries")} style={styles.iconButton}>
              {exporting ? <ActivityIndicator size="small" color={colors.primary} /> : <Ionicons name="download-outline" size={22} color={entries.length ? colors.primary : colors.textMuted} />}
            </Pressable>
            <Pressable accessibilityLabel="New world book entry" onPress={() => openEntryEditor()} style={styles.iconButton}><Ionicons name="add" size={26} color={colors.primary} /></Pressable>
          </View>
        )}
      />
      {error ? <View style={styles.errorWrap}><ErrorNotice message={error} onRetry={() => void load()} /></View> : null}
      {loading || !worldInfo ? <View style={styles.loading}><ActivityIndicator color={colors.primary} /></View> : (
        <KeyboardAvoidingView style={styles.flex} behavior="height" automaticOffset>
          <FlatList
            data={entries}
            keyExtractor={(item) => item.id}
            style={styles.flex}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            contentContainerStyle={entries.length ? styles.list : styles.emptyList}
            ListHeaderComponent={
              <View style={styles.bookForm}>
                <Field label="World book name" value={bookName} onChangeText={setBookName} />
                <Field label="Description" value={bookDescription} onChangeText={setBookDescription} multiline textAlignVertical="top" style={styles.bookDescription} />
                <Button label="Save world book info" onPress={() => void saveBook()} disabled={!bookName.trim()} loading={saving} />
                <Text style={styles.sectionTitle}>Entries · {entries.length}</Text>
              </View>
            }
            ListEmptyComponent={<EmptyState title="No world book entries yet" action={<Button label="New entry" onPress={() => openEntryEditor()} />} />}
            renderItem={({ item }) => (
              <Pressable onPress={() => openEntryEditor(item)} style={({ pressed }) => [styles.entryRow, pressed && styles.rowPressed]}>
                <View style={styles.entryNumber}><Text style={styles.entryNumberText}>{item.uid}</Text></View>
                <View style={styles.entryText}>
                  <View style={styles.entryTitleLine}>
                    <Text numberOfLines={1} style={styles.entryName}>{item.name}</Text>
                    <Switch value={item.isEnabled} onValueChange={(value) => {
                      void saveWorldInfoEntry({ ...item, worldInfoId: item.worldInfoId, isEnabled: value })
                        .then((saved) => setEntries((current) => current.map((entry) => entry.id === saved.id ? saved : entry)))
                        .catch((toggleError) => setError(toggleError instanceof Error ? toggleError.message : String(toggleError)));
                    }} trackColor={{ false: colors.border, true: colors.primary }} />
                  </View>
                  <Text numberOfLines={2} style={styles.entryContent}>{item.content || "No content yet"}</Text>
                </View>
                <View style={styles.rowActions}>
                  <Pressable accessibilityLabel={`Export world book entry ${item.name}`} disabled={exporting} onPress={(event) => { event.stopPropagation(); chooseExport([item], `Export entry "${item.name}"`); }} hitSlop={8} style={styles.iconButton}>
                    <Ionicons name="download-outline" size={19} color={colors.textMuted} />
                  </Pressable>
                  <Pressable accessibilityLabel="Delete world book entry" onPress={(event) => { event.stopPropagation(); removeEntry(item); }} hitSlop={8} style={styles.iconButton}>
                    <Ionicons name="trash-outline" size={19} color={colors.textMuted} />
                  </Pressable>
                </View>
              </Pressable>
            )}
          />
        </KeyboardAvoidingView>
      )}

      <Modal visible={entryEditorVisible} transparent animationType="slide" onRequestClose={() => setEntryEditorVisible(false)}>
        <KeyboardAvoidingView style={styles.modalBackdrop} behavior="height" automaticOffset>
          <View style={styles.modalBody}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>{editingEntry ? "Edit entry" : "New entry"}</Text>
              <Pressable accessibilityLabel="Close world book editor" onPress={() => setEntryEditorVisible(false)} style={styles.iconButton}>
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
              <Field label="Entry name" value={entryName} onChangeText={setEntryName} autoFocus={!editingEntry} />
              <Field label="Entry content" value={entryContent} onChangeText={setEntryContent} multiline textAlignVertical="top" style={styles.entryInput} placeholder="Character relationships, location rules, era background, etc." />
              <View style={styles.switchRow}>
                <Text style={styles.switchLabel}>Enable entry</Text>
                <Switch value={entryEnabled} onValueChange={setEntryEnabled} trackColor={{ false: colors.border, true: colors.primary }} />
              </View>
              <View style={styles.modalActions}>
                <Button label="Cancel" variant="secondary" onPress={() => setEntryEditorVisible(false)} />
                <Button label="Save" onPress={() => void saveEntry()} disabled={!entryName.trim()} loading={saving} />
              </View>
            </KeyboardAwareScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  headerActions: { flexDirection: "row", alignItems: "center" },
  iconButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  errorWrap: { paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  loading: { flex: 1, alignItems: "center", justifyContent: "center" },
  list: { paddingBottom: spacing.lg },
  emptyList: { flexGrow: 1 },
  bookForm: { gap: spacing.md, padding: spacing.lg, paddingBottom: spacing.xl, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  bookDescription: { minHeight: 90 },
  sectionTitle: { color: colors.text, fontSize: 17, fontWeight: "700", marginTop: spacing.sm },
  entryRow: { minHeight: 90, flexDirection: "row", alignItems: "center", gap: spacing.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  rowPressed: { backgroundColor: colors.surfaceMuted },
  entryNumber: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center", backgroundColor: colors.surfaceMuted },
  entryNumberText: { color: colors.primary, fontSize: 13, fontWeight: "700" },
  entryText: { flex: 1, minWidth: 0, gap: spacing.xs },
  rowActions: { flexDirection: "row", alignItems: "center" },
  entryTitleLine: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  entryName: { flex: 1, color: colors.text, fontSize: 15, fontWeight: "700" },
  entryContent: { color: colors.textMuted, fontSize: 13, lineHeight: 19 },
  modalBackdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: colors.overlay },
  modalBody: { maxHeight: "88%", padding: spacing.lg, borderTopLeftRadius: radius.md, borderTopRightRadius: radius.md, backgroundColor: colors.background },
  modalHeader: { minHeight: 52, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  modalTitle: { color: colors.text, fontSize: 20, fontWeight: "700" },
  // 父层只有 maxHeight，ScrollView 默认不收缩会把超出部分顶出可视区且滚不动，必须允许它收缩。
  formScroll: { flexShrink: 1 },
  form: { gap: spacing.lg, paddingVertical: spacing.sm },
  entryInput: { minHeight: 190 },
  switchRow: { minHeight: 50, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  switchLabel: { color: colors.text, fontSize: 15, fontWeight: "600" },
  modalActions: { flexDirection: "row", justifyContent: "flex-end", gap: spacing.sm },
});

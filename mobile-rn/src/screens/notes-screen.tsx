import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { Button, EmptyState, ErrorNotice, Field, Header, Screen, SheetBackdrop } from "@/components/ui";
import { listChapters, listVolumes } from "@/data/repositories";
import {
  createNote,
  deleteNote,
  listNotes,
  moveNote,
  noteScope,
  updateNote,
} from "@/data/note-repositories";
import type { RootStackParamList } from "@/navigation/types";
import { useAppStore } from "@/store/app-store";
import { colors, radius, spacing } from "@/theme";
import type { Chapter, Note, NoteScope, Volume } from "@/types";

type Group = {
  key: string;
  label: string;
  scope: NoteScope;
  volumeId: string | null;
  chapterId: string | null;
  notes: Note[];
};

const SCOPE_LABEL: Record<NoteScope, string> = {
  project: "Book",
  volume: "Volume",
  chapter: "Chapter",
};

export function NotesScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const projectId = useAppStore((state) => state.currentProjectId);
  const [notes, setNotes] = useState<Note[]>([]);
  const [volumes, setVolumes] = useState<Volume[]>([]);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Note | null>(null);
  const [creatingIn, setCreatingIn] = useState<Group | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [movingNote, setMovingNote] = useState<Note | null>(null);

  const load = useCallback(async () => {
    if (!projectId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [nextNotes, nextVolumes, nextChapters] = await Promise.all([
        listNotes(projectId),
        listVolumes(projectId),
        listChapters(projectId),
      ]);
      setNotes(nextNotes);
      setVolumes(nextVolumes);
      setChapters(nextChapters);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useFocusEffect(useCallback(() => {
    void load();
  }, [load]));

  // 三层分组：整书在最前，然后按卷顺序，每卷后面跟它的章。空分组也保留，方便直接在该层级新建。
  const groups = useMemo<Group[]>(() => {
    const chaptersByVolume = new Map<string, Chapter[]>();
    for (const chapter of chapters) {
      const list = chaptersByVolume.get(chapter.volumeId) ?? [];
      list.push(chapter);
      chaptersByVolume.set(chapter.volumeId, list);
    }
    const output: Group[] = [{
      key: "project",
      label: "Book",
      scope: "project",
      volumeId: null,
      chapterId: null,
      notes: notes.filter((note) => noteScope(note) === "project"),
    }];
    for (const volume of volumes) {
      output.push({
        key: `volume:${volume.id}`,
        label: volume.title,
        scope: "volume",
        volumeId: volume.id,
        chapterId: null,
        notes: notes.filter((note) => note.volumeId === volume.id && !note.chapterId),
      });
      for (const chapter of chaptersByVolume.get(volume.id) ?? []) {
        const chapterNotes = notes.filter((note) => note.chapterId === chapter.id);
        if (!chapterNotes.length) continue;
        output.push({
          key: `chapter:${chapter.id}`,
          label: `　${chapter.title}`,
          scope: "chapter",
          volumeId: volume.id,
          chapterId: chapter.id,
          notes: chapterNotes,
        });
      }
    }
    return output;
  }, [notes, volumes, chapters]);

  const totalNotes = notes.length;

  const openCreate = (group: Group) => {
    setCreatingIn(group);
    setEditing(null);
    setTitle("");
    setContent("");
  };

  const openEdit = (note: Note) => {
    setEditing(note);
    setCreatingIn(null);
    setTitle(note.title);
    setContent(note.content);
  };

  const closeEditor = () => {
    if (busy) return;
    setEditing(null);
    setCreatingIn(null);
  };

  const save = async () => {
    if (!projectId || !title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      if (editing) {
        await updateNote({ id: editing.id, title, content });
      } else if (creatingIn) {
        await createNote({
          projectId,
          title,
          content,
          volumeId: creatingIn.volumeId,
          chapterId: creatingIn.chapterId,
        });
      }
      closeEditor();
      await load();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = (note: Note) => {
    Alert.alert("Delete note", `Delete "${note.title}"?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          setBusy(true);
          void deleteNote(note.id)
            .then(async () => {
              closeEditor();
              await load();
            })
            .catch((deleteError) => setError(deleteError instanceof Error ? deleteError.message : String(deleteError)))
            .finally(() => setBusy(false));
        },
      },
    ]);
  };

  const applyMove = async (target: Group) => {
    if (!movingNote) return;
    setBusy(true);
    setError(null);
    try {
      await moveNote(movingNote.id, { volumeId: target.volumeId, chapterId: target.chapterId });
      setMovingNote(null);
      await load();
    } catch (moveError) {
      setError(moveError instanceof Error ? moveError.message : String(moveError));
    } finally {
      setBusy(false);
    }
  };

  // 移动目标包含所有卷和所有章，不只是已有笔记的那些分组。
  const moveTargets = useMemo<Group[]>(() => {
    const output: Group[] = [{
      key: "project", label: "Book", scope: "project", volumeId: null, chapterId: null, notes: [],
    }];
    for (const volume of volumes) {
      output.push({
        key: `volume:${volume.id}`, label: volume.title, scope: "volume",
        volumeId: volume.id, chapterId: null, notes: [],
      });
      for (const chapter of chapters.filter((item) => item.volumeId === volume.id)) {
        output.push({
          key: `chapter:${chapter.id}`, label: `　${chapter.title}`, scope: "chapter",
          volumeId: volume.id, chapterId: chapter.id, notes: [],
        });
      }
    }
    return output;
  }, [volumes, chapters]);

  if (!projectId) {
    return (
      <Screen>
        <Header title="Notes" onBack={() => navigation.goBack()} />
        <EmptyState title="Open a project from the shelf first" />
      </Screen>
    );
  }

  if (loading) {
    return (
      <Screen>
        <Header title="Notes" onBack={() => navigation.goBack()} />
        <View style={styles.loading}><ActivityIndicator color={colors.primary} /></View>
      </Screen>
    );
  }

  return (
    <Screen>
      <Header title="Notes" onBack={() => navigation.goBack()} />
      {error ? <View style={styles.errorWrap}><ErrorNotice message={error} onRetry={() => void load()} /></View> : null}
      <FlatList
        data={groups}
        keyExtractor={(item) => item.key}
        contentContainerStyle={styles.list}
        ListHeaderComponent={(
          <View style={styles.intro}>
            <View style={styles.introIcon}><Ionicons name="reader-outline" size={24} color={colors.primary} /></View>
            <View style={styles.introCopy}>
              <Text style={styles.introTitle}>Outlines and plot planning</Text>
              <Text style={styles.introText}>
                Notes are scoped to book, volume or chapter, {totalNotes} in total. Put content that has
                not happened in the prose here — not in the world book, which is treated as established canon.
              </Text>
            </View>
          </View>
        )}
        renderItem={({ item }) => (
          <View style={styles.group}>
            <View style={styles.groupHeader}>
              <Text style={styles.groupLabel} numberOfLines={1}>{item.label}</Text>
              <Text style={styles.groupScope}>{SCOPE_LABEL[item.scope]}</Text>
              <Pressable accessibilityLabel={`New note in ${item.label}`} onPress={() => openCreate(item)} style={styles.groupAdd}>
                <Ionicons name="add" size={20} color={colors.primary} />
              </Pressable>
            </View>
            {item.notes.length ? item.notes.map((note) => (
              <Pressable key={note.id} onPress={() => openEdit(note)} style={({ pressed }) => [styles.noteRow, pressed && styles.noteRowPressed]}>
                <View style={styles.noteCopy}>
                  <Text style={styles.noteTitle} numberOfLines={1}>{note.title}</Text>
                  <Text style={styles.noteMeta} numberOfLines={2}>
                    {note.content.trim().slice(0, 90).replace(/\s+/g, " ") || "(empty note)"}
                  </Text>
                </View>
                <Pressable accessibilityLabel="Move note" onPress={() => setMovingNote(note)} style={styles.noteAction}>
                  <Ionicons name="swap-vertical-outline" size={18} color={colors.textMuted} />
                </Pressable>
              </Pressable>
            )) : <Text style={styles.groupEmpty}>No notes yet</Text>}
          </View>
        )}
      />

      <Modal visible={Boolean(editing || creatingIn)} transparent animationType="slide" onRequestClose={closeEditor}>
        <SheetBackdrop onPress={closeEditor}>
          <View style={styles.sheet}>
            <View style={styles.sheetHeader}>
              <View style={styles.sheetTitleWrap}>
                <Text style={styles.sheetTitle}>{editing ? "Edit note" : "New note"}</Text>
                <Text style={styles.sheetMeta}>
                  {editing
                    ? SCOPE_LABEL[noteScope(editing)]
                    : `${SCOPE_LABEL[creatingIn?.scope ?? "project"]} · ${creatingIn?.label.trim()}`}
                </Text>
              </View>
              <Pressable accessibilityLabel="Close" onPress={closeEditor} style={styles.iconButton}>
                <Ionicons name="close" size={24} color={colors.textMuted} />
              </Pressable>
            </View>
            <ScrollView style={styles.sheetScroll} contentContainerStyle={styles.sheetContent} keyboardShouldPersistTaps="handled">
              <Field label="Title" value={title} onChangeText={setTitle} autoFocus={!editing} maxLength={200} />
              <Field label="Content" value={content} onChangeText={setContent} multiline style={styles.contentInput} maxLength={100000} />
              <View style={styles.inlineActions}>
                <Button label="Save" onPress={() => void save()} disabled={busy || !title.trim()} loading={busy} />
                {editing ? (
                  <Pressable accessibilityLabel="Delete note" onPress={() => confirmDelete(editing)} style={styles.secondaryIconAction}>
                    <Ionicons name="trash-outline" size={21} color={colors.danger} />
                  </Pressable>
                ) : null}
              </View>
            </ScrollView>
          </View>
        </SheetBackdrop>
      </Modal>

      <Modal visible={Boolean(movingNote)} transparent animationType="slide" onRequestClose={() => setMovingNote(null)}>
        <SheetBackdrop onPress={() => setMovingNote(null)}>
          <View style={styles.sheet}>
            <View style={styles.sheetHeader}>
              <View style={styles.sheetTitleWrap}>
                <Text style={styles.sheetTitle} numberOfLines={1}>Move "{movingNote?.title}"</Text>
                <Text style={styles.sheetMeta}>Choose the new scope</Text>
              </View>
              <Pressable accessibilityLabel="Close" onPress={() => setMovingNote(null)} style={styles.iconButton}>
                <Ionicons name="close" size={24} color={colors.textMuted} />
              </Pressable>
            </View>
            <ScrollView style={styles.sheetScroll} contentContainerStyle={styles.sheetContent}>
              {moveTargets.map((target) => {
                const current = movingNote
                  && (movingNote.chapterId ?? movingNote.volumeId ?? null) === (target.chapterId ?? target.volumeId ?? null);
                return (
                  <Pressable
                    key={target.key}
                    disabled={busy || Boolean(current)}
                    onPress={() => void applyMove(target)}
                    style={[styles.targetRow, current && styles.targetRowCurrent]}
                  >
                    <Text style={styles.targetScope}>{SCOPE_LABEL[target.scope]}</Text>
                    <Text style={styles.targetLabel} numberOfLines={1}>{target.label.trim()}</Text>
                    {current ? <Text style={styles.targetCurrentText}>Current</Text> : null}
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
        </SheetBackdrop>
      </Modal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  loading: { flex: 1, alignItems: "center", justifyContent: "center" },
  errorWrap: { padding: spacing.lg, paddingBottom: 0 },
  list: { padding: spacing.lg, paddingBottom: spacing.xxl },
  intro: { flexDirection: "row", gap: spacing.md, paddingBottom: spacing.lg },
  introIcon: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: radius.sm, backgroundColor: "#E6F3EF" },
  introCopy: { flex: 1, gap: spacing.xs },
  introTitle: { color: colors.text, fontSize: 17, fontWeight: "700" },
  introText: { color: colors.textMuted, fontSize: 13, lineHeight: 19 },
  group: { marginBottom: spacing.lg },
  groupHeader: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  groupLabel: { flex: 1, minWidth: 0, color: colors.text, fontSize: 15, fontWeight: "700" },
  groupScope: { color: colors.textMuted, fontSize: 12 },
  groupAdd: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  groupEmpty: { color: colors.textMuted, fontSize: 13, paddingVertical: spacing.md },
  noteRow: { minHeight: 64, flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingVertical: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  noteRowPressed: { backgroundColor: colors.surfaceMuted },
  noteCopy: { flex: 1, minWidth: 0, gap: 3 },
  noteTitle: { color: colors.text, fontSize: 15, fontWeight: "600" },
  noteMeta: { color: colors.textMuted, fontSize: 12, lineHeight: 17 },
  noteAction: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  iconButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  sheet: { maxHeight: "88%", borderTopLeftRadius: radius.md, borderTopRightRadius: radius.md, backgroundColor: colors.background },
  sheetScroll: { flexShrink: 1 },
  sheetHeader: { minHeight: 70, flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingLeft: spacing.lg, paddingRight: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  sheetTitleWrap: { flex: 1, minWidth: 0 },
  sheetTitle: { color: colors.text, fontSize: 19, fontWeight: "700" },
  sheetMeta: { marginTop: 3, color: colors.textMuted, fontSize: 12 },
  sheetContent: { gap: spacing.lg, padding: spacing.lg, paddingBottom: spacing.xxl },
  contentInput: { minHeight: 260 },
  inlineActions: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  secondaryIconAction: { width: 46, height: 46, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, backgroundColor: colors.surface },
  targetRow: { minHeight: 52, flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.md, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, backgroundColor: colors.surface },
  targetRowCurrent: { borderColor: colors.primary, backgroundColor: "#E6F3EF" },
  targetScope: { minWidth: 32, color: colors.textMuted, fontSize: 12 },
  targetLabel: { flex: 1, minWidth: 0, color: colors.text, fontSize: 14 },
  targetCurrentText: { color: colors.primary, fontSize: 12, fontWeight: "700" },
});

import { Ionicons } from "@expo/vector-icons";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  Modal,
  Pressable,
  ScrollView,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";

import { Button, EmptyState, ErrorNotice, Field, Header, Screen, SheetBackdrop } from "@/components/ui";
import { StyleProfilePickerSheet } from "@/components/style-profile-picker";
import { exportNovel, type ExportScope } from "@/lib/export";
import { styleProfileLabel } from "@/lib/style-label";
import { countNotesUnder, deleteNotesUnder } from "@/data/note-repositories";
import {
  createChapter,
  createVolume,
  deleteChapter,
  deleteVolume,
  getProject,
  getSetting,
  listChapters,
  listVolumes,
  renameChapter,
  renameVolume,
  saveChapter,
} from "@/data/repositories";
import {
  getPendingChapterStyleEvolution,
  markChapterStyleEvolved,
  recordLatestAuthorRevision,
} from "@/data/chapter-draft-repositories";
import {
  getActiveStyleProfile,
  setActiveStyleProfile,
} from "@/data/style-repositories";
import { resolveModelSelection } from "@/llm/selection";
import { evolveAuthorStyle } from "@/settings/lorn-style-plugin";
import { listStyleProfileOptions, type StyleProfileOption } from "@/style/profile-options";
import { useAppStore } from "@/store/app-store";
import { colors, radius, spacing } from "@/theme";
import type { Chapter, ChapterDraftSnapshot, Project, StyleProfile, Volume } from "@/types";

const AUTO_SAVE_DELAY_MS = 1_000;

type DraftState = {
  chapterId: string;
  title: string;
  content: string;
  dirty: boolean;
  version: number;
};

type DirectoryTarget =
  | { kind: "volume"; volume: Volume }
  | { kind: "chapter"; chapter: Chapter };

type NameDialog =
  | { kind: "create-volume" }
  | { kind: "rename-volume"; volume: Volume }
  | { kind: "create-chapter"; volume: Volume }
  | { kind: "rename-chapter"; chapter: Chapter };

export function WritingScreen() {
  const projectId = useAppStore((state) => state.currentProjectId);
  const currentChapterId = useAppStore((state) => state.currentChapterId);
  const setCurrentChapter = useAppStore((state) => state.setCurrentChapter);
  const refreshData = useAppStore((state) => state.refreshData);
  const revision = useAppStore((state) => state.dataRevision);
  const [project, setProject] = useState<Project | null>(null);
  const [volumes, setVolumes] = useState<Volume[]>([]);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoSaveDelay, setAutoSaveDelay] = useState(AUTO_SAVE_DELAY_MS);
  const [editorFontSize, setEditorFontSize] = useState(17);
  const [chapterPickerVisible, setChapterPickerVisible] = useState(false);
  const [directoryTarget, setDirectoryTarget] = useState<DirectoryTarget | null>(null);
  const [nameDialog, setNameDialog] = useState<NameDialog | null>(null);
  const [nameValue, setNameValue] = useState("");
  const [nameSaving, setNameSaving] = useState(false);
  const [exportPickerVisible, setExportPickerVisible] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [styleOptions, setStyleOptions] = useState<StyleProfileOption[]>([]);
  const [activeStyleProfile, setActiveStyleProfileState] = useState<StyleProfile | null>(null);
  const [stylePickerVisible, setStylePickerVisible] = useState(false);
  const [pendingEvolution, setPendingEvolution] = useState<ChapterDraftSnapshot | null>(null);
  const [evolvingStyle, setEvolvingStyle] = useState(false);
  const draftRef = useRef<DraftState>({ chapterId: "", title: "", content: "", dirty: false, version: 0 });
  const savingRef = useRef(false);
  const persistDraftRef = useRef<(force: boolean) => Promise<boolean>>(async () => true);

  useEffect(() => {
    void Promise.all([
      getSetting("general.autoSaveDelay"),
      getSetting("general.editorFontSize"),
    ]).then(([delayValue, fontValue]) => {
      const delay = Number(delayValue);
      const fontSize = Number(fontValue);
      if (Number.isInteger(delay) && delay >= 250 && delay <= 10_000) setAutoSaveDelay(delay);
      if (Number.isFinite(fontSize) && fontSize >= 14 && fontSize <= 28) setEditorFontSize(fontSize);
    }).catch((settingsError) => {
      setError(settingsError instanceof Error ? settingsError.message : String(settingsError));
    });
  }, []);

  const activeChapter = useMemo(
    () => chapters.find((chapter) => chapter.id === currentChapterId) ?? chapters[0] ?? null,
    [chapters, currentChapterId],
  );

  const activeVolume = useMemo(
    () => volumes.find((volume) => volume.id === activeChapter?.volumeId) ?? null,
    [activeChapter?.volumeId, volumes],
  );

  const directorySections = useMemo(() => {
    const grouped = new Map<string, Chapter[]>();
    for (const chapter of chapters) {
      const items = grouped.get(chapter.volumeId) ?? [];
      items.push(chapter);
      grouped.set(chapter.volumeId, items);
    }
    return volumes.map((volume) => ({ volume, data: grouped.get(volume.id) ?? [] }));
  }, [chapters, volumes]);

  useEffect(() => {
    let cancelled = false;
    if (!projectId) {
      setProject(null);
      setVolumes([]);
      setChapters([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    void Promise.all([
      getProject(projectId),
      listVolumes(projectId),
      listChapters(projectId),
      listStyleProfileOptions(projectId),
      getActiveStyleProfile(projectId),
    ])
      .then(([nextProject, nextVolumes, nextChapters, nextStyleOptions, nextActiveStyle]) => {
        if (cancelled) return;
        setProject(nextProject);
        setVolumes(nextVolumes);
        setChapters(nextChapters);
        setStyleOptions(nextStyleOptions);
        setActiveStyleProfileState(nextActiveStyle);
        const selectedId = useAppStore.getState().currentChapterId;
        if (!selectedId || !nextChapters.some((chapter) => chapter.id === selectedId)) {
          setCurrentChapter(nextChapters[0]?.id ?? null);
        }
      })
      .catch((loadError) => {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : String(loadError));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, revision, setCurrentChapter]);

  useEffect(() => {
    if (!activeChapter || (draftRef.current.chapterId === activeChapter.id && draftRef.current.dirty)) return;
    setTitle(activeChapter.title);
    setContent(activeChapter.content);
    setSavedAt(null);
    setDirty(false);
    draftRef.current = {
      chapterId: activeChapter.id,
      title: activeChapter.title,
      content: activeChapter.content,
      dirty: false,
      version: draftRef.current.version + 1,
    };
    void getPendingChapterStyleEvolution(activeChapter.id)
      .then(setPendingEvolution)
      .catch((snapshotError) => setError(snapshotError instanceof Error ? snapshotError.message : String(snapshotError)));
  }, [activeChapter?.id, activeChapter?.updatedAt]);

  useEffect(() => {
    setEditing(false);
  }, [activeChapter?.id]);

  const clearDraft = () => {
    setTitle("");
    setContent("");
    setSavedAt(null);
    setDirty(false);
    draftRef.current = {
      chapterId: "",
      title: "",
      content: "",
      dirty: false,
      version: draftRef.current.version + 1,
    };
  };

  const persistDraft = async (force: boolean): Promise<boolean> => {
    const draft = draftRef.current;
    if (!draft.chapterId || (!force && !draft.dirty)) return true;
    if (savingRef.current) return false;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const nextTitle = draft.title.trim() || "Untitled chapter";
      await saveChapter(draft.chapterId, nextTitle, draft.content);
      const snapshot = await recordLatestAuthorRevision(draft.chapterId, draft.content);
      const updatedAt = new Date().toISOString();
      const savedTime = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      setChapters((current) => current.map((chapter) => chapter.id === draft.chapterId
        ? { ...chapter, title: nextTitle, content: draft.content, updatedAt }
        : chapter));
      if (draftRef.current.chapterId === draft.chapterId && draftRef.current.version === draft.version) {
        setTitle(nextTitle);
        draftRef.current = { ...draftRef.current, title: nextTitle, dirty: false };
        setDirty(false);
      }
      setSavedAt(savedTime);
      setPendingEvolution(snapshot?.status === "revised" && snapshot.authorRevision !== snapshot.aiDraft ? snapshot : null);
      return true;
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  useEffect(() => {
    persistDraftRef.current = persistDraft;
  });

  useEffect(() => {
    if (!dirty || saving) return;
    const timeout = setTimeout(() => {
      void persistDraft(false);
    }, autoSaveDelay);
    return () => clearTimeout(timeout);
  }, [dirty, title, content, activeChapter?.id, autoSaveDelay, saving]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      if (nextState !== "active") void persistDraftRef.current(false);
    });
    return () => {
      subscription.remove();
      void persistDraftRef.current(false);
    };
  }, []);

  const updateDraft = (nextTitle: string, nextContent: string) => {
    setTitle(nextTitle);
    setContent(nextContent);
    setSavedAt(null);
    setDirty(true);
    draftRef.current = {
      chapterId: activeChapter?.id ?? draftRef.current.chapterId,
      title: nextTitle,
      content: nextContent,
      dirty: true,
      version: draftRef.current.version + 1,
    };
  };

  const selectChapter = async (chapterId: string) => {
    if (chapterId === activeChapter?.id) {
      setChapterPickerVisible(false);
      return;
    }
    if (savingRef.current) {
      setError("A chapter is saving; try switching again shortly");
      return;
    }
    if (!await persistDraft(false)) return;
    setCurrentChapter(chapterId);
    setChapterPickerVisible(false);
  };

  const openNameDialog = async (dialog: NameDialog, initialValue: string) => {
    if (savingRef.current) {
      setError("A chapter is saving; try again shortly");
      return;
    }
    if (!await persistDraft(false)) return;
    setDirectoryTarget(null);
    setChapterPickerVisible(false);
    setNameValue(initialValue);
    setNameDialog(dialog);
  };

  const submitNameDialog = async () => {
    if (!projectId || !nameDialog || !nameValue.trim()) return;
    setNameSaving(true);
    setError(null);
    try {
      if (nameDialog.kind === "create-volume") {
        const volume = await createVolume(projectId, nameValue);
        setVolumes((current) => [...current, volume].sort((left, right) => left.orderIndex - right.orderIndex));
      } else if (nameDialog.kind === "rename-volume") {
        const volume = await renameVolume(nameDialog.volume.id, nameValue);
        setVolumes((current) => current.map((item) => item.id === volume.id ? volume : item));
      } else if (nameDialog.kind === "create-chapter") {
        const chapter = await createChapter(projectId, nameDialog.volume.id, nameValue);
        setChapters((current) => [...current, chapter]);
        setCurrentChapter(chapter.id);
      } else {
        const chapter = await renameChapter(nameDialog.chapter.id, nameValue);
        setChapters((current) => current.map((item) => item.id === chapter.id ? chapter : item));
        if (activeChapter?.id === chapter.id) {
          setTitle(chapter.title);
          draftRef.current = {
            ...draftRef.current,
            title: chapter.title,
            dirty: false,
            version: draftRef.current.version + 1,
          };
          setDirty(false);
        }
      }
      setNameDialog(null);
      setNameValue("");
      refreshData();
    } catch (nameError) {
      setError(nameError instanceof Error ? nameError.message : String(nameError));
    } finally {
      setNameSaving(false);
    }
  };

  const removeChapter = async (chapter: Chapter, removeNotes: boolean) => {
    if (savingRef.current) {
      setError("A chapter is saving; try deleting again shortly");
      return;
    }
    if (chapter.id === activeChapter?.id && !await persistDraft(false)) return;
    setError(null);
    try {
      // 先删笔记再删章节；不删的话外键 SET NULL 会让这些笔记上浮到卷级。
      if (removeNotes) await deleteNotesUnder({ chapterId: chapter.id });
      await deleteChapter(chapter.id);
      const nextChapters = chapters.filter((item) => item.id !== chapter.id);
      setChapters(nextChapters);
      if (chapter.id === activeChapter?.id) {
        const nextChapter = nextChapters[0] ?? null;
        setCurrentChapter(nextChapter?.id ?? null);
        if (!nextChapter) clearDraft();
      }
      refreshData();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : String(deleteError));
    }
  };

  const confirmDeleteChapter = async (chapter: Chapter) => {
    setDirectoryTarget(null);
    setChapterPickerVisible(false);
    const noteCount = await countNotesUnder({ chapterId: chapter.id }).catch(() => 0);
    if (!noteCount) {
      Alert.alert("Delete chapter", "Delete \"" + chapter.title + "\"? The text and local index will be deleted too.", [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: () => { void removeChapter(chapter, false); } },
      ]);
      return;
    }
    Alert.alert(
      "Delete chapter",
      "\"" + chapter.title + "\" has " + noteCount + " note(s). The text and local index will be deleted too — what should happen to the notes?",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Keep notes", onPress: () => { void removeChapter(chapter, false); } },
        { text: "Delete them too", style: "destructive", onPress: () => { void removeChapter(chapter, true); } },
      ],
    );
  };

  const removeVolume = async (volume: Volume, removeNotes: boolean) => {
    if (savingRef.current) {
      setError("A chapter is saving; try deleting again shortly");
      return;
    }
    const removesActiveChapter = activeChapter?.volumeId === volume.id;
    if (removesActiveChapter && !await persistDraft(false)) return;
    setError(null);
    try {
      if (removeNotes) await deleteNotesUnder({ volumeId: volume.id });
      await deleteVolume(volume.id);
      const nextVolumes = volumes.filter((item) => item.id !== volume.id);
      const nextChapters = chapters.filter((chapter) => chapter.volumeId !== volume.id);
      setVolumes(nextVolumes);
      setChapters(nextChapters);
      if (removesActiveChapter) {
        const nextChapter = nextChapters[0] ?? null;
        setCurrentChapter(nextChapter?.id ?? null);
        if (!nextChapter) clearDraft();
      }
      refreshData();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : String(deleteError));
    }
  };

  const confirmDeleteVolume = (volume: Volume) => {
    setDirectoryTarget(null);
    setChapterPickerVisible(false);
    if (volumes.length <= 1) {
      Alert.alert("Cannot delete", "Each project must keep at least one volume; you can rename it instead.");
      return;
    }
    const chapterCount = chapters.filter((chapter) => chapter.volumeId === volume.id).length;
    const detail = chapterCount
      ? "Its " + chapterCount + " chapter(s), text and local index will all be deleted."
      : "This volume currently has no chapters.";
    void countNotesUnder({ volumeId: volume.id }).catch(() => 0).then((noteCount) => {
      if (!noteCount) {
        Alert.alert("Delete volume", "Delete \"" + volume.title + "\"? " + detail, [
          { text: "Cancel", style: "cancel" },
          { text: "Delete", style: "destructive", onPress: () => { void removeVolume(volume, false); } },
        ]);
        return;
      }
      Alert.alert(
        "Delete volume",
        "\"" + volume.title + "\" and its chapters have " + noteCount + " note(s). " + detail + "What should happen to the notes?",
        [
          { text: "Cancel", style: "cancel" },
          { text: "Keep notes", onPress: () => { void removeVolume(volume, false); } },
          { text: "Delete them too", style: "destructive", onPress: () => { void removeVolume(volume, true); } },
        ],
      );
    });
  };

  const openNewChapter = () => {
    const volume = activeVolume ?? volumes[0];
    if (volume) {
      void openNameDialog(
        { kind: "create-chapter", volume },
        "Chapter " + (chapters.length + 1),
      );
    } else {
      void openNameDialog({ kind: "create-volume" }, "Volume 1");
    }
  };

  const saveAndPreview = async () => {
    if (await persistDraft(true)) setEditing(false);
  };

  const chooseStyle = async (profile: StyleProfile | null) => {
    if (!projectId || evolvingStyle) return;
    setError(null);
    try {
      await setActiveStyleProfile(projectId, profile?.id ?? null);
      setActiveStyleProfileState(profile);
      setStylePickerVisible(false);
    } catch (styleError) {
      setError(styleError instanceof Error ? styleError.message : String(styleError));
    }
  };

  const evolveFromRevision = async () => {
    if (!projectId || !activeChapter || !pendingEvolution || evolvingStyle) return;
    setEvolvingStyle(true);
    setError(null);
    try {
      if (!await persistDraft(false)) return;
      const selection = await resolveModelSelection();
      const evolved = await evolveAuthorStyle({
        projectId,
        aiDraft: pendingEvolution.aiDraft,
        authorRevision: pendingEvolution.authorRevision ?? content,
        selection,
      });
      await markChapterStyleEvolved(pendingEvolution.id);
      setStyleOptions(await listStyleProfileOptions(projectId));
      setActiveStyleProfileState(evolved.profile);
      setPendingEvolution(null);
      refreshData();
      Alert.alert("Author style evolved", "Saved as \"" + evolved.profile.name + " V" + evolved.profile.version + "\"; later writing will use this version.");
    } catch (evolutionError) {
      setError(evolutionError instanceof Error ? evolutionError.message : String(evolutionError));
    } finally {
      setEvolvingStyle(false);
    }
  };

  const handleExport = async (scope: ExportScope) => {
    if (!project) return;
    const chapterId = activeChapter?.id;
    const volumeId = activeVolume?.id;
    setExporting(true);
    setError(null);
    try {
      if (!await persistDraft(false)) return;
      const [freshVolumes, freshChapters] = await Promise.all([
        listVolumes(project.id),
        listChapters(project.id),
      ]);
      await exportNovel({ project, volumes: freshVolumes, chapters: freshChapters, scope, chapterId, volumeId });
      setExportPickerVisible(false);
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : String(exportError));
    } finally {
      setExporting(false);
    }
  };

  const nameDialogTitle = nameDialog?.kind === "create-volume"
    ? "New volume"
    : nameDialog?.kind === "rename-volume"
      ? "Rename volume"
      : nameDialog?.kind === "create-chapter"
        ? "New chapter"
        : "Rename chapter";
  const nameDialogLabel = nameDialog?.kind === "create-volume" || nameDialog?.kind === "rename-volume"
    ? "Volume name"
    : "Chapter name";

  if (!projectId) return <Screen><EmptyState title="Choose a project from the shelf first" /></Screen>;
  if (loading) return <Screen><Header title="Writing" /><View style={styles.loading}><Text style={styles.muted}>Opening project…</Text></View></Screen>;

  return (
    <Screen>
      <Header
        title={project?.title ?? "Writing"}
        action={(
          <View style={styles.headerActions}>
            <Pressable accessibilityLabel="Export project" onPress={() => setExportPickerVisible(true)} style={styles.iconButton}>
              <Ionicons name="share-outline" size={22} color={colors.primary} />
            </Pressable>
            <Pressable accessibilityLabel={volumes.length ? "New chapter" : "New volume"} onPress={openNewChapter} style={styles.iconButton}>
              <Ionicons name={volumes.length ? "document-text-outline" : "folder-open-outline"} size={23} color={colors.primary} />
            </Pressable>
          </View>
        )}
      />
      <KeyboardAvoidingView style={styles.flex} behavior="height" automaticOffset>
        <Pressable accessibilityRole="button" onPress={() => setChapterPickerVisible(true)} style={styles.chapterPicker}>
          <View style={styles.chapterPickerTextGroup}>
            <Text numberOfLines={1} style={styles.chapterPickerVolume}>{activeVolume?.title ?? "Contents"}</Text>
            <Text numberOfLines={1} style={styles.chapterPickerText}>{activeChapter?.title ?? "Choose a chapter"}</Text>
          </View>
          <Ionicons name="chevron-down" size={18} color={colors.textMuted} />
        </Pressable>
        <Pressable accessibilityRole="button" onPress={() => setStylePickerVisible(true)} style={styles.styleSelector}>
          <Ionicons name="color-wand-outline" size={17} color={activeStyleProfile ? colors.primary : colors.textMuted} />
          <Text numberOfLines={1} style={[styles.styleSelectorText, activeStyleProfile && styles.styleSelectorTextActive]}>
            {activeStyleProfile ? styleProfileLabel(activeStyleProfile) : "No writing style"}
          </Text>
          <Ionicons name="chevron-down" size={16} color={colors.textMuted} />
        </Pressable>
        {error ? <View style={styles.errorWrap}><ErrorNotice message={error} /></View> : null}
        {activeChapter ? (
          <View style={styles.editor}>
            {editing ? (
              <>
                <TextInput
                  value={title}
                  onChangeText={(value) => updateDraft(value, content)}
                  style={styles.titleInput}
                  placeholder="Chapter title"
                  placeholderTextColor={colors.textMuted}
                  maxLength={200}
                />
                <TextInput
                  value={content}
                  onChangeText={(value) => updateDraft(title, value)}
                  style={[styles.contentInput, { fontSize: editorFontSize, lineHeight: Math.round(editorFontSize * 1.65) }]}
                  placeholder="Start writing…"
                  placeholderTextColor={colors.textMuted}
                  multiline
                  textAlignVertical="top"
                  autoCorrect
                />
                <View style={styles.editorFooter}>
                  <Text style={styles.counter}>
                    {content.replace(/\s/g, "").length + " chars" + (dirty ? " · unsaved" : savedAt ? " · saved " + savedAt : "")}
                  </Text>
                  <Button label={saving ? "Saving" : "Save & preview"} onPress={() => { void saveAndPreview(); }} disabled={saving} loading={saving} />
                </View>
              </>
            ) : (
              <View style={styles.preview}>
                <View style={styles.previewHeader}>
                  <View style={styles.previewHeading}>
                    <Text style={styles.previewTitle}>{title || "Untitled chapter"}</Text>
                    <Text style={styles.previewMeta}>{content.replace(/\s/g, "").length + " chars" + (savedAt ? " · saved " + savedAt : "")}</Text>
                  </View>
                  <Pressable accessibilityLabel="Edit chapter" onPress={() => setEditing(true)} style={styles.editButton}>
                    <Ionicons name="create-outline" size={22} color={colors.primary} />
                    <Text style={styles.editButtonText}>Edit</Text>
                  </Pressable>
                </View>
                <ScrollView style={styles.previewScroll} contentContainerStyle={styles.previewContent} showsVerticalScrollIndicator>
                  <Text selectable style={[styles.previewText, { fontSize: editorFontSize, lineHeight: Math.round(editorFontSize * 1.65) }]}>
                    {content || "No text in this chapter yet. Tap Edit in the top-right to start writing."}
                  </Text>
                </ScrollView>
                <View style={styles.editorFooter}>
                  <Text style={styles.counter}>{dirty ? "Saving changes…" : "Preview mode"}</Text>
                  <View style={styles.previewActions}>
                    {pendingEvolution ? (
                      <Button label="Evolve author style" variant="secondary" onPress={() => { void evolveFromRevision(); }} disabled={saving || evolvingStyle} loading={evolvingStyle} />
                    ) : null}
                    {dirty ? <Button label="Save" onPress={() => { void persistDraft(true); }} disabled={saving} loading={saving} /> : null}
                  </View>
                </View>
              </View>
            )}
          </View>
        ) : volumes[0] ? (
          <EmptyState
            title={"\"" + volumes[0].title + "\" has no chapters yet"}
            action={<Button label="New chapter" onPress={openNewChapter} />}
          />
        ) : (
          <EmptyState
            title="No volumes yet"
            action={<Button label="New volume" onPress={() => { void openNameDialog({ kind: "create-volume" }, "Volume 1"); }} />}
          />
        )}
      </KeyboardAvoidingView>

      <StyleProfilePickerSheet
        visible={stylePickerVisible}
        subtitle="Used for the assistant's later prose generation or edits"
        options={styleOptions}
        activeProfileId={activeStyleProfile?.id ?? null}
        onSelect={(profile) => void chooseStyle(profile)}
        onClose={() => setStylePickerVisible(false)}
      />

      <Modal visible={chapterPickerVisible} transparent animationType="slide" onRequestClose={() => setChapterPickerVisible(false)}>
        <SheetBackdrop onPress={() => setChapterPickerVisible(false)}>
          <View style={styles.directorySheet}>
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>Contents</Text>
              <View style={styles.sheetHeaderActions}>
                <Pressable
                  accessibilityLabel="New volume"
                  onPress={() => { void openNameDialog({ kind: "create-volume" }, "Volume " + (volumes.length + 1)); }}
                  style={styles.iconButton}
                >
                  <Ionicons name="folder-open-outline" size={22} color={colors.primary} />
                </Pressable>
                <Pressable accessibilityLabel="Close contents" onPress={() => setChapterPickerVisible(false)} style={styles.iconButton}>
                  <Ionicons name="close" size={24} color={colors.textMuted} />
                </Pressable>
              </View>
            </View>
            <SectionList
              sections={directorySections}
              keyExtractor={(item) => item.id}
              stickySectionHeadersEnabled={false}
              style={styles.directoryListScroll}
              contentContainerStyle={styles.directoryList}
              renderSectionHeader={({ section }) => (
                <View style={styles.volumeHeader}>
                  <Ionicons name="folder-open-outline" size={18} color={colors.accent} />
                  <Text numberOfLines={1} style={styles.volumeTitle}>{section.volume.title}</Text>
                  <Text style={styles.volumeCount}>{section.data.length + " chapters"}</Text>
                  <Pressable
                    accessibilityLabel={"New chapter in " + section.volume.title}
                    onPress={() => {
                      void openNameDialog(
                        { kind: "create-chapter", volume: section.volume },
                        "Chapter " + (chapters.length + 1),
                      );
                    }}
                    style={styles.rowAction}
                  >
                    <Ionicons name="add" size={21} color={colors.primary} />
                  </Pressable>
                  <Pressable
                    accessibilityLabel={"Manage " + section.volume.title}
                    onPress={() => setDirectoryTarget({ kind: "volume", volume: section.volume })}
                    style={styles.rowAction}
                  >
                    <Ionicons name="ellipsis-horizontal" size={20} color={colors.textMuted} />
                  </Pressable>
                </View>
              )}
              renderItem={({ item }) => (
                <Pressable
                  onPress={() => { void selectChapter(item.id); }}
                  style={[styles.chapterRow, item.id === activeChapter?.id && styles.chapterRowActive]}
                >
                  <Ionicons
                    name="document-text-outline"
                    size={18}
                    color={item.id === activeChapter?.id ? colors.primary : colors.textMuted}
                  />
                  <Text numberOfLines={1} style={[styles.chapterRowText, item.id === activeChapter?.id && styles.chapterRowTextActive]}>
                    {item.title}
                  </Text>
                  {item.id === activeChapter?.id ? <Ionicons name="checkmark" size={20} color={colors.primary} /> : null}
                  <Pressable
                    accessibilityLabel={"Manage " + item.title}
                    onPress={(event) => {
                      event.stopPropagation();
                      setDirectoryTarget({ kind: "chapter", chapter: item });
                    }}
                    style={styles.rowAction}
                  >
                    <Ionicons name="ellipsis-horizontal" size={20} color={colors.textMuted} />
                  </Pressable>
                </Pressable>
              )}
              ListEmptyComponent={(
                <EmptyState
                  title="No volumes yet"
                  action={<Button label="New volume" onPress={() => { void openNameDialog({ kind: "create-volume" }, "Volume 1"); }} />}
                />
              )}
            />
          </View>
        </SheetBackdrop>
      </Modal>

      <Modal visible={exportPickerVisible} transparent animationType="fade" onRequestClose={() => setExportPickerVisible(false)}>
        <SheetBackdrop onPress={() => setExportPickerVisible(false)}>
          <View style={styles.actionSheet}>
            <View style={styles.exportHeader}>
              <Text style={styles.actionTitle}>Export project</Text>
              <Pressable accessibilityLabel="Close export options" onPress={() => setExportPickerVisible(false)} style={styles.iconButton}>
                <Ionicons name="close" size={24} color={colors.textMuted} />
              </Pressable>
            </View>
            <Pressable disabled={exporting || !activeChapter} onPress={() => { void handleExport("chapter"); }} style={[styles.exportOption, (!activeChapter || exporting) && styles.exportOptionDisabled]}>
              <Ionicons name="document-text-outline" size={23} color={activeChapter ? colors.primary : colors.textMuted} />
              <View style={styles.exportOptionText}>
                <Text style={styles.exportOptionTitle}>Current chapter</Text>
                <Text style={styles.exportOptionMeta} numberOfLines={1}>{activeChapter?.title ?? "No chapter to export"}</Text>
              </View>
              {exporting ? <ActivityIndicator color={colors.primary} /> : <Ionicons name="chevron-forward" size={19} color={colors.textMuted} />}
            </Pressable>
            <Pressable disabled={exporting || !activeVolume} onPress={() => { void handleExport("volume"); }} style={[styles.exportOption, (!activeVolume || exporting) && styles.exportOptionDisabled]}>
              <Ionicons name="folder-open-outline" size={23} color={activeVolume ? colors.primary : colors.textMuted} />
              <View style={styles.exportOptionText}>
                <Text style={styles.exportOptionTitle}>Current volume</Text>
                <Text style={styles.exportOptionMeta} numberOfLines={1}>{activeVolume?.title ?? "No volume to export"}</Text>
              </View>
              <Ionicons name="chevron-forward" size={19} color={colors.textMuted} />
            </Pressable>
            <Pressable disabled={exporting || !volumes.length} onPress={() => { void handleExport("book"); }} style={[styles.exportOption, (!volumes.length || exporting) && styles.exportOptionDisabled]}>
              <Ionicons name="library-outline" size={23} color={volumes.length ? colors.primary : colors.textMuted} />
              <View style={styles.exportOptionText}>
                <Text style={styles.exportOptionTitle}>Whole novel</Text>
                <Text style={styles.exportOptionMeta}>{volumes.length + " volumes · " + chapters.length + " chapters"}</Text>
              </View>
              <Ionicons name="chevron-forward" size={19} color={colors.textMuted} />
            </Pressable>
          </View>
        </SheetBackdrop>
      </Modal>
      <Modal visible={Boolean(directoryTarget)} transparent animationType="fade" onRequestClose={() => setDirectoryTarget(null)}>
        <SheetBackdrop onPress={() => setDirectoryTarget(null)}>
          <View style={styles.actionSheet}>
            <Text numberOfLines={2} style={styles.actionTitle}>
              {directoryTarget?.kind === "volume" ? directoryTarget.volume.title : directoryTarget?.chapter.title}
            </Text>
            {directoryTarget?.kind === "volume" ? (
              <Pressable
                onPress={() => {
                  void openNameDialog(
                    { kind: "create-chapter", volume: directoryTarget.volume },
                    "Chapter " + (chapters.length + 1),
                  );
                }}
                style={styles.actionRow}
              >
                <Ionicons name="add-circle-outline" size={22} color={colors.primary} />
                <Text style={styles.actionText}>New chapter</Text>
              </Pressable>
            ) : null}
            <Pressable
              onPress={() => {
                if (directoryTarget?.kind === "volume") {
                  void openNameDialog({ kind: "rename-volume", volume: directoryTarget.volume }, directoryTarget.volume.title);
                } else if (directoryTarget?.kind === "chapter") {
                  void openNameDialog({ kind: "rename-chapter", chapter: directoryTarget.chapter }, directoryTarget.chapter.title);
                }
              }}
              style={styles.actionRow}
            >
              <Ionicons name="create-outline" size={22} color={colors.text} />
              <Text style={styles.actionText}>Rename</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                if (directoryTarget?.kind === "volume") confirmDeleteVolume(directoryTarget.volume);
                else if (directoryTarget?.kind === "chapter") void confirmDeleteChapter(directoryTarget.chapter);
              }}
              style={styles.actionRow}
            >
              <Ionicons name="trash-outline" size={22} color={colors.danger} />
              <Text style={styles.actionTextDanger}>{directoryTarget?.kind === "volume" ? "Delete volume" : "Delete chapter"}</Text>
            </Pressable>
          </View>
        </SheetBackdrop>
      </Modal>

      <Modal visible={Boolean(nameDialog)} transparent animationType="fade" onRequestClose={() => setNameDialog(null)}>
        <KeyboardAvoidingView style={styles.centeredBackdrop} behavior="height" automaticOffset>
          <View style={styles.nameDialog}>
            <Text style={styles.nameDialogTitle}>{nameDialogTitle}</Text>
            <Field
              label={nameDialogLabel}
              value={nameValue}
              onChangeText={setNameValue}
              maxLength={200}
              autoFocus
              returnKeyType="done"
              onSubmitEditing={() => { void submitNameDialog(); }}
            />
            <View style={styles.nameDialogActions}>
              <Button label="Cancel" variant="secondary" onPress={() => setNameDialog(null)} />
              <Button label="OK" onPress={() => { void submitNameDialog(); }} disabled={!nameValue.trim()} loading={nameSaving} />
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  loading: { flex: 1, alignItems: "center", justifyContent: "center" },
  muted: { color: colors.textMuted, fontSize: 15, padding: spacing.lg, textAlign: "center" },
  iconButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  headerActions: { flexDirection: "row", alignItems: "center" },
  chapterPicker: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  chapterPickerTextGroup: { flex: 1, minWidth: 0, gap: 2 },
  chapterPickerVolume: { color: colors.textMuted, fontSize: 12, fontWeight: "600" },
  chapterPickerText: { color: colors.text, fontSize: 15, fontWeight: "700" },
  styleSelector: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.lg, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, backgroundColor: colors.surface },
  styleSelectorText: { flex: 1, color: colors.textMuted, fontSize: 13, fontWeight: "600" },
  styleSelectorTextActive: { color: colors.primary },
  errorWrap: { paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  editor: { flex: 1, padding: spacing.lg, gap: spacing.md },
  preview: { flex: 1, gap: spacing.md },
  previewHeader: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingBottom: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  previewHeading: { flex: 1, minWidth: 0, gap: spacing.xs },
  previewTitle: { color: colors.text, fontSize: 23, fontWeight: "700" },
  previewMeta: { color: colors.textMuted, fontSize: 12 },
  editButton: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: spacing.xs, paddingHorizontal: spacing.sm },
  editButtonText: { color: colors.primary, fontSize: 14, fontWeight: "700" },
  previewScroll: { flex: 1 },
  previewContent: { paddingVertical: spacing.md, paddingBottom: spacing.xl },
  previewText: { minHeight: 220, color: colors.text },
  titleInput: { color: colors.text, fontSize: 22, fontWeight: "700", paddingVertical: spacing.sm },
  contentInput: { flex: 1, minHeight: 220, color: colors.text, fontSize: 17, lineHeight: 28, padding: 0 },
  editorFooter: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: spacing.md },
  previewActions: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end", gap: spacing.sm },
  counter: { flex: 1, color: colors.textMuted, fontSize: 12 },
  centeredBackdrop: { flex: 1, justifyContent: "center", padding: spacing.lg, backgroundColor: colors.overlay },
  directorySheet: {
    maxHeight: "82%",
    minHeight: "46%",
    paddingBottom: spacing.lg,
    borderTopLeftRadius: radius.md,
    borderTopRightRadius: radius.md,
    backgroundColor: colors.background,
  },
  sheetHeader: {
    minHeight: 58,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingLeft: spacing.lg,
    paddingRight: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  sheetHeaderActions: { flexDirection: "row", alignItems: "center" },
  sheetTitle: { color: colors.text, fontSize: 18, fontWeight: "700" },
  // 父层只有 maxHeight，ScrollView/FlatList 默认不收缩会把超出部分顶出可视区且滚不动，必须允许它收缩。
  directoryListScroll: { flexShrink: 1 },
  directoryList: { paddingBottom: spacing.lg },
  volumeHeader: {
    minHeight: 50,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingLeft: spacing.lg,
    paddingRight: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    backgroundColor: colors.surfaceMuted,
  },
  volumeTitle: { flex: 1, minWidth: 0, color: colors.text, fontSize: 15, fontWeight: "700" },
  volumeCount: { color: colors.textMuted, fontSize: 12 },
  chapterRow: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingLeft: spacing.xl,
    paddingRight: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    backgroundColor: colors.background,
  },
  chapterRowActive: { backgroundColor: colors.surface },
  chapterRowText: { flex: 1, minWidth: 0, color: colors.text, fontSize: 15 },
  chapterRowTextActive: { color: colors.primary, fontWeight: "700" },
  rowAction: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  actionSheet: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xl,
    borderTopLeftRadius: radius.md,
    borderTopRightRadius: radius.md,
    backgroundColor: colors.background,
  },
  exportHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingLeft: spacing.sm },
  exportOption: { minHeight: 66, flexDirection: "row", alignItems: "center", gap: spacing.md, paddingHorizontal: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  exportOptionDisabled: { opacity: 0.48 },
  exportOptionText: { flex: 1, minWidth: 0, gap: 2 },
  exportOptionTitle: { color: colors.text, fontSize: 16, fontWeight: "700" },
  exportOptionMeta: { color: colors.textMuted, fontSize: 12 },
  actionTitle: {
    color: colors.textMuted,
    fontSize: 13,
    lineHeight: 19,
    paddingHorizontal: spacing.sm,
    paddingBottom: spacing.sm,
  },
  actionRow: {
    minHeight: 54,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  actionText: { color: colors.text, fontSize: 16, fontWeight: "600" },
  actionTextDanger: { color: colors.danger, fontSize: 16, fontWeight: "600" },
  nameDialog: { gap: spacing.lg, padding: spacing.xl, borderRadius: radius.md, backgroundColor: colors.background },
  nameDialogTitle: { color: colors.text, fontSize: 20, fontWeight: "700" },
  nameDialogActions: { flexDirection: "row", justifyContent: "flex-end", gap: spacing.sm },
});

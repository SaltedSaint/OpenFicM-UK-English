import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import {
  createAuthorStyleProfileVersion,
  deleteStyleProfile,
  getActiveStyleProfile,
  listStyleProfiles,
  listStyleProfilesForSource,
  listStyleSources,
  renameStyleSource,
  setActiveStyleProfile,
} from "@/data/style-repositories";
import { styleProfileLabel } from "@/lib/style-label";
import { resolveModelSelection } from "@/llm/selection";
import type { RootStackParamList } from "@/navigation/types";
import {
  getStyleDistillationCheckpoint,
  getStyleDistillationCoverage,
  type StyleDistillationCheckpoint,
  type StyleDistillationCoverage,
} from "@/settings/lorn-style-plugin";
import { importStyleSource, deleteStyleSource } from "@/style/source-library";
import { useStyleDistillationStore } from "@/style/distillation-store";
import { cancelStyleDistillation, startStyleDistillation } from "@/style/distillation-runner";
import { useAppStore } from "@/store/app-store";
import { colors, radius, spacing } from "@/theme";
import type { StyleProfile, StyleSource } from "@/types";

function formatBytes(value: number): string {
  if (value < 1024) return String(value) + " B";
  if (value < 1024 * 1024) return (value / 1024).toFixed(1) + " KB";
  return (value / (1024 * 1024)).toFixed(1) + " MB";
}

function formatName(source: StyleSource): string {
  return source.format === "epub" ? "EPUB" : source.format === "markdown" ? "Markdown" : "TXT";
}

export function StyleLibraryScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const projectId = useAppStore((state) => state.currentProjectId);
  const [sources, setSources] = useState<StyleSource[]>([]);
  const [profiles, setProfiles] = useState<StyleProfile[]>([]);
  const [activeProfile, setActiveProfile] = useState<StyleProfile | null>(null);
  const [selectedSource, setSelectedSource] = useState<StyleSource | null>(null);
  const [sourceProfiles, setSourceProfiles] = useState<StyleProfile[]>([]);
  const [selectedProfile, setSelectedProfile] = useState<StyleProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [distillationError, setDistillationError] = useState<string | null>(null);
  const [distillationCheckpoint, setDistillationCheckpoint] = useState<StyleDistillationCheckpoint | null>(null);
  const [distillationCoverage, setDistillationCoverage] = useState<StyleDistillationCoverage | null>(null);
  const [distillationModelName, setDistillationModelName] = useState<string | null>(null);
  const [sourceTitle, setSourceTitle] = useState("");
  const [editingSource, setEditingSource] = useState(false);
  const [editingAuthorGuide, setEditingAuthorGuide] = useState(false);
  const [authorGuide, setAuthorGuide] = useState("");
  // 蒸馏任务活在 store 里：离开本页也继续跑，回来后横幅和弹层仍能看到实时进度。
  const runningTask = useStyleDistillationStore((state) => state.task);
  const distillationOutcome = useStyleDistillationStore((state) => state.outcome);
  const distillationRevision = useStyleDistillationStore((state) => state.revision);
  const dismissOutcome = useStyleDistillationStore((state) => state.dismissOutcome);
  const selectedSourceRef = useRef<StyleSource | null>(null);

  const authorProfiles = useMemo(
    () => profiles.filter((profile) => profile.kind === "author"),
    [profiles],
  );
  const referenceProfiles = useMemo(
    () => profiles.filter((profile) => profile.kind === "reference"),
    [profiles],
  );
  // 按文件字节去重，所以同名多份只可能是多次导入的不同文件；这里标出来，方便逐份清理。
  const sourceTitleCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const source of sources) counts.set(source.title, (counts.get(source.title) ?? 0) + 1);
    return counts;
  }, [sources]);
  const hasDuplicateSourceTitles = [...sourceTitleCounts.values()].some((count) => count > 1);
  const selectedProfileSource = selectedProfile?.sourceId
    ? sources.find((source) => source.id === selectedProfile.sourceId) ?? null
    : null;
  const coverageStarted = Boolean(distillationCoverage && distillationCoverage.coveredUntil > 0);
  const coverageFinished = Boolean(distillationCoverage
    && distillationCoverage.coveredUntil >= distillationCoverage.totalUnits);
  const coverageUnitName = distillationCoverage?.unitKind === "segment" ? "segment" : "chapter";
  const taskForSelectedSource = runningTask && selectedSource && runningTask.sourceId === selectedSource.id
    ? runningTask
    : null;
  const outcomeUnitName = distillationOutcome?.unitKind === "segment" ? "segment" : "chapter";

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const nextSources = await listStyleSources();
      const nextProfiles = await listStyleProfiles(projectId ?? "");
      const nextActive = projectId ? await getActiveStyleProfile(projectId) : null;
      setSources(nextSources);
      setProfiles(nextProfiles);
      setActiveProfile(nextActive);
      if (nextActive?.kind === "author") setAuthorGuide(nextActive.guide);
      // 蒸馏跟随全局默认模型，界面上要说清楚是哪一个。
      setDistillationModelName(await resolveModelSelection()
        .then((selection) => selection.model.name)
        .catch(() => null));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useFocusEffect(useCallback(() => {
    void load();
  }, [load]));

  const loadSourceDetail = useCallback(async (source: StyleSource) => {
    try {
      const [nextProfiles, checkpoint, coverage] = await Promise.all([
        listStyleProfilesForSource(source.id),
        getStyleDistillationCheckpoint(source.id),
        getStyleDistillationCoverage(source.id),
      ]);
      setSourceProfiles(nextProfiles);
      setDistillationCheckpoint(checkpoint);
      setDistillationCoverage(coverage?.contentHash === source.contentHash ? coverage : null);
    } catch (sourceError) {
      setError(sourceError instanceof Error ? sourceError.message : String(sourceError));
      setSourceProfiles([]);
    }
  }, []);

  useEffect(() => {
    selectedSourceRef.current = selectedSource;
  }, [selectedSource]);

  // 后台蒸馏结束时自增 revision：刷新书库列表，弹层开着就同时刷新这份参考书的详情。
  useEffect(() => {
    if (!distillationRevision) return;
    void load();
    const source = selectedSourceRef.current;
    if (source) void loadSourceDetail(source);
  }, [distillationRevision, load, loadSourceDetail]);

  const openSource = async (source: StyleSource) => {
    setSelectedSource(source);
    selectedSourceRef.current = source;
    setEditingSource(false);
    setSourceTitle(source.title);
    setError(null);
    setDistillationError(null);
    await loadSourceDetail(source);
  };

  const closeSource = () => {
    setSelectedSource(null);
    selectedSourceRef.current = null;
    setSourceProfiles([]);
    setEditingSource(false);
    setDistillationError(null);
    setDistillationCheckpoint(null);
    setDistillationCoverage(null);
  };

  const importBook = async () => {
    setBusy(true);
    setError(null);
    try {
      const source = await importStyleSource();
      if (source) {
        await load();
        await openSource(source);
      }
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : String(importError));
    } finally {
      setBusy(false);
    }
  };

  const openProfile = (profile: StyleProfile) => {
    setSelectedSource(null);
    setSourceProfiles([]);
    setSelectedProfile(profile);
    setEditingAuthorGuide(false);
    if (profile.kind === "author") setAuthorGuide(profile.guide);
  };

  const distill = async (restart = false) => {
    if (!selectedSource) return;
    setError(null);
    setDistillationError(null);
    const started = await startStyleDistillation({
      sourceId: selectedSource.id,
      sourceTitle: selectedSource.title,
      restart,
    });
    if (!started.started && started.message) {
      setError(started.message);
      setDistillationError(started.message);
    }
  };

  const confirmRestart = () => {
    if (!selectedSource) return;
    Alert.alert(
      "Restart distillation",
      "This clears the covered progress and rescans from the start of the book; the new result replaces the existing reference style for \"" + selectedSource.title + "\" and the old content is not kept.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Restart", style: "destructive", onPress: () => void distill(true) },
      ],
    );
  };

  const activate = async (profile: StyleProfile | null) => {
    if (!projectId) {
      setError("Open a project from the shelf first, then choose a writing style");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await setActiveStyleProfile(projectId, profile?.id ?? null);
      setActiveProfile(profile);
      if (profile) setSelectedProfile(profile);
    } catch (activateError) {
      setError(activateError instanceof Error ? activateError.message : String(activateError));
    } finally {
      setBusy(false);
    }
  };

  const saveSourceTitle = async () => {
    if (!selectedSource || !sourceTitle.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await renameStyleSource(selectedSource.id, sourceTitle);
      setSources((current) => current.map((source) => source.id === updated.id ? updated : source));
      setSelectedSource(updated);
      setEditingSource(false);
    } catch (renameError) {
      setError(renameError instanceof Error ? renameError.message : String(renameError));
    } finally {
      setBusy(false);
    }
  };

  const confirmDeleteSource = () => {
    if (!selectedSource) return;
    Alert.alert(
      "Delete reference book",
      "Delete \"" + selectedSource.title + "\" and its reference style? The original file is stored only on this device.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => {
            setBusy(true);
            void deleteStyleSource(selectedSource.id)
              .then(async () => {
                setSelectedSource(null);
                setSourceProfiles([]);
                await load();
              })
              .catch((deleteError) => setError(deleteError instanceof Error ? deleteError.message : String(deleteError)))
              .finally(() => setBusy(false));
          },
        },
      ],
    );
  };

  const saveAuthor = async () => {
    if (!projectId || !authorGuide.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const profile = await createAuthorStyleProfileVersion({
        projectId,
        name: "My author style",
        guide: authorGuide,
        activateForProjectId: projectId,
      });
      setProfiles((current) => [profile, ...current.filter((item) => item.id !== profile.id)]);
      setActiveProfile(profile);
      setSelectedProfile(profile);
      setEditingAuthorGuide(false);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setBusy(false);
    }
  };

  const removeProfile = (profile: StyleProfile) => {
    Alert.alert("Delete style", "Delete \"" + styleProfileLabel(profile) + "\"?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          setBusy(true);
          void deleteStyleProfile(profile.id)
            .then(async () => {
              if (activeProfile?.id === profile.id) setActiveProfile(null);
              setSelectedProfile(null);
              await load();
            })
            .catch((deleteError) => setError(deleteError instanceof Error ? deleteError.message : String(deleteError)))
            .finally(() => setBusy(false));
        },
      },
    ]);
  };

  if (loading) {
    return <Screen><Header title="Style library" onBack={() => navigation.goBack()} /><View style={styles.loading}><ActivityIndicator color={colors.primary} /></View></Screen>;
  }

  return (
    <Screen>
      <Header
        title="Style library"
        onBack={() => navigation.goBack()}
        action={(
          <Pressable accessibilityLabel="Import reference novel" disabled={busy} onPress={() => void importBook()} style={styles.iconButton}>
            {busy ? <ActivityIndicator size="small" color={colors.primary} /> : <Ionicons name="add" size={26} color={colors.primary} />}
          </Pressable>
        )}
      />
      {error ? <View style={styles.errorWrap}><ErrorNotice message={error} onRetry={() => void load()} /></View> : null}
      <FlatList
        data={sources}
        keyExtractor={(item) => item.id}
        contentContainerStyle={sources.length ? styles.list : styles.emptyList}
        ListHeaderComponent={(
          <View style={styles.headerContent}>
            <View style={styles.intro}>
              <View style={styles.introIcon}><Ionicons name="color-wand-outline" size={24} color={colors.primary} /></View>
              <View style={styles.introCopy}>
                <Text style={styles.introTitle}>Reference styles and author styles</Text>
                <Text style={styles.introText}>After importing a novel from this device, the current default model extracts a separate style skill. The whole book is never uploaded; only sampled text is sent during distillation.</Text>
              </View>
            </View>
            {runningTask ? (
              <View style={styles.taskBanner}>
                <ActivityIndicator size="small" color={colors.primary} />
                <View style={styles.taskBannerCopy}>
                  <Text style={styles.taskBannerTitle}>Distilling "{runningTask.sourceTitle}"</Text>
                  <Text style={styles.taskBannerText} numberOfLines={2}>
                    {runningTask.label}. You can leave this screen and do other things; the task keeps running.
                  </Text>
                </View>
                <Pressable accessibilityLabel="Cancel distillation" onPress={() => cancelStyleDistillation()} style={styles.taskBannerAction}>
                  <Text style={styles.taskBannerActionText}>Cancel</Text>
                </Pressable>
              </View>
            ) : distillationOutcome ? (
              <View style={styles.taskBanner}>
                <Ionicons
                  name={distillationOutcome.error ? "alert-circle-outline" : distillationOutcome.cancelled ? "pause-circle-outline" : "checkmark-circle-outline"}
                  size={19}
                  color={distillationOutcome.error ? colors.danger : colors.primary}
                />
                <View style={styles.taskBannerCopy}>
                  <Text style={styles.taskBannerTitle} numberOfLines={1}>
                    {distillationOutcome.error ? "Distillation failed" : distillationOutcome.cancelled ? "Distillation cancelled" : "Distillation complete"} · "{distillationOutcome.sourceTitle}"
                  </Text>
                  <Text style={styles.taskBannerText} numberOfLines={3}>
                    {distillationOutcome.error
                      ?? (distillationOutcome.cancelled
                        ? `The completed part is kept in the checkpoint, covered up to ${distillationOutcome.coveredUntil}/${distillationOutcome.totalUnits} ${outcomeUnitName}; tapping "Continue distilling" again resumes from the checkpoint.`
                        : `Round ${distillationOutcome.round}, covered up to ${distillationOutcome.coveredUntil}/${distillationOutcome.totalUnits} ${outcomeUnitName}${distillationOutcome.reachedEnd ? " (whole book covered)" : ""}.`)}
                  </Text>
                </View>
                <Pressable accessibilityLabel="Dismiss the distillation result" onPress={dismissOutcome} style={styles.taskBannerAction}>
                  <Text style={styles.taskBannerActionText}>Close</Text>
                </Pressable>
              </View>
            ) : null}
            {projectId ? (
              <View style={styles.activeStrip}>
                <Ionicons name="checkmark-circle-outline" size={19} color={colors.primary} />
                <Text style={styles.activeStripText} numberOfLines={2}>
                  Currently using: {activeProfile ? styleProfileLabel(activeProfile) : "No style"}
                </Text>
                {activeProfile ? <Pressable onPress={() => void activate(null)} disabled={busy} style={styles.clearActive}><Text style={styles.clearActiveText}>Clear</Text></Pressable> : null}
              </View>
            ) : null}
            {authorProfiles.length ? (
              <View style={styles.sectionHeading}>
                <Text style={styles.sectionTitle}>My author style</Text>
                <Text style={styles.sectionMeta}>{authorProfiles.length} versions</Text>
              </View>
            ) : null}
            {authorProfiles.map((profile) => (
              <ProfileRow
                key={profile.id}
                profile={profile}
                active={activeProfile?.id === profile.id}
                onPress={() => openProfile(profile)}
                onActivate={() => void activate(profile)}
                disabled={busy || !projectId}
              />
            ))}
            <View style={styles.sectionHeading}>
              <Text style={styles.sectionTitle}>Reference novels</Text>
              <Text style={styles.sectionMeta}>{sources.length} books</Text>
            </View>
            {hasDuplicateSourceTitles ? (
              <Text style={styles.helperText}>
                Duplicate-name books: entries with the same name are different files imported more than once (duplicates are detected by file content, so re-importing the same file is rejected), each carrying its own reference style. To remove the ones you do not need, delete the reference book and its style goes with it.
              </Text>
            ) : null}
          </View>
        )}
        ListEmptyComponent={(
          <EmptyState
            title="No reference novels yet"
            action={<Button label="Import TXT / Markdown / EPUB" onPress={() => void importBook()} disabled={busy} loading={busy} />}
          />
        )}
        renderItem={({ item }) => (
          <Pressable onPress={() => void openSource(item)} style={({ pressed }) => [styles.sourceRow, pressed && styles.sourceRowPressed]}>
            <View style={styles.bookIcon}><Ionicons name="book-outline" size={23} color={colors.primary} /></View>
            <View style={styles.sourceCopy}>
              <Text style={styles.sourceTitle} numberOfLines={1}>{item.title}</Text>
              <Text style={styles.sourceMeta} numberOfLines={1}>{formatName(item)} · {formatBytes(item.sizeBytes)} · {item.characterCount.toLocaleString()} chars</Text>
              <Text style={styles.sourceMeta} numberOfLines={1}>
                {referenceProfiles.some((profile) => profile.sourceId === item.id) ? "Reference style generated" : "No style distilled yet"}
                {(sourceTitleCounts.get(item.title) ?? 0) > 1 ? ` · ${sourceTitleCounts.get(item.title)} with the same name` : ""}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={19} color={colors.textMuted} />
          </Pressable>
        )}
      />

      <Modal visible={Boolean(selectedSource)} transparent animationType="slide" onRequestClose={closeSource}>
        <SheetBackdrop onPress={closeSource}>
          <View style={styles.sheet}>
            <View style={styles.sheetHeader}>
              <View style={styles.sheetTitleWrap}>
                {editingSource ? (
                  <Field label="Reference book name" value={sourceTitle} onChangeText={setSourceTitle} autoFocus />
                ) : (
                  <>
                    <Text style={styles.sheetTitle} numberOfLines={2}>{selectedSource?.title}</Text>
                    <Text style={styles.sheetMeta}>{selectedSource ? formatName(selectedSource) + " · " + formatBytes(selectedSource.sizeBytes) + " · " + selectedSource.characterCount.toLocaleString() + " chars" : ""}</Text>
                  </>
                )}
              </View>
              <Pressable accessibilityLabel="Close reference book details" onPress={closeSource} style={styles.iconButton}>
                <Ionicons name="close" size={24} color={colors.textMuted} />
              </Pressable>
            </View>
            <ScrollView style={styles.sheetScroll} contentContainerStyle={styles.sheetContent} keyboardShouldPersistTaps="handled">
              {editingSource ? (
                <View style={styles.inlineActions}>
                  <Button label="Cancel" variant="secondary" onPress={() => setEditingSource(false)} />
                  <Button label="Save name" onPress={() => void saveSourceTitle()} disabled={!sourceTitle.trim()} loading={busy} />
                </View>
              ) : (
                <View style={styles.inlineActions}>
                  <Button
                    label={taskForSelectedSource ? "Distilling in background" : coverageStarted ? "Continue distilling" : "Distil style"}
                    onPress={() => void distill()}
                    disabled={busy || coverageFinished || Boolean(runningTask)}
                    loading={Boolean(taskForSelectedSource)}
                  />
                  {taskForSelectedSource ? (
                    <Button label="Cancel distillation" variant="secondary" onPress={() => cancelStyleDistillation()} />
                  ) : null}
                  {coverageStarted || distillationCheckpoint ? (
                    <Button label="Restart" variant="secondary" onPress={confirmRestart} disabled={busy || Boolean(runningTask)} />
                  ) : null}
                  <Pressable accessibilityLabel="Rename reference book" onPress={() => setEditingSource(true)} style={styles.secondaryIconAction}>
                    <Ionicons name="create-outline" size={21} color={colors.text} />
                  </Pressable>
                  <Pressable accessibilityLabel="Delete reference book" onPress={confirmDeleteSource} style={styles.secondaryIconAction}>
                    <Ionicons name="trash-outline" size={21} color={colors.danger} />
                  </Pressable>
                </View>
              )}
              {distillationError ? <ErrorNotice message={distillationError} onRetry={() => void distill()} /> : null}
              {runningTask && !taskForSelectedSource ? (
                <View style={styles.checkpointBox}>
                  <Text style={styles.checkpointTitle}>Distilling "{runningTask.sourceTitle}"</Text>
                  <Text style={styles.checkpointText}>
                    Only one distillation task runs at a time; wait for it to finish or cancel it from the banner before starting this book.
                  </Text>
                </View>
              ) : null}
              {distillationCoverage ? (
                <View style={styles.checkpointBox}>
                  <Text style={styles.checkpointTitle}>
                    {coverageFinished ? "Whole book covered" : `${distillationCoverage.rounds} rounds distilled`}
                  </Text>
                  <Text style={styles.checkpointText}>
                    Covered up to {distillationCoverage.coveredUntil}/{distillationCoverage.totalUnits} {coverageUnitName}.
                    {coverageFinished
                      ? "To gather more samples, tap Restart to rescan the whole book; this replaces the current reference style with the new result."
                      : "Tapping Continue distilling jumps randomly forward into unread regions and takes another continuous sample to merge into the same reference style."}
                  </Text>
                </View>
              ) : null}
              {distillationCheckpoint ? (
                <View style={styles.checkpointBox}>
                  <Text style={styles.checkpointTitle}>An unfinished distillation task was found</Text>
                  <Text style={styles.checkpointText}>
                    {coverageUnitName} {distillationCheckpoint.windowStart + 1}-{distillationCheckpoint.windowStart + distillationCheckpoint.windowCount} has completed {Math.min(distillationCheckpoint.completedMemos.length, distillationCheckpoint.batchCount)}/{distillationCheckpoint.batchCount} batches. Continuing resumes from the checkpoint without repeating completed batches.
                  </Text>
                </View>
              ) : null}
              {taskForSelectedSource ? (
                <View style={styles.checkpointBox}>
                  <Text style={styles.checkpointTitle}>Distillation in progress: {taskForSelectedSource.label}</Text>
                  <Text style={styles.checkpointText}>
                    You can close this window or leave the style library; the task continues in the background and reports its result here.
                  </Text>
                </View>
              ) : (
                <Text style={styles.helperText}>Each round samples 24 consecutive {coverageUnitName}, analyses them in 4 batches and merges them into the reference style; the whole novel is never uploaded. Tapping Continue distilling repeatedly advances randomly forward, gradually covering the whole book; each book always has exactly one reference style.</Text>
              )}
              <Text style={styles.helperText}>
                Distillation uses the default model in Settings → Models & providers: {distillationModelName ?? "no default model chosen yet"}
              </Text>
              <Text style={styles.sectionTitle}>Reference styles</Text>
              {sourceProfiles.length ? sourceProfiles.map((profile) => (
                <ProfileRow
                  key={profile.id}
                  profile={profile}
                  active={activeProfile?.id === profile.id}
                  onPress={() => openProfile(profile)}
                  onActivate={() => void activate(profile)}
                  disabled={busy || !projectId}
                />
              )) : <Text style={styles.emptyHint}>No reference style yet; tap Distil style to generate one.</Text>}
            </ScrollView>
          </View>
        </SheetBackdrop>
      </Modal>

      <Modal visible={Boolean(selectedProfile)} transparent animationType="slide" onRequestClose={() => setSelectedProfile(null)}>
        <SheetBackdrop onPress={() => setSelectedProfile(null)}>
          <View style={styles.sheet}>
            <View style={styles.sheetHeader}>
              <View style={styles.sheetTitleWrap}>
                <Text style={styles.sheetTitle} numberOfLines={2}>{selectedProfile ? styleProfileLabel(selectedProfile) : ""}</Text>
                <Text style={styles.sheetMeta}>
                  {selectedProfile?.kind === "author"
                    ? "Author style version"
                    : selectedProfileSource
                      ? `Reference-novel style · ${selectedProfileSource.format === "epub" ? "EPUB" : selectedProfileSource.format === "markdown" ? "Markdown" : "TXT"} · ${selectedProfileSource.characterCount.toLocaleString()} chars`
                      : "Reference-novel style (the source book was deleted)"}
                </Text>
              </View>
              <Pressable accessibilityLabel="Close style details" onPress={() => setSelectedProfile(null)} style={styles.iconButton}>
                <Ionicons name="close" size={24} color={colors.textMuted} />
              </Pressable>
            </View>
            <ScrollView style={styles.sheetScroll} contentContainerStyle={styles.profileContent}>
              {selectedProfile?.kind === "author" && editingAuthorGuide ? (
                <Field label="Author style guide" value={authorGuide} onChangeText={setAuthorGuide} multiline style={styles.guideInput} maxLength={100000} />
              ) : (
                <Text selectable style={styles.guideText}>{selectedProfile?.guide}</Text>
              )}
              <View style={styles.inlineActions}>
                {selectedProfile?.kind === "author" ? (
                  <Button
                    label={editingAuthorGuide ? "Save new version" : "Edit guide"}
                    onPress={() => {
                      if (editingAuthorGuide) void saveAuthor();
                      else setEditingAuthorGuide(true);
                    }}
                    disabled={busy || (editingAuthorGuide && !authorGuide.trim())}
                    loading={busy}
                  />
                ) : null}
                <Button
                  label={activeProfile?.id === selectedProfile?.id ? "In use" : "Use for writing"}
                  variant={activeProfile?.id === selectedProfile?.id ? "secondary" : "primary"}
                  onPress={() => void activate(selectedProfile)}
                  disabled={busy || !projectId || activeProfile?.id === selectedProfile?.id}
                />
                <Pressable accessibilityLabel="Delete style version" onPress={() => selectedProfile && removeProfile(selectedProfile)} style={styles.secondaryIconAction}>
                  <Ionicons name="trash-outline" size={21} color={colors.danger} />
                </Pressable>
              </View>
            </ScrollView>
          </View>
        </SheetBackdrop>
      </Modal>
    </Screen>
  );
}

function ProfileRow({
  profile,
  active,
  onPress,
  onActivate,
  disabled,
}: {
  profile: StyleProfile;
  active: boolean;
  onPress: () => void;
  onActivate: () => void;
  disabled: boolean;
}) {
  return (
    <View style={[styles.profileRow, active && styles.profileRowActive]}>
      <Pressable onPress={onPress} style={styles.profileMain}>
        <Ionicons name={active ? "checkmark-circle" : "document-text-outline"} size={20} color={active ? colors.primary : colors.textMuted} />
        <View style={styles.profileCopy}>
          <Text style={styles.profileName} numberOfLines={1}>{styleProfileLabel(profile)}</Text>
          <Text style={styles.profileMeta} numberOfLines={2}>{profile.guide.slice(0, 120).replace(/\s+/g, " ")}</Text>
        </View>
      </Pressable>
      <Pressable accessibilityLabel={active ? "Currently used style" : "Use this style"} onPress={onActivate} disabled={disabled || active} style={styles.useButton}>
        <Text style={[styles.useButtonText, active && styles.useButtonTextActive]}>{active ? "In use" : "Use"}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  loading: { flex: 1, alignItems: "center", justifyContent: "center" },
  iconButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  errorWrap: { padding: spacing.lg, paddingBottom: 0 },
  list: { paddingBottom: spacing.xl },
  emptyList: { flexGrow: 1, paddingBottom: spacing.xl },
  headerContent: { padding: spacing.lg, paddingBottom: spacing.sm },
  intro: { flexDirection: "row", gap: spacing.md, paddingBottom: spacing.lg },
  introIcon: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: radius.sm, backgroundColor: "#E6F3EF" },
  introCopy: { flex: 1, gap: spacing.xs },
  introTitle: { color: colors.text, fontSize: 17, fontWeight: "700" },
  introText: { color: colors.textMuted, fontSize: 13, lineHeight: 19 },
  taskBanner: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginBottom: spacing.md, padding: spacing.md, borderWidth: 1, borderColor: colors.primary, borderRadius: radius.sm, backgroundColor: "#E6F3EF" },
  taskBannerCopy: { flex: 1, minWidth: 0, gap: 3 },
  taskBannerTitle: { color: colors.primary, fontSize: 13, fontWeight: "700" },
  taskBannerText: { color: colors.textMuted, fontSize: 12, lineHeight: 18 },
  taskBannerAction: { minWidth: 52, minHeight: 44, alignItems: "center", justifyContent: "center" },
  taskBannerActionText: { color: colors.primary, fontSize: 13, fontWeight: "700" },
  activeStrip: { minHeight: 48, flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.md, borderWidth: 1, borderColor: colors.primary, borderRadius: radius.sm, backgroundColor: "#E6F3EF" },
  activeStripText: { flex: 1, color: colors.primary, fontSize: 13, fontWeight: "600" },
  clearActive: { minHeight: 44, justifyContent: "center", paddingHorizontal: spacing.sm },
  clearActiveText: { color: colors.primary, fontSize: 13, fontWeight: "700" },
  sectionHeading: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingTop: spacing.xl, paddingBottom: spacing.sm },
  sectionTitle: { color: colors.text, fontSize: 16, fontWeight: "700" },
  sectionMeta: { color: colors.textMuted, fontSize: 12 },
  sourceRow: { minHeight: 84, flexDirection: "row", alignItems: "center", gap: spacing.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  sourceRowPressed: { backgroundColor: colors.surfaceMuted },
  bookIcon: { width: 48, height: 56, alignItems: "center", justifyContent: "center", borderRadius: radius.sm, backgroundColor: "#DCECE6" },
  sourceCopy: { flex: 1, minWidth: 0, gap: 3 },
  sourceTitle: { color: colors.text, fontSize: 16, fontWeight: "700" },
  sourceMeta: { color: colors.textMuted, fontSize: 12 },
  profileRow: { minHeight: 68, flexDirection: "row", alignItems: "center", gap: spacing.sm, marginBottom: spacing.sm, paddingLeft: spacing.md, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, backgroundColor: colors.surface },
  profileRowActive: { borderColor: colors.primary, backgroundColor: "#E6F3EF" },
  profileMain: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingVertical: spacing.sm },
  profileCopy: { flex: 1, minWidth: 0, gap: 3 },
  profileName: { color: colors.text, fontSize: 14, fontWeight: "700" },
  profileMeta: { color: colors.textMuted, fontSize: 12, lineHeight: 17 },
  useButton: { minWidth: 54, minHeight: 44, alignItems: "center", justifyContent: "center", marginRight: spacing.xs },
  useButtonText: { color: colors.primary, fontSize: 13, fontWeight: "700" },
  useButtonTextActive: { color: colors.textMuted },
  sheet: { maxHeight: "88%", borderTopLeftRadius: radius.md, borderTopRightRadius: radius.md, backgroundColor: colors.background },
  // 父层只有 maxHeight，ScrollView 默认不收缩会把超出部分顶出可视区且滚不动，必须允许它收缩。
  sheetScroll: { flexShrink: 1 },
  sheetHeader: { minHeight: 70, flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingLeft: spacing.lg, paddingRight: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  sheetTitleWrap: { flex: 1, minWidth: 0 },
  sheetTitle: { color: colors.text, fontSize: 19, fontWeight: "700" },
  sheetMeta: { marginTop: 3, color: colors.textMuted, fontSize: 12 },
  sheetContent: { padding: spacing.lg, paddingBottom: spacing.xxl },
  profileContent: { gap: spacing.lg, padding: spacing.lg, paddingBottom: spacing.xxl },
  inlineActions: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: spacing.sm },
  secondaryIconAction: { width: 46, height: 46, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, backgroundColor: colors.surface },
  helperText: { color: colors.textMuted, fontSize: 13, lineHeight: 19 },
  checkpointBox: { gap: spacing.xs, padding: spacing.md, borderWidth: 1, borderColor: colors.primary, borderRadius: radius.sm, backgroundColor: "#E6F3EF" },
  checkpointTitle: { color: colors.primary, fontSize: 13, fontWeight: "700" },
  checkpointText: { color: colors.textMuted, fontSize: 12, lineHeight: 18 },
  emptyHint: { color: colors.textMuted, fontSize: 14, lineHeight: 20, paddingVertical: spacing.md },
  guideText: { color: colors.text, fontSize: 14, lineHeight: 22 },
  guideInput: { minHeight: 300 },
});

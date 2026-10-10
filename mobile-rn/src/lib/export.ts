import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";

import type { Chapter, Character, Project, Volume, WorldInfo, WorldInfoEntry } from "@/types";

export type ExportScope = "chapter" | "volume" | "book";
export type LibraryExportFormat = "json" | "markdown";

export interface ExportNovelInput {
  project: Project;
  volumes: Volume[];
  chapters: Chapter[];
  scope: ExportScope;
  chapterId?: string;
  volumeId?: string;
}

function safeFileName(value: string): string {
  return value.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_").trim().slice(0, 80) || "OpenFicM";
}

function renderChapter(chapter: Chapter): string {
  return `### ${chapter.title}\n\n${chapter.content.trim() || "(no text in this chapter yet)"}\n`;
}

export async function exportNovel(input: ExportNovelInput): Promise<void> {
  const orderedVolumes = [...input.volumes].sort((left, right) => left.orderIndex - right.orderIndex);
  const orderedChapters = [...input.chapters].sort((left, right) => left.orderIndex - right.orderIndex);
  let title = input.project.title;
  let markdown = `# ${input.project.title}\n\n`;

  if (input.project.description.trim()) markdown += `${input.project.description.trim()}\n\n`;

  if (input.scope === "chapter") {
    const chapter = orderedChapters.find((item) => item.id === input.chapterId);
    if (!chapter) throw new Error("The current chapter does not exist; cannot export");
    title = chapter.title;
    markdown += renderChapter(chapter);
  } else {
    const volumes = input.scope === "volume"
      ? orderedVolumes.filter((volume) => volume.id === input.volumeId)
      : orderedVolumes;
    if (!volumes.length) throw new Error(input.scope === "volume" ? "The current volume does not exist; cannot export" : "The project has no volume to export");
    if (input.scope === "volume") title = volumes[0].title;
    for (const volume of volumes) {
      markdown += `## ${volume.title}\n\n`;
      const volumeChapters = orderedChapters.filter((chapter) => chapter.volumeId === volume.id);
      markdown += volumeChapters.length
        ? volumeChapters.map(renderChapter).join("\n")
        : "(no chapters in this volume)\n\n";
    }
  }

  const scopeLabel = input.scope === "chapter" ? "chapter" : input.scope === "volume" ? "volume" : "book";
  const timestamp = new Date().toISOString().replace(/[.:]/g, "-");
  const file = new File(Paths.cache, `${safeFileName(input.project.title)}-${safeFileName(title)}-${scopeLabel}-${timestamp}.md`);
  if (file.exists) file.delete();
  file.write(markdown);
  if (!(await Sharing.isAvailableAsync())) throw new Error("This device does not support system sharing; try again later");
  await Sharing.shareAsync(file.uri, {
    mimeType: "text/markdown",
    dialogTitle: `Export ${scopeLabel}`,
  });
}

function dateStamp(): string {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function libraryFileName(projectTitle: string, label: string, format: LibraryExportFormat): string {
  return `${safeFileName(projectTitle)}_${label}_${dateStamp()}.${format === "json" ? "json" : "md"}`;
}

async function shareTextFile(fileName: string, content: string, format: LibraryExportFormat, dialogTitle: string): Promise<void> {
  const file = new File(Paths.cache, fileName);
  if (file.exists) file.delete();
  file.write(content);
  if (!(await Sharing.isAvailableAsync())) throw new Error("This device does not support system sharing; try again later");
  await Sharing.shareAsync(file.uri, {
    mimeType: format === "json" ? "application/json" : "text/markdown",
    dialogTitle,
  });
}

function renderCharacterMarkdown(character: Character): string {
  return `## ${character.name}\n\n- ID: ${character.id}\n- Project ID: ${character.projectId}\n- Image path: ${character.imagePath || "none"}\n- Favourited: ${character.isFavorited ? "Yes" : "No"}\n- Created: ${character.createdAt}\n- Updated: ${character.updatedAt}\n\n### Character profile\n\n${character.description || "none"}\n`;
}

function renderWorldEntryMarkdown(entry: WorldInfoEntry): string {
  return `## ${entry.name}\n\n- ID: ${entry.id}\n- UID: ${entry.uid}\n- Order: ${entry.order}\n- Enabled: ${entry.isEnabled ? "Yes" : "No"}\n- Tokens: ${entry.tokenCount}\n- Created: ${entry.createdAt}\n- Updated: ${entry.updatedAt}\n\n### Entry content\n\n${entry.content || "none"}\n`;
}

export async function exportCharacters(
  project: Project,
  characters: Character[],
  format: LibraryExportFormat,
): Promise<void> {
  if (!characters.length) throw new Error("There are no characters to export");
  const exportedAt = new Date().toISOString();
  const content = format === "json"
    ? JSON.stringify({ schemaVersion: "1.0", type: "openficm.characters", projectId: project.id, exportedAt, entries: characters }, null, 2)
    : `# ${project.title} · Characters\n\n- Project ID: ${project.id}\n- Exported: ${exportedAt}\n\n${characters.map(renderCharacterMarkdown).join("\n")}`;
  await shareTextFile(libraryFileName(project.title, "Characters", format), content, format, "Export characters");
}

export async function exportWorldInfo(
  project: Project,
  worldInfo: WorldInfo,
  entries: WorldInfoEntry[],
  format: LibraryExportFormat,
): Promise<void> {
  if (!entries.length) throw new Error("There are no world book entries to export");
  const exportedAt = new Date().toISOString();
  const content = format === "json"
    ? JSON.stringify({ schemaVersion: "1.0", type: "openficm.world-info", projectId: project.id, exportedAt, worldInfo, entries }, null, 2)
    : `# ${project.title} · ${worldInfo.name}\n\n- Project ID: ${project.id}\n- World book ID: ${worldInfo.id}\n- Exported: ${exportedAt}\n\n${worldInfo.description ? `${worldInfo.description}\n\n` : ""}${entries.map(renderWorldEntryMarkdown).join("\n")}`;
  await shareTextFile(libraryFileName(project.title, "World book", format), content, format, "Export world book");
}

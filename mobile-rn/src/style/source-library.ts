import * as DocumentPicker from "expo-document-picker";
import { Directory, File, Paths } from "expo-file-system";
import { Buffer } from "buffer";
import { unzipSync } from "fflate";
import { XMLParser } from "fast-xml-parser";
import iconv from "iconv-lite";

import {
  createStyleSource,
  deleteStyleSourceRecord,
  findStyleSourceByHash,
  getStyleSource,
} from "@/data/style-repositories";
import { createId } from "@/lib/id";
import { sha256File } from "@/lib/sha256";
import {
  ANALYSIS_PASSAGE_COUNT,
  describeWindow,
  nextSampleWindow,
  spreadIndices,
  type StyleSampleWindow,
  type StyleUnitKind,
} from "@/style/sampling";
import type { StyleSource, StyleSourceFormat } from "@/types";

export { nextSampleWindow } from "@/style/sampling";
export type { StyleSampleWindow, StyleUnitKind } from "@/style/sampling";

const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
const MAX_EXTRACTED_CHARACTERS = 8_000_000;
const MAX_EPUB_TEXT_ENTRY_BYTES = 4 * 1024 * 1024;
const MAX_EPUB_TOTAL_TEXT_BYTES = 20 * 1024 * 1024;
const ANALYSIS_PASSAGE_CHARACTERS = 1_400;
const ANALYSIS_BATCH_SIZE = 6;
const MIN_CHAPTER_HEADING_COUNT = 8;
const CHAPTER_HEADING_PATTERN = /^[ \t]{0,4}(?:第[0-9零〇一二两三四五六七八九十百千万]+[章节回][^\n]{0,60}|(?:chapter|chap\.?)\s*\d+[^\n]{0,60})[ \t]*$/gim;
const LIBRARY_DIRECTORY_NAME = "style-library";

export interface StyleAnalysisBatch {
  label: string;
  passageCount: number;
  text: string;
}

export interface StyleAnalysisPlan {
  unitKind: StyleUnitKind;
  totalUnits: number;
  window: StyleSampleWindow | null;
  windowLabel: string;
  batches: StyleAnalysisBatch[];
  passageCount: number;
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: false,
});

const xhtmlParser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  preserveOrder: true,
  parseTagValue: false,
  trimValues: false,
});

function libraryDirectory(): Directory {
  const directory = new Directory(Paths.document, LIBRARY_DIRECTORY_NAME);
  directory.create({ idempotent: true, intermediates: true });
  return directory;
}

function contentFile(sourceId: string): File {
  return new File(libraryDirectory(), `${sourceId}.content.txt`);
}

function extensionOf(fileName: string): string {
  const match = /\.([^.]+)$/.exec(fileName.trim());
  return match?.[1]?.toLowerCase() ?? "";
}

function formatForExtension(extension: string): StyleSourceFormat {
  if (extension === "txt") return "txt";
  if (extension === "md" || extension === "markdown") return "markdown";
  if (extension === "epub") return "epub";
  throw new Error("Only TXT, Markdown and EPUB files are supported");
}

function decodeText(bytes: Uint8Array): string {
  const buffer = Buffer.from(bytes);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return iconv.decode(buffer.subarray(3), "utf8");
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return iconv.decode(buffer.subarray(2), "utf16-le");
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return iconv.decode(buffer.subarray(2), "utf16-be");
  const utf8 = iconv.decode(buffer, "utf8");
  const utf8ReplacementCount = (utf8.match(/\uFFFD/g) ?? []).length;
  if (utf8ReplacementCount === 0) return utf8;
  const gb18030 = iconv.decode(buffer, "gb18030");
  const gbReplacementCount = (gb18030.match(/\uFFFD/g) ?? []).length;
  return gbReplacementCount < utf8ReplacementCount ? gb18030 : utf8;
}

function normalizeText(value: string): string {
  return value
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\t\u00A0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function archivePath(basePath: string, relativePath: string): string {
  const decoded = decodeURIComponent(relativePath.split("#")[0]);
  const parts = `${basePath}/${decoded}`.split("/");
  const normalized: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") normalized.pop();
    else normalized.push(part);
  }
  return normalized.join("/");
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function findArchiveEntry(entries: Record<string, Uint8Array>, path: string): Uint8Array | null {
  if (entries[path]) return entries[path];
  const lowerPath = path.toLowerCase();
  const key = Object.keys(entries).find((candidate) => candidate.toLowerCase() === lowerPath);
  return key ? entries[key] : null;
}

function collectMarkupText(value: unknown, output: string[], parentKey = ""): void {
  if (typeof value === "string" || typeof value === "number") {
    const text = String(value).trim();
    if (text) output.push(text);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectMarkupText(item, output, parentKey);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (["script", "style", "head", "svg", "nav"].includes(key.toLowerCase())) continue;
    collectMarkupText(item, output, key);
    if (/^(p|div|section|article|h[1-6]|li|blockquote|br)$/i.test(key) && parentKey !== key) output.push("\n");
  }
}

function fallbackMarkupText(value: string): string {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&(nbsp|amp|lt|gt|quot|apos);/gi, (_match, entity: string) => ({
      nbsp: " ",
      amp: "&",
      lt: "<",
      gt: ">",
      quot: '"',
      apos: "'",
    })[entity.toLowerCase()] ?? " ");
}

function extractMarkupText(value: string): string {
  try {
    const output: string[] = [];
    collectMarkupText(xhtmlParser.parse(value), output);
    const parsed = normalizeText(output.join(" "));
    if (parsed) return parsed;
  } catch {
    // Some EPUBs contain non-XML HTML; the bounded fallback still strips executable markup.
  }
  return normalizeText(fallbackMarkupText(value));
}

function extractEpub(bytes: Uint8Array): { title: string | null; text: string; skippedSections: number } {
  let totalTextBytes = 0;
  const entries = unzipSync(bytes, {
    filter: (entry) => {
      const normalizedName = entry.name.toLowerCase();
      const textEntry = normalizedName === "meta-inf/container.xml"
        || /\.(opf|xhtml|html|htm|xml|ncx)$/.test(normalizedName);
      if (!textEntry) return false;
      if (entry.originalSize > MAX_EPUB_TEXT_ENTRY_BYTES) throw new Error("An EPUB text entry exceeds the 4 MB limit");
      totalTextBytes += entry.originalSize;
      if (totalTextBytes > MAX_EPUB_TOTAL_TEXT_BYTES) throw new Error("EPUB extracted text exceeds the 20 MB limit");
      return true;
    },
  });
  const containerBytes = findArchiveEntry(entries, "META-INF/container.xml");
  if (!containerBytes) throw new Error("EPUB is missing META-INF/container.xml");
  const container = xmlParser.parse(decodeText(containerBytes)) as {
    container?: { rootfiles?: { rootfile?: { "full-path"?: string } | Array<{ "full-path"?: string }> } };
  };
  const rootfile = asArray(container.container?.rootfiles?.rootfile)[0];
  const packagePath = rootfile?.["full-path"];
  if (!packagePath) throw new Error("EPUB does not declare a content package");
  const packageBytes = findArchiveEntry(entries, packagePath);
  if (!packageBytes) throw new Error("EPUB content package not found");
  const packageDocument = xmlParser.parse(decodeText(packageBytes)) as {
    package?: {
      metadata?: { title?: string | string[] };
      manifest?: { item?: Array<{ id?: string; href?: string; "media-type"?: string }> | { id?: string; href?: string; "media-type"?: string } };
      spine?: { itemref?: Array<{ idref?: string }> | { idref?: string } };
    };
  };
  const packageRoot = packageDocument.package;
  if (!packageRoot) throw new Error("Invalid EPUB content package format");
  const basePath = packagePath.includes("/") ? packagePath.slice(0, packagePath.lastIndexOf("/")) : "";
  const manifest = new Map(
    asArray(packageRoot.manifest?.item)
      .filter((item) => item.id && item.href)
      .map((item) => [item.id as string, item]),
  );
  const spineItems = asArray(packageRoot.spine?.itemref);
  const sections: string[] = [];
  let skippedSections = 0;
  for (const itemref of spineItems) {
    const item = itemref.idref ? manifest.get(itemref.idref) : null;
    if (!item?.href) {
      // spine 引用了清单里不存在的条目：跳过但计数，导入完成后要告知用户书不完整。
      skippedSections += 1;
      continue;
    }
    const entry = findArchiveEntry(entries, archivePath(basePath, item.href));
    if (!entry) {
      skippedSections += 1;
      continue;
    }
    const section = extractMarkupText(decodeText(entry));
    if (section) sections.push(section);
    if (sections.reduce((total, value) => total + value.length, 0) > MAX_EXTRACTED_CHARACTERS) {
      throw new Error("EPUB extracted text exceeds the 8,000,000-character limit");
    }
  }
  const text = normalizeText(sections.join("\n\n"));
  if (!text) throw new Error("No readable text in the EPUB spine");
  const titleValue = asArray(packageRoot.metadata?.title)[0];
  return { title: typeof titleValue === "string" ? normalizeText(titleValue) : null, text, skippedSections };
}

function sourceTitle(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "").trim() || "Untitled reference book";
}

export async function importStyleSource(): Promise<StyleSource | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: "*/*",
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (result.canceled) return null;
  const asset = result.assets[0];
  const format = formatForExtension(extensionOf(asset.name));
  const inputFile = new File(asset.uri);
  const sizeBytes = asset.size ?? inputFile.size;
  if (!sizeBytes || sizeBytes > MAX_IMPORT_BYTES) throw new Error("The reference book file must be under 50 MB");
  const contentHash = await sha256File(inputFile);
  const duplicate = await findStyleSourceByHash(contentHash);
  if (duplicate) throw new Error(`"${duplicate.title}" is already in the reference book library`);
  const bytes = await inputFile.bytes();
  const extracted = format === "epub"
    ? extractEpub(bytes)
    : { title: null, text: normalizeText(decodeText(bytes)), skippedSections: 0 };
  if (!extracted.text) throw new Error("No readable text in the file");
  if (extracted.text.length > MAX_EXTRACTED_CHARACTERS) throw new Error("Text exceeds the 8,000,000-character limit");
  if (extracted.skippedSections > 0) {
    throw new Error(`EPUB has ${extracted.skippedSections} section(s) that cannot be parsed (manifest and spine disagree); the import was cancelled to avoid a reference book with missing chapters`);
  }
  const id = createId();
  const originalFile = new File(libraryDirectory(), `${id}.${extensionOf(asset.name)}`);
  const normalizedFile = contentFile(id);
  try {
    originalFile.create({ overwrite: true });
    originalFile.write(bytes);
    normalizedFile.create({ overwrite: true });
    normalizedFile.write(extracted.text);
    return await createStyleSource({
      id,
      title: extracted.title || sourceTitle(asset.name),
      fileName: asset.name,
      format,
      fileUri: originalFile.uri,
      sizeBytes,
      contentHash,
      characterCount: extracted.text.length,
    });
  } catch (error) {
    if (originalFile.exists) originalFile.delete();
    if (normalizedFile.exists) normalizedFile.delete();
    throw error;
  }
}

export async function readStyleSourceText(sourceId: string): Promise<string> {
  const source = await getStyleSource(sourceId);
  if (!source) throw new Error("Reference book not found");
  const file = contentFile(source.id);
  if (!file.exists) throw new Error("The reference book's text file is missing; import it again");
  return file.text();
}

type SourceOutline = {
  unitKind: StyleUnitKind;
  unitStarts: number[];
};

// 章节标题足够多时按章切分，否则退化为定长连续段落，两种情况都得到统一的"单元"序列。
function sourceOutline(text: string): SourceOutline {
  const chapterStarts = [...text.matchAll(CHAPTER_HEADING_PATTERN)]
    .map((match) => match.index ?? 0)
    .filter((start, index, values) => index === 0 || start > values[index - 1]);
  if (chapterStarts.length >= MIN_CHAPTER_HEADING_COUNT) {
    return { unitKind: "chapter", unitStarts: chapterStarts };
  }
  const unitStarts: number[] = [];
  for (let start = 0; start < text.length; start += ANALYSIS_PASSAGE_CHARACTERS) {
    const paragraphStart = text.lastIndexOf("\n", start);
    unitStarts.push(Math.max(0, paragraphStart >= start - 500 ? paragraphStart + 1 : start));
  }
  return { unitKind: "segment", unitStarts: unitStarts.length ? unitStarts : [0] };
}

function passageAt(text: string, outline: SourceOutline, index: number): string {
  const start = outline.unitStarts[index];
  if (start === undefined) return "";
  const nextStart = outline.unitStarts[index + 1] ?? text.length;
  return text.slice(start, Math.min(nextStart, start + ANALYSIS_PASSAGE_CHARACTERS)).trim();
}

function buildBatches(
  text: string,
  outline: SourceOutline,
  indices: number[],
  describe: (unitIndex: number) => string,
): StyleAnalysisBatch[] {
  const selected = indices
    .map((unitIndex) => ({ unitIndex, passage: passageAt(text, outline, unitIndex) }))
    .filter((item) => item.passage);
  if (!selected.length) throw new Error("The reference book has no analysable text");
  const batchCount = Math.ceil(selected.length / ANALYSIS_BATCH_SIZE);
  return Array.from({ length: batchCount }, (_, batchIndex) => {
    const offset = batchIndex * ANALYSIS_BATCH_SIZE;
    const items = selected.slice(offset, offset + ANALYSIS_BATCH_SIZE);
    return {
      label: `${items.length} samples starting at ${describe(items[0].unitIndex)}`,
      passageCount: items.length,
      text: items
        .map((item) => `[${describe(item.unitIndex)}]\n${item.passage}`)
        .join("\n\n"),
    };
  });
}

/**
 * window 优先：断点续跑时按记录的窗口原样重放。
 * 否则 coveredUntil 为 null 时按全书均匀分布抽样（Agent 工具的取样行为），
 * 传入数字时选出下一个连续窗口，供多轮"继续蒸馏"使用。
 */
export async function readStyleSourceAnalysisPlan(input: {
  sourceId: string;
  coveredUntil?: number | null;
  window?: StyleSampleWindow | null;
  random?: () => number;
}): Promise<StyleAnalysisPlan> {
  const text = await readStyleSourceText(input.sourceId);
  const outline = sourceOutline(text);
  const totalUnits = outline.unitStarts.length;
  const unitName = outline.unitKind === "chapter" ? "chapter" : "segment";
  const describe = (unitIndex: number) => `${unitName} ${unitIndex + 1}`;
  const buildPlan = (window: StyleSampleWindow | null): StyleAnalysisPlan => {
    const indices = window
      ? Array.from({ length: window.count }, (_, index) => window.start + index)
      : spreadIndices(totalUnits, ANALYSIS_PASSAGE_COUNT);
    const batches = buildBatches(text, outline, indices, describe);
    return {
      unitKind: outline.unitKind,
      totalUnits,
      window,
      windowLabel: window ? describeWindow(outline.unitKind, window) : "evenly across the whole book",
      batches,
      passageCount: batches.reduce((total, batch) => total + batch.passageCount, 0),
    };
  };
  if (input.window) {
    const start = Math.max(0, Math.min(Math.floor(input.window.start), Math.max(0, totalUnits - 1)));
    const count = Math.max(1, Math.min(Math.floor(input.window.count), totalUnits - start));
    return buildPlan({ start, count });
  }
  if (input.coveredUntil === null || input.coveredUntil === undefined) return buildPlan(null);
  const window = nextSampleWindow({
    totalUnits,
    coveredUntil: input.coveredUntil,
    random: input.random,
  });
  if (!window) {
    throw new Error(`Distillation has reached the end of the book (${totalUnits} ${unitName} in total). To rescan, tap "Restart".`);
  }
  return buildPlan(window);
}

export async function readStyleSourceSample(sourceId: string): Promise<string> {
  const plan = await readStyleSourceAnalysisPlan({ sourceId });
  return plan.batches.map((batch) => batch.text.slice(0, ANALYSIS_PASSAGE_CHARACTERS + 200)).join("\n\n");
}

export async function deleteStyleSource(sourceId: string): Promise<void> {
  const source = await getStyleSource(sourceId);
  if (!source) throw new Error("Reference book not found");
  await deleteStyleSourceRecord(source.id);
  const originalFile = new File(source.fileUri);
  const normalizedFile = contentFile(source.id);
  if (originalFile.exists) originalFile.delete();
  if (normalizedFile.exists) normalizedFile.delete();
}

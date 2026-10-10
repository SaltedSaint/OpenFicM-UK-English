import { Directory, File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { zipSync } from "fflate";

import { getDatabase } from "@/data/database";

function timestamp(): string {
  return new Date().toISOString().replace(/[.:]/g, "-").slice(0, 19);
}

function collectDirectoryFiles(directory: Directory, prefix: string, output: Record<string, Uint8Array>): void {
  for (const entry of directory.list()) {
    const name = entry.name;
    if (entry instanceof Directory) {
      collectDirectoryFiles(entry, `${prefix}${name}/`, output);
    } else if (entry instanceof File) {
      output[`${prefix}${name}`] = entry.bytesSync();
    }
  }
}

/**
 * 整库备份：把 SQLite 数据库和文风书库原始文件打成 zip，用系统分享面板发出去。
 * 恢复需要手动解压并把 openfic.db 放回应用数据目录，后续版本再做一键导入。
 */
export async function exportBackup(): Promise<void> {
  // 确保数据库连接已建立、WAL 已落盘到主库文件。
  const db = await getDatabase();
  await db.execAsync("PRAGMA wal_checkpoint(FULL)");

  const databaseFile = new File(Paths.document, "SQLite", "openfic.db");
  if (!databaseFile.exists) throw new Error("Database file not found");

  const entries: Record<string, Uint8Array> = {
    "openfic.db": databaseFile.bytesSync(),
  };
  const styleLibrary = new Directory(Paths.document, "style-library");
  if (styleLibrary.exists) {
    collectDirectoryFiles(styleLibrary, "style-library/", entries);
  }
  const manifest = {
    type: "openficm.backup",
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    note: "To restore: unzip, close the app, put openfic.db back under SQLite/ in the app data directory and style-library/ back in the app data directory.",
  };
  entries["manifest.json"] = new TextEncoder().encode(JSON.stringify(manifest, null, 2));

  const zipped = zipSync(entries, { level: 6 });
  const zipFile = new File(Paths.cache, `OpenFicM-backup-${timestamp()}.zip`);
  if (zipFile.exists) zipFile.delete();
  zipFile.write(zipped);

  if (!(await Sharing.isAvailableAsync())) throw new Error("This device does not support system sharing");
  await Sharing.shareAsync(zipFile.uri, {
    mimeType: "application/zip",
    dialogTitle: "Export OpenFicM backup",
  });
}

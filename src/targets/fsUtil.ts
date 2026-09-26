import { promises as fs } from "node:fs";
import * as path from "node:path";

export const BACKUP_SUFFIX = ".key-clarity-backup";

export async function readIfExists(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/**
 * Writes via a temp file and rename so a crash never leaves a half-written config.
 * Keeps the existing file's permissions unless `mode` is given.
 */
export async function atomicWrite(file: string, content: string, mode?: number): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  let fileMode = mode;
  if (fileMode === undefined) {
    try {
      fileMode = (await fs.stat(file)).mode & 0o777;
    } catch {
      fileMode = 0o644;
    }
  }
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, content, { encoding: "utf8", mode: fileMode });
  try {
    await fs.chmod(tmp, fileMode);
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

/** Copies `file` to `file + BACKUP_SUFFIX` the first time only, so the backup holds the pre-Key Clarity state. */
export async function backupOnce(file: string): Promise<string | undefined> {
  const backup = file + BACKUP_SUFFIX;
  try {
    await fs.copyFile(file, backup, fs.constants.COPYFILE_EXCL);
    return backup;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ENOENT") return undefined;
    throw err;
  }
}

import fs from "node:fs";
import path from "node:path";

/**
 * Whether the volume `dir` sits on treats two spellings that differ
 * only in case as one entry, MEASURED on that volume rather than
 * assumed from the platform: macOS is case-insensitive by default but
 * can carry a case-sensitive APFS volume, and a Linux host can mount a
 * case-insensitive one.
 *
 * Every test about a case-variant spelling asks this first and asserts
 * the branch it reports. On a case-insensitive volume the variant names
 * the SAME directory (which is what makes it dangerous: the link policy
 * compares path strings while the syscalls resolve entries); on a
 * case-sensitive one it names a different directory that simply is not
 * there, and the interesting behaviour has nothing to act on.
 */
export function caseInsensitiveVolume(dir: string): boolean {
  const probe = path.join(dir, "AaCaseProbe");
  fs.mkdirSync(probe);
  try {
    return fs.existsSync(path.join(dir, "aAcASEpROBE"));
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
}

import { IntakeError } from "./errors.js";

export interface SecretPattern {
  /** Stable name; it is the only thing an error says about the match. */
  name: string;
  re: RegExp;
}

/**
 * Patterns that refuse a ticket file before anything is written. Each is
 * tested once, and a near-miss of every one must not trip: the GitHub token
 * body length, the AWS key length, the quoted-value length and the generic
 * assignment word set are what separate a hit from a near-miss.
 *
 * The generic pattern finds a keyword anywhere inside the key (`DB_PASSWORD`,
 * `AWS_SECRET_ACCESS_KEY`, `access_token`, `apiKey`, `api-key`), allows a
 * closing quote after the key (`"password": "..."`) and wants a quoted value
 * of 12 or more characters. Every run is bounded, so a long line cannot make
 * the scan slow.
 */
export const SECRET_PATTERNS: readonly SecretPattern[] = [
  {
    name: "private-key",
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/,
  },
  { name: "aws-access-key-id", re: /AKIA[0-9A-Z]{16}/ },
  {
    name: "github-token",
    re: /(?:gh[posur]_|github_pat_)[A-Za-z0-9_]{20,}/,
  },
  { name: "slack-token", re: /xox[abpr]-/ },
  {
    name: "secret-assignment",
    re: /(?:password|secret|token|api[_-]?key)[\w-]{0,40}["']?[ \t]{0,64}[:=][ \t]{0,64}["'][^"']{12,4096}["']/i,
  },
];

export interface SecretHit {
  pattern: string;
  /** 1-based line of the file. */
  line: number;
}

/** The first secret in the text, or null. The matched value is not kept. */
export function findSecret(text: string): SecretHit | null {
  const lines = text.split(/\r\n|\n|\r/);
  for (const [i, line] of lines.entries()) {
    for (const p of SECRET_PATTERNS) {
      if (p.re.test(line)) return { pattern: p.name, line: i + 1 };
    }
  }
  return null;
}

/**
 * The scan reads UTF-8 text. A UTF-16 file (a byte order mark, or NUL bytes
 * between the characters) would pass it unseen, so such input is refused
 * with a named error instead of being scanned as garbage.
 */
export function assertScannableText(bytes: Buffer, shown: string): void {
  const utf16Bom =
    bytes.length >= 2 &&
    ((bytes[0] === 0xff && bytes[1] === 0xfe) ||
      (bytes[0] === 0xfe && bytes[1] === 0xff));
  if (utf16Bom || bytes.includes(0)) {
    throw new IntakeError(
      "source-encoding",
      `${JSON.stringify(shown)} is not UTF-8 text (a UTF-16 byte order mark or a NUL byte was found); convert it to UTF-8 first`,
    );
  }
}

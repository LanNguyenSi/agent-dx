import type { Finding, Severity } from "./types.js";

export interface Summary {
  errors: number;
  warnings: number;
  notices: number;
}

export function summarize(findings: Finding[]): Summary {
  const summary: Summary = { errors: 0, warnings: 0, notices: 0 };
  for (const finding of findings) {
    if (finding.severity === "error") summary.errors++;
    else if (finding.severity === "warning") summary.warnings++;
    else summary.notices++;
  }
  return summary;
}

export function renderText(bundleDir: string, findings: Finding[]): string {
  if (findings.length === 0) {
    return `okf-kit: clean, no findings in ${bundleDir}\n`;
  }

  const byFile = new Map<string, Finding[]>();
  for (const finding of findings) {
    const group = byFile.get(finding.file);
    if (group) group.push(finding);
    else byFile.set(finding.file, [finding]);
  }

  const lines: string[] = [];
  for (const [file, group] of byFile) {
    for (const finding of group) {
      lines.push(
        `${severityLabel(finding.severity)} ${finding.ruleId} ${file}: ${finding.message}`,
      );
      if (finding.detail) lines.push(`  ${finding.detail}`);
    }
  }

  const summary = summarize(findings);
  lines.push(
    `${findings.length} findings (errors ${summary.errors}, warnings ${summary.warnings}, notices ${summary.notices})`,
  );
  return lines.join("\n") + "\n";
}

export function renderJson(bundleDir: string, findings: Finding[]): string {
  const summary = summarize(findings);
  return JSON.stringify({ bundleDir, findings, summary }, null, 2) + "\n";
}

function severityLabel(s: Severity): string {
  switch (s) {
    case "error":
      return "ERROR ";
    case "warning":
      return "WARN  ";
    case "notice":
      return "NOTICE";
  }
}

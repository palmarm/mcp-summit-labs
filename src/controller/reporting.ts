import type { Report } from "./model.js";

export function formatTerminal(report: Report): string {
  const lines = [
    `Deployment readiness: ${report.state.toUpperCase()} (${report.source})`,
    "Thresholds: warning >=75%, critical >=90% (unrounded percentages).",
  ];
  for (const check of report.checks) {
    const metric = check.metric;
    lines.push(`  ${check.tool}: ${check.state.toUpperCase()}${metric
      ? ` — ${metric.utilizationPercent.toFixed(2)}% used (${metric.usedBytes}/${metric.totalBytes} bytes)`
      : check.state === "healthy" ? " — structured response validated; host details omitted" : ""}`);
  }
  for (const error of report.failures) lines.push(`  ${error.kind}${error.tool ? ` (${error.tool})` : ""}: ${error.message}`);
  lines.push(`Memory metric: ${report.metricDefinitions.memory}`, `Disk metric: ${report.metricDefinitions.disk}`,
    `Policy: ${report.metricDefinitions.policy}`, `Exit code: ${report.exitCode}`);
  return lines.join("\n") + "\n";
}

export function formatJson(report: Report): string {
  return JSON.stringify(report, null, 2) + "\n";
}

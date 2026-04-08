const { loadConfig } = require("../config/loader");

type OutputFormat = "text" | "json" | "yaml";

interface RunOptions {
  config?: string;
  dryRun: boolean;
  output: OutputFormat;
  verbose: boolean;
}

function registerRunCommand(program: import("commander").Command): void {
  program
    .command("run")
    .description("Execute the primary action")
    .argument("[target]", "Optional target to operate on", "default")
    .option("--config <path>", "Override config file path")
    .option("--dry-run", "Preview without making changes", false)
    .option("-o, --output <format>", "Output format: text or json", "text")
    .option("-v, --verbose", "Enable verbose diagnostics", false)
    .action(async (target: string, options: RunOptions) => {
      const config = await loadConfig(options.config);
      const payload = {
        command: "run",
        target,
        dryRun: options.dryRun,
        output: options.output,
        verbose: options.verbose,
        configPath: config.path,
        settings: config.settings
      };

      if (options.output === "json") {
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        return;
      }

      process.stdout.write(
        `command=run target=${payload.target} dryRun=${String(payload.dryRun)} config=${payload.configPath || "-"}\n`
      );
    });
}

module.exports = { registerRunCommand };

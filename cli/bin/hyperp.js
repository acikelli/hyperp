#!/usr/bin/env node

const { Command } = require("commander");
const { deploy } = require("./commands/deploy");
const { destroy } = require("./commands/destroy");
const { listRuns } = require("./commands/list-runs");
const path = require("path");
const fs = require("fs");

// Read version from package.json (try multiple possible locations)
function getVersion() {
  const possiblePaths = [
    path.join(__dirname, "../../package.json"), // From npm package
    path.join(__dirname, "../../../package.json"), // From npm package (alternative)
    path.join(__dirname, "../../../../package.json"), // From npm package (another alternative)
  ];

  for (const pkgPath of possiblePaths) {
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
        return pkg.version || "1.0.0";
      } catch (e) {
        // Continue to next path
      }
    }
  }
  return "1.0.0"; // Fallback
}

const program = new Command();

program
  .name("hyperp")
  .description(
    "CLI tool for Hyperp - Fully automated pay-as-you-go compute platform"
  )
  .version(getVersion());

program
  .command("deploy")
  .description("Deploy the Hyperp stack")
  .option("--github-app-id <appId>", "GitHub App ID")
  .option("--github-app-webhook-secret <secret>", "GitHub App webhook secret")
  .action(async (options) => {
    await deploy(options);
  });

program
  .command("destroy")
  .description("Destroy the deployed Hyperp stack")
  .action(async () => {
    await destroy();
  });

program
  .command("list-runs")
  .description("List workflow runs (last 10 by default, or by commit hash)")
  .option("--commit-hash <commitHash>", "Filter workflow runs by commit hash")
  .action(async (options) => {
    await listRuns(options.commitHash);
  });

program.parse();

const { execSync } = require("child_process");
const path = require("path");

async function destroy() {
  console.log("🗑️  Destroying Hyperp stack...\n");

  try {
    const projectRoot = path.resolve(__dirname, "../../..");

    console.log("Running CDK destroy...");
    execSync("cdk destroy --force", {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: "inherit",
    });

    console.log("\n✅ Stack destroyed!");
  } catch (error) {
    console.error("\n❌ Destroy failed:", error.message);
    process.exit(1);
  }
}

module.exports = { destroy };


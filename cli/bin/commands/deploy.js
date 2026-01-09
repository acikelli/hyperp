const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const CONFIG_DIR = path.join(os.homedir(), ".hyperp");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function saveConfig(config) {
  ensureConfigDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function loadConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  }
  return {};
}

async function deploy(options = {}) {
  console.log("🚀 Deploying Hyperp stack...\n");

  // Validate required options
  if (!options.githubAppId) {
    console.error("❌ Error: --github-app-id is required");
    process.exit(1);
  }

  if (!options.githubAppWebhookSecret) {
    console.error("❌ Error: --github-app-webhook-secret is required");
    process.exit(1);
  }

  // Save to config
  const config = loadConfig();
  config.githubAppId = options.githubAppId;
  config.githubAppWebhookSecret = options.githubAppWebhookSecret;
  saveConfig(config);
  console.log("✅ Saved GitHub App configuration to ~/.hyperp/config.json\n");

  try {
    // Get the project root (assuming CLI is in cli/bin, project root is 3 levels up)
    const projectRoot = path.resolve(__dirname, "../../..");

    // Build CDK context with GitHub App configuration
    const cdkContext = {
      githubAppId: options.githubAppId,
      githubAppWebhookSecret: options.githubAppWebhookSecret,
    };

    // Run cdk deploy with context
    console.log("Running CDK deploy...");
    const contextArgs = Object.entries(cdkContext)
      .map(([key, value]) => `-c ${key}=${value}`)
      .join(" ");
    execSync(`cdk deploy --require-approval never ${contextArgs}`, {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: "inherit",
    });

    // Extract Function URLs and S3 bucket name from AWS CloudFormation stack outputs
    console.log("\n📋 Extracting Function URLs from stack outputs...");
    let apiUrl = null;
    let webhookUrl = null;
    let s3BucketName = null;

    // Wait a moment for CloudFormation outputs to be available
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Try multiple methods to get the stack name
    let stackName = null;
    try {
      // Method 1: Try cdk list
      const cdkListOutput = execSync("cdk list", {
        cwd: projectRoot,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      if (cdkListOutput) {
        stackName = cdkListOutput.split("\n")[0].trim(); // Get first stack name
        console.log(`   Found stack name via cdk list: ${stackName}`);
      }
    } catch (err) {
      // Method 2: Try to find stack from CloudFormation
      try {
        const stacksOutput = execSync(
          `aws cloudformation list-stacks --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE --query "StackSummaries[?contains(StackName, 'Hyperp') || contains(StackName, 'hyperp')].StackName" --output text`,
          { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
        ).trim();
        if (stacksOutput) {
          const stacks = stacksOutput.split(/\s+/).filter((s) => s.length > 0);
          stackName = stacks[0];
          console.log(`   Found stack name via CloudFormation: ${stackName}`);
        }
      } catch (err2) {
        // Method 3: Try to get from CDK context or use default
        try {
          // Read cdk.json to get stack name
          const cdkJsonPath = path.join(projectRoot, "cdk.json");
          if (fs.existsSync(cdkJsonPath)) {
            const cdkJson = JSON.parse(fs.readFileSync(cdkJsonPath, "utf8"));
            if (cdkJson.app && cdkJson.app.includes("hyperp-stack")) {
              stackName = "HyperpStack";
            }
          }
          if (!stackName) {
            stackName = "HyperpStack"; // Default stack name
          }
          console.log(`   Using default stack name: ${stackName}`);
        } catch (err3) {
          console.warn(
            "⚠️  Could not determine stack name, will try direct Lambda queries"
          );
        }
      }
    }

    // Get CLI REST API URL
    if (stackName) {
      try {
        const cfOutput = execSync(
          `aws cloudformation describe-stacks --stack-name ${stackName} --query "Stacks[0].Outputs[?OutputKey=='CliRestApiUrl'].OutputValue" --output text`,
          { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
        ).trim();
        if (cfOutput && cfOutput !== "None") {
          apiUrl = cfOutput;
        }
      } catch (err) {
        // Fall through to Lambda direct method
      }
    }

    // Fallback: Try to get it from Lambda directly
    if (!apiUrl) {
      try {
        const awsOutput = execSync(
          `aws lambda get-function-url-config --function-name hyperp-cli-rest-api --query FunctionUrl --output text`,
          { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
        ).trim();
        if (awsOutput && awsOutput !== "None") {
          apiUrl = awsOutput;
        }
      } catch (err2) {
        // Will show warning below
      }
    }

    // Get GitHub Webhook Handler URL
    if (stackName) {
      try {
        const webhookOutput = execSync(
          `aws cloudformation describe-stacks --stack-name ${stackName} --query "Stacks[0].Outputs[?OutputKey=='GithubWebhookHandlerUrl'].OutputValue" --output text`,
          { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
        ).trim();
        if (webhookOutput && webhookOutput !== "None") {
          webhookUrl = webhookOutput;
        }
      } catch (err) {
        // Fall through to Lambda direct method
      }
    }

    // Fallback: Try to get it from Lambda directly
    if (!webhookUrl) {
      try {
        const awsOutput = execSync(
          `aws lambda get-function-url-config --function-name hyperp-github-webhook-handler --query FunctionUrl --output text`,
          { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
        ).trim();
        if (awsOutput && awsOutput !== "None") {
          webhookUrl = awsOutput;
        }
      } catch (err2) {
        // Will show warning below
      }
    }

    // Get S3 Bucket Name
    if (stackName) {
      try {
        const s3BucketOutput = execSync(
          `aws cloudformation describe-stacks --stack-name ${stackName} --query "Stacks[0].Outputs[?OutputKey=='S3BucketName'].OutputValue" --output text`,
          { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
        ).trim();
        if (s3BucketOutput && s3BucketOutput !== "None") {
          s3BucketName = s3BucketOutput;
        }
      } catch (err) {
        // Fall through
      }
    }

    // Display Function URLs
    console.log("\n" + "=".repeat(60));
    console.log("📋 Deployment Outputs");
    console.log("=".repeat(60));

    if (webhookUrl) {
      console.log("\n🔗 GitHub Webhook Handler URL:");
      console.log(`   ${webhookUrl}`);
      console.log("\n   ⚠️  IMPORTANT: Configure your GitHub App webhook URL:");
      console.log(`   ${webhookUrl}`);

      // Save webhook URL to config
      const config = loadConfig();
      config.webhookUrl = webhookUrl;
      saveConfig(config);
    } else {
      console.log("\n⚠️  GitHub Webhook Handler URL not found");
      console.log("   Trying to fetch it directly from Lambda...");
      try {
        const directUrl = execSync(
          `aws lambda get-function-url-config --function-name hyperp-github-webhook-handler --query FunctionUrl --output text 2>/dev/null || echo ""`,
          { encoding: "utf8", shell: true }
        ).trim();
        if (directUrl && directUrl.length > 0 && !directUrl.includes("error")) {
          webhookUrl = directUrl;
          console.log(`\n✅ Found GitHub Webhook Handler URL:`);
          console.log(`   ${webhookUrl}`);
          const config = loadConfig();
          config.webhookUrl = webhookUrl;
          saveConfig(config);
        } else {
          console.log("   Get it manually with:");
          console.log(
            "   aws lambda get-function-url-config --function-name hyperp-github-webhook-handler --query FunctionUrl --output text"
          );
        }
      } catch (err) {
        console.log("   Get it manually with:");
        console.log(
          "   aws lambda get-function-url-config --function-name hyperp-github-webhook-handler --query FunctionUrl --output text"
        );
      }
    }

    if (apiUrl) {
      const config = loadConfig();
      config.apiUrl = apiUrl;
      saveConfig(config);
      console.log("\n🔗 CLI REST API URL:");
      console.log(`   ${apiUrl}`);
      console.log("   ✅ Saved to ~/.hyperp/config.json");
    } else {
      console.log("\n⚠️  CLI REST API URL not found");
      console.log("   Get it manually with:");
      console.log(
        "   aws lambda get-function-url-config --function-name hyperp-cli-rest-api"
      );
    }

    // Display S3 Bucket and upload command
    if (s3BucketName) {
      console.log("\n📦 S3 Artifacts Bucket:");
      console.log(`   ${s3BucketName}`);
      console.log("\n   📤 Upload your GitHub App private key:");
      console.log(`   aws s3 cp githubappkey.pem s3://${s3BucketName}/githubappkey.pem`);
    } else {
      console.log("\n⚠️  S3 Bucket Name not found");
      if (stackName) {
        console.log("   Get it manually with:");
        console.log(
          `   aws cloudformation describe-stacks --stack-name ${stackName} --query "Stacks[0].Outputs[?OutputKey=='S3BucketName'].OutputValue" --output text`
        );
      }
    }

    console.log("\n" + "=".repeat(60));
    console.log("\n✅ Deployment complete!");
  } catch (error) {
    console.error("\n❌ Deployment failed:", error.message);
    process.exit(1);
  }
}

module.exports = { deploy };

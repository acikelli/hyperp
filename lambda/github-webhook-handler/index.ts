import {
  DynamoDBClient,
  PutItemCommand,
  QueryCommand,
  DeleteItemCommand,
  GetItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import {
  ECSClient,
  RegisterTaskDefinitionCommand,
  RunTaskCommand,
  RunTaskCommandOutput,
  NetworkMode,
  LaunchType,
  LogDriver,
  AssignPublicIp,
  Compatibility,
} from "@aws-sdk/client-ecs";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import GithubHelper from "./githubHelper";
import * as yaml from "yaml";
import * as crypto from "crypto";

// ============================================
// Types
// ============================================
interface WorkflowYaml {
  branches: string[];
  workflowName: string;
  workflowDescription?: string;
  artifacts?: {
    shared?: Array<{
      name: string;
    }>;
  };
  jobs: JobDefinition[];
}

interface JobDefinition {
  jobName: string;
  jobDescription?: string;
  taskDefinitionPath: string;
  runTaskPath?: string;
  concurrency?: number;
  dependsOn?: string[];
  downloadable?: boolean;
  imageBuildResources?: {
    cpu: string;
    memory: string;
  };
}

// ============================================
// Utility Functions
// ============================================
function generateHash(input: string): string {
  return crypto
    .createHash("sha256")
    .update(input)
    .digest("hex")
    .substring(0, 16);
}

function generateRunId(): string {
  // Generate a unique run ID using timestamp and random bytes
  const timestamp = Date.now().toString(36);
  const randomBytes = crypto.randomBytes(4).toString("hex");
  return `${timestamp}${randomBytes}`;
}

function extractBranchName(ref: string): string {
  return ref.replace("refs/heads/", "");
}

function branchMatches(branch: string, workflowBranches: string[]): boolean {
  return workflowBranches.some((wb) => {
    if (wb.includes("*")) {
      const regex = new RegExp("^" + wb.replace(/\*/g, ".*") + "$");
      return regex.test(branch);
    }
    return wb === branch;
  });
}

function extractDockerfilePaths(taskDef: any): string[] {
  const paths: string[] = [];
  if (taskDef.containerDefinitions) {
    for (const container of taskDef.containerDefinitions) {
      if (container.dockerfilePath) {
        paths.push(container.dockerfilePath);
      }
    }
  }
  return paths;
}

function hasMatchingFiles(files: string[], paths: string[]): boolean {
  return files.some((file) => paths.some((path) => file.includes(path)));
}

/**
 * Checks if a file path matches a single dockerignore pattern
 * @param {string} filePath - The file path to check
 * @param {string} pattern - The dockerignore pattern
 * @returns {boolean} - True if the path matches the pattern
 */
function matchPattern(filePath: string, pattern: string): boolean {
  const isRootAnchored = pattern.startsWith("/");
  const isDirectory = pattern.endsWith("/");
  // Patterns ending with /* should match files inside the directory
  const isDirectoryWildcard = pattern.endsWith("/*");

  // Remove leading/trailing slashes for processing
  let cleanPattern = pattern.replace(/^\//, "").replace(/\/$/, "");

  // If pattern ends with /*, remove the /* and treat as directory pattern
  if (isDirectoryWildcard) {
    cleanPattern = cleanPattern.replace(/\/\*$/, "");
  }

  // Convert pattern to regex
  // Order matters: handle **/ and /** before ** and *
  let regexPattern = cleanPattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "(?:.*\\/)*") // **/ matches zero or more directories (use * not ?)
    .replace(/\/\*\*/g, "(?:\\/.*)*") // /** matches zero or more directories
    .replace(/\*\*/g, ".*") // ** matches any characters including /
    .replace(/\*/g, "[^\\/]*") // * matches any characters except /
    .replace(/\?/g, "[^\\/]"); // ? matches a single character except /

  // For patterns starting with **/, they can match from the beginning (including nothing)
  // The (?:.*\\/)* already handles matching zero or more directories at the start
  if (isRootAnchored) {
    regexPattern = "^" + regexPattern;
  } else if (pattern.startsWith("**/")) {
    // **/ at start means it can match from beginning (including nothing)
    // Since we already replaced **/ with (?:.*\\/)*, we just need to anchor it
    regexPattern = "^" + regexPattern;
  } else {
    // Pattern doesn't start with **/, so it must match from start or after /
    regexPattern = "(?:^|\\/)" + regexPattern;
  }

  // For directory patterns (ending with /) or directory wildcard patterns (ending with /*)
  // match files inside the directory
  if (isDirectory || isDirectoryWildcard) {
    // Match the directory path followed by / and then any file
    regexPattern += "\\/[^\\/]+";
  }

  regexPattern += "$";

  const regex = new RegExp(regexPattern);
  const matches = regex.test(filePath);
  console.log(
    `Pattern "${pattern}" -> regex "${regexPattern}" matches "${filePath}": ${matches}`
  );
  return matches;
}

/**
 * Checks if a single file path should be ignored based on dockerignore patterns
 * @param {string} filePath - The file path to check
 * @param {string[]} ignorePatterns - Array of dockerignore pattern lines
 * @returns {boolean} - True if the file should be ignored, false otherwise
 */
function isFileIgnored(filePath: string, ignorePatterns: string[]): boolean {
  // Parse and clean patterns
  const patterns = ignorePatterns
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#")); // Remove empty lines and comments

  let isIgnored = false;

  // Process patterns in order (later patterns can override earlier ones)
  for (const pattern of patterns) {
    const isNegation = pattern.startsWith("!");
    const cleanPattern = isNegation ? pattern.slice(1) : pattern;

    const matches = matchPattern(filePath, cleanPattern);
    if (matches) {
      console.log(
        `Pattern "${pattern}" matches file "${filePath}" (negation: ${isNegation})`
      );
      isIgnored = !isNegation; // Negation flips the ignore status
    }
  }

  return isIgnored;
}

// ============================================
// Main Handler
// ============================================
const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const ecsClient = new ECSClient({ region: process.env.AWS_REGION });
const lambdaClient = new LambdaClient({ region: process.env.AWS_REGION });

const TABLE_NAME = process.env.DYNAMODB_TABLE_NAME!;
const ECS_CLUSTER = process.env.ECS_CLUSTER_NAME!;
const ECR_REPOSITORY_URI = process.env.ECR_REPOSITORY_URI!;
const ECS_TASK_EXECUTION_ROLE_ARN = process.env.ECS_TASK_EXECUTION_ROLE_ARN!;
const ECS_TASK_ROLE_ARN = process.env.ECS_TASK_ROLE_ARN!;
const EFS_FILE_SYSTEM_ID = process.env.EFS_FILE_SYSTEM_ID!;
const ECS_TASK_SECURITY_GROUP_ID = process.env.ECS_TASK_SECURITY_GROUP_ID!;
const PUBLIC_SUBNET_IDS = process.env.PUBLIC_SUBNET_IDS!.split(",");
const EFS_CONTROLLER_LAMBDA_ARN = process.env.EFS_CONTROLLER_LAMBDA_ARN!;
const AWS_ACCOUNT_ID = process.env.AWS_ACCOUNT_ID!;

// ============================================
// GitHub Webhook Signature Validation
// ============================================
function verifyGitHubWebhookSignature(
  payload: string,
  signature: string,
  secret: string
): boolean {
  if (!signature || !secret) {
    return false;
  }

  // GitHub sends signature as "sha256=<hash>"
  const signatureHash = signature.replace("sha256=", "");
  const expectedHash = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex");

  // Use timing-safe comparison to prevent timing attacks
  return crypto.timingSafeEqual(
    Buffer.from(signatureHash, "hex"),
    Buffer.from(expectedHash, "hex")
  );
}

export const handler = async (event: any): Promise<any> => {
  console.log("GitHub Webhook received");

  try {
    // Get webhook secret from environment
    const webhookSecret = process.env.GITHUB_APP_WEBHOOK_SECRET;

    // Get signature from headers (Function URL format)
    // Function URLs pass headers in event.headers (lowercase keys)
    // API Gateway passes headers in event.headers (case-sensitive) or event.multiValueHeaders
    let signature: string | undefined;
    if (event.headers) {
      // Try lowercase first (Function URL format)
      signature =
        event.headers["x-hub-signature-256"] ||
        event.headers["X-Hub-Signature-256"];
    }
    if (!signature && event.requestContext?.http?.headers) {
      signature =
        event.requestContext.http.headers["x-hub-signature-256"] ||
        event.requestContext.http.headers["X-Hub-Signature-256"];
    }

    // Get raw body for signature verification
    // For Function URLs, body is already a string
    // For API Gateway, body might be base64 encoded
    let rawBody: string;
    if (typeof event.body === "string") {
      rawBody = event.body;
    } else if (event.isBase64Encoded) {
      rawBody = Buffer.from(event.body, "base64").toString("utf8");
    } else {
      rawBody = JSON.stringify(event.body);
    }

    // Validate webhook signature if secret is configured
    if (webhookSecret) {
      if (!signature) {
        console.error("Missing X-Hub-Signature-256 header");
        return {
          statusCode: 401,
          body: JSON.stringify({ error: "Missing signature" }),
        };
      }

      if (!verifyGitHubWebhookSignature(rawBody, signature, webhookSecret)) {
        console.error("Invalid webhook signature");
        return {
          statusCode: 401,
          body: JSON.stringify({ error: "Invalid signature" }),
        };
      }

      console.log("✅ Webhook signature validated");
    } else {
      console.warn(
        "⚠️  GITHUB_APP_WEBHOOK_SECRET not set, skipping signature validation"
      );
    }

    const body =
      typeof event.body === "string" ? JSON.parse(event.body) : event;

    // Extract data from webhook
    const installationId = body.installation.id.toString();
    const repositoryId = body.repository.id.toString();
    const repositoryFullName = body.repository.full_name;
    const [owner, repo] = repositoryFullName.split("/");
    const branch = extractBranchName(body.ref);
    const commitHash = body.after;
    const commits = body.commits || [];

    console.log(
      `Processing commit ${commitHash} on branch ${branch} for ${repositoryFullName}`
    );

    // Create installation access token
    const accessTokenData = await GithubHelper.createInstallationAccessToken(
      installationId
    );
    const accessToken = accessTokenData.token;

    // Check if workflow files were modified
    const allModifiedFiles = commits.flatMap((c: any) => [
      ...c.added,
      ...c.modified,
      ...c.removed,
    ]);

    const workflowFilesModified = allModifiedFiles.some(
      (file: string) =>
        file.startsWith("hyperp-workflows/") &&
        (file.endsWith(".yaml") || file.endsWith(".yml"))
    );

    if (workflowFilesModified) {
      console.log("Workflow files modified, resyncing workflows...");
      await syncWorkflows(accessToken, owner, repo, repositoryId, commitHash);
    }

    // Get workflows for this repository
    const workflows = await getWorkflowsForRepository(repositoryId);
    console.log(
      `Found ${workflows.length} workflows for repository ${repositoryId}`
    );

    const matchingJsonFiles = workflows.filter((wf) =>
      allModifiedFiles.some(
        (file: string) =>
          Object.values(wf.taskDefinitionPaths).includes(file) ||
          Object.values(wf.runTaskPaths).includes(file)
      )
    );

    if (!workflowFilesModified && matchingJsonFiles.length > 0) {
      console.log(
        `${matchingJsonFiles.length} json files match modified files`
      );
      await syncWorkflows(accessToken, owner, repo, repositoryId, commitHash);
    }
    // Filter workflows by branch
    const matchingWorkflows = workflows.filter((wf) =>
      branchMatches(branch, wf.branches)
    );
    console.log(`${matchingWorkflows.length} workflows match branch ${branch}`);

    // Extract commit message from head_commit
    const commitMessage = body.head_commit?.message || "";

    // Trigger workflows
    for (const workflow of matchingWorkflows) {
      await triggerWorkflowRun(
        workflow,
        repositoryId,
        commitHash,
        branch,
        accessToken,
        owner,
        repo,
        commits,
        installationId.toString(),
        body.before, // Previous commit hash
        commitMessage
      );
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ message: "Webhook processed successfully" }),
    };
  } catch (error) {
    console.error("Error processing webhook:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Internal server error" }),
    };
  }
};

// ============================================
// Sync Workflows from Repository
// ============================================
async function syncWorkflows(
  accessToken: string,
  owner: string,
  repo: string,
  repositoryId: string,
  commitHash: string
): Promise<void> {
  console.log("Syncing workflows from repository...");

  // List files in hyperp-workflows directory
  const workflowDir = await GithubHelper.getRepositoryContent(
    accessToken,
    owner,
    repo,
    "hyperp-workflows",
    commitHash
  );

  if (!workflowDir || !Array.isArray(workflowDir)) {
    console.log("No workflow directory found or not a directory");
    return;
  }

  // Filter YAML files
  const yamlFiles = workflowDir.filter(
    (file: any) =>
      file.type === "file" &&
      (file.name.endsWith(".yaml") || file.name.endsWith(".yml"))
  );

  console.log(`Found ${yamlFiles.length} workflow YAML files`);

  const existingWorkflows = await getWorkflowsForRepository(repositoryId);
  const processedWorkflowIds = new Set<string>();

  for (const file of yamlFiles) {
    try {
      // Fetch file content
      const fileContent = await GithubHelper.getRepositoryContent(
        accessToken,
        owner,
        repo,
        file.path,
        commitHash
      );

      if (!fileContent || !fileContent.content) {
        console.log(`Could not fetch content for ${file.path}`);
        continue;
      }

      // Decode base64 content
      const content = Buffer.from(fileContent.content, "base64").toString(
        "utf-8"
      );
      const workflowYaml: WorkflowYaml = yaml.parse(content);

      // Save workflow and jobs
      const workflowId = await saveWorkflow(
        workflowYaml,
        repositoryId,
        `https://github.com/${owner}/${repo}`,
        accessToken,
        owner,
        repo,
        commitHash
      );
      processedWorkflowIds.add(workflowId);
    } catch (error) {
      console.error(`Error processing workflow file ${file.path}:`, error);
    }
  }

  // Delete workflows that no longer exist
  for (const existingWorkflow of existingWorkflows) {
    if (!processedWorkflowIds.has(existingWorkflow.entityId)) {
      console.log(`Deleting workflow ${existingWorkflow.workflowName}`);
      await deleteWorkflow(existingWorkflow);
    }
  }
}

// ============================================
// Save Workflow and Jobs to DynamoDB
// ============================================
async function saveWorkflow(
  workflowYaml: WorkflowYaml,
  repositoryId: string,
  githubURL: string,
  accessToken: string,
  owner: string,
  repo: string,
  commitHash: string
): Promise<string> {
  const workflowNameHash = generateHash(workflowYaml.workflowName);
  const workflowId = `workflow#${repositoryId}#${workflowNameHash}`;
  const timestamp = new Date().toISOString();

  // Build maps for paths
  const dockerfilePaths: Record<string, string[]> = {};
  const taskDefinitionPaths: Record<string, string> = {};
  const runTaskPaths: Record<string, string> = {};

  // Get existing jobs to preserve lastImageUri
  const existingJobsResponse = await dynamoClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: "GSI1",
      KeyConditionExpression: "#gsi1pk = :gsi1pk",
      ExpressionAttributeNames: {
        "#gsi1pk": "GSI1-PK",
      },
      ExpressionAttributeValues: marshall({
        ":gsi1pk": workflowId,
      }),
    })
  );

  const existingJobs = (existingJobsResponse.Items || []).map((item) =>
    unmarshall(item)
  );
  const existingJobsMap = new Map(
    existingJobs.map((job: any) => [job.jobName, job])
  );

  // Extract dockerfile paths from task definitions
  for (const job of workflowYaml.jobs) {
    taskDefinitionPaths[job.jobName] = job.taskDefinitionPath;
    if (job.runTaskPath) {
      runTaskPaths[job.jobName] = job.runTaskPath;
    }

    // Fetch task definition to extract dockerfile paths
    try {
      const taskDefContent = await GithubHelper.getRepositoryContent(
        accessToken,
        owner,
        repo,
        job.taskDefinitionPath,
        commitHash
      );

      if (taskDefContent && taskDefContent.content) {
        const taskDefJson = JSON.parse(
          Buffer.from(taskDefContent.content, "base64").toString("utf-8")
        );
        dockerfilePaths[job.jobName] = extractDockerfilePaths(taskDefJson);
      } else {
        dockerfilePaths[job.jobName] = [];
      }
    } catch (error) {
      console.error(
        `Error fetching task definition for ${job.jobName}:`,
        error
      );
      dockerfilePaths[job.jobName] = [];
    }
  }

  // Extract shared volumes from workflow YAML
  const sharedVolumes = workflowYaml.artifacts?.shared || [];

  // Save workflow entity
  const workflowEntity: any = {
    PK: workflowId,
    SK: workflowId,
    "GSI1-PK": "workflows",
    "GSI1-SK": workflowId,
    entityType: "workflow",
    entityId: workflowNameHash,
    workflowName: workflowYaml.workflowName,
    workflowDescription: workflowYaml.workflowDescription || "",
    jobCount: workflowYaml.jobs.length,
    gitHubURL: githubURL,
    githubRepositoryId: repositoryId,
    branches: workflowYaml.branches,
    dockerfilePaths: dockerfilePaths,
    taskDefinitionPaths: taskDefinitionPaths,
    runTaskPaths: runTaskPaths,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  // Store shared volumes if defined
  if (sharedVolumes.length > 0) {
    workflowEntity.sharedVolumes = sharedVolumes;
  }

  await dynamoClient.send(
    new PutItemCommand({
      TableName: TABLE_NAME,
      Item: marshall(workflowEntity),
    })
  );

  console.log(`Saved workflow: ${workflowYaml.workflowName}`);

  // Save job entities - only update if changed, preserve lastImageUri
  for (const job of workflowYaml.jobs) {
    const jobNameHash = generateHash(job.jobName);
    const jobId = `job#${repositoryId}#${workflowNameHash}#${jobNameHash}`;
    const existingJob = existingJobsMap.get(job.jobName);

    // Check if job configuration changed
    const concurrency = job.concurrency || 1;
    const dependsOn = job.dependsOn || [];
    const jobDescription = job.jobDescription || "";
    const imageBuildResources = job.imageBuildResources;
    const downloadable = job.downloadable || false;

    const jobChanged =
      !existingJob ||
      existingJob.concurrency !== concurrency ||
      JSON.stringify(existingJob.dependsOn || []) !==
        JSON.stringify(dependsOn) ||
      existingJob.jobDescription !== jobDescription ||
      JSON.stringify(existingJob.imageBuildResources || {}) !==
        JSON.stringify(imageBuildResources || {}) ||
      (existingJob.downloadable || false) !== downloadable;

    // Preserve lastImageUri and lastImageBuildCommitHash if job hasn't changed
    const lastImageUri = existingJob?.lastImageUri;
    const lastImageBuildCommitHash = existingJob?.lastImageBuildCommitHash;

    const jobEntity: any = {
      PK: jobId,
      SK: jobId,
      "GSI1-PK": workflowId,
      "GSI1-SK": jobId,
      entityType: "job",
      entityId: jobNameHash,
      jobName: job.jobName,
      jobDescription: jobDescription,
      concurrency: concurrency,
      dependsOn: dependsOn,
      githubRepositoryId: repositoryId,
      workflowNameHash: workflowNameHash,
      updatedAt: timestamp,
    };

    // Store imageBuildResources if defined
    if (imageBuildResources) {
      jobEntity.imageBuildResources = imageBuildResources;
    }

    // Store downloadable flag
    if (downloadable) {
      jobEntity.downloadable = true;
    }

    // Preserve image cache fields if they exist
    if (lastImageUri) {
      jobEntity.lastImageUri = lastImageUri;
    }
    if (lastImageBuildCommitHash) {
      jobEntity.lastImageBuildCommitHash = lastImageBuildCommitHash;
    }

    // Only set createdAt if this is a new job
    if (!existingJob) {
      jobEntity.createdAt = timestamp;
    } else {
      jobEntity.createdAt = existingJob.createdAt;
    }

    await dynamoClient.send(
      new PutItemCommand({
        TableName: TABLE_NAME,
        Item: marshall(jobEntity),
      })
    );

    if (jobChanged) {
      console.log(`Updated job: ${job.jobName}`);
    } else {
      console.log(`Job unchanged, preserved cache: ${job.jobName}`);
    }
  }

  return workflowNameHash;
}

// ============================================
// Get Workflows for Repository
// ============================================
async function getWorkflowsForRepository(repositoryId: string): Promise<any[]> {
  const response = await dynamoClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: "GSI1",
      KeyConditionExpression:
        "#gsi1pk = :gsi1pk AND begins_with(#gsi1sk, :prefix)",
      ExpressionAttributeNames: {
        "#gsi1pk": "GSI1-PK",
        "#gsi1sk": "GSI1-SK",
      },
      ExpressionAttributeValues: marshall({
        ":gsi1pk": "workflows",
        ":prefix": `workflow#${repositoryId}`,
      }),
    })
  );

  return (response.Items || []).map((item) => unmarshall(item));
}

// ============================================
// Delete Workflow
// ============================================
async function deleteWorkflow(workflow: any): Promise<void> {
  // Delete workflow
  await dynamoClient.send(
    new DeleteItemCommand({
      TableName: TABLE_NAME,
      Key: marshall({
        PK: workflow.PK,
        SK: workflow.SK,
      }),
    })
  );

  // Delete associated jobs
  const jobs = await dynamoClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: "GSI1",
      KeyConditionExpression: "#gsi1pk = :gsi1pk",
      ExpressionAttributeNames: {
        "#gsi1pk": "GSI1-PK",
      },
      ExpressionAttributeValues: marshall({
        ":gsi1pk": workflow.PK,
      }),
    })
  );

  for (const job of jobs.Items || []) {
    const jobData = unmarshall(job);
    await dynamoClient.send(
      new DeleteItemCommand({
        TableName: TABLE_NAME,
        Key: marshall({
          PK: jobData.PK,
          SK: jobData.SK,
        }),
      })
    );
  }
}

// ============================================
// Trigger Workflow Run
// ============================================
async function triggerWorkflowRun(
  workflow: any,
  repositoryId: string,
  commitHash: string,
  branch: string,
  accessToken: string,
  owner: string,
  repo: string,
  commits: any[],
  installationId: string,
  previousCommitHash?: string,
  commitMessage?: string
): Promise<void> {
  console.log(`Triggering workflow run: ${workflow.workflowName}`);

  const workflowNameHash = workflow.entityId;
  const timestamp = new Date().toISOString();

  // Get jobs for this workflow
  const jobsResponse = await dynamoClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: "GSI1",
      KeyConditionExpression: "#gsi1pk = :gsi1pk",
      ExpressionAttributeNames: {
        "#gsi1pk": "GSI1-PK",
      },
      ExpressionAttributeValues: marshall({
        ":gsi1pk": workflow.PK,
      }),
    })
  );

  const jobs = (jobsResponse.Items || []).map((item) => unmarshall(item));

  // Detect which images need to be built
  const allModifiedFiles = commits.flatMap((c: any) => [
    ...c.added,
    ...c.modified,
  ]);

  const imageBuildJobs: Record<string, any> = {};
  let imageBuildJobCount = 0;
  const jobImageUris: Record<string, string> = {}; // Store which image URI each job should use

  for (const job of jobs) {
    const jobNameHash = job.entityId;
    const taskDefPath = workflow.taskDefinitionPaths[job.jobName];

    if (!taskDefPath) {
      console.log(`No task definition path for job ${job.jobName}`);
      continue;
    }

    // Fetch current task definition to get dockerfilePath values
    let currentDockerfilePaths: string[] = [];
    try {
      const taskDefContent = await GithubHelper.getRepositoryContent(
        accessToken,
        owner,
        repo,
        taskDefPath,
        commitHash // Use commitHash to get the version at this commit
      );

      if (taskDefContent && taskDefContent.content) {
        const taskDefJson = JSON.parse(
          Buffer.from(taskDefContent.content, "base64").toString("utf-8")
        );
        currentDockerfilePaths = extractDockerfilePaths(taskDefJson);
      }
    } catch (error) {
      console.error(
        `Error fetching task definition for ${job.jobName}:`,
        error
      );
    }

    // Check if dockerfilePath values changed by comparing with previous commit
    let dockerfilePathsChanged = false;
    let previousDockerfilePaths: string[] = [];

    if (
      previousCommitHash &&
      allModifiedFiles.includes(taskDefPath) &&
      currentDockerfilePaths.length > 0
    ) {
      // Fetch previous version of task definition to compare
      try {
        const previousTaskDefContent = await GithubHelper.getRepositoryContent(
          accessToken,
          owner,
          repo,
          taskDefPath,
          previousCommitHash
        );

        if (previousTaskDefContent && previousTaskDefContent.content) {
          const previousTaskDefJson = JSON.parse(
            Buffer.from(previousTaskDefContent.content, "base64").toString(
              "utf-8"
            )
          );
          previousDockerfilePaths = extractDockerfilePaths(previousTaskDefJson);

          dockerfilePathsChanged =
            JSON.stringify(currentDockerfilePaths.sort()) !==
            JSON.stringify(previousDockerfilePaths.sort());

          if (dockerfilePathsChanged) {
            console.log(
              `Dockerfile paths changed for job ${job.jobName}:`,
              `previous: ${JSON.stringify(previousDockerfilePaths)},`,
              `current: ${JSON.stringify(currentDockerfilePaths)}`
            );
          }
        }
      } catch (error) {
        console.error(
          `Error fetching previous task definition for ${job.jobName}:`,
          error
        );
        // If we can't fetch previous version but task def changed, assume paths might have changed
        dockerfilePathsChanged = true;
      }
    }

    // Use current dockerfile paths if available, otherwise fall back to stored from workflow entity
    const dockerfilePaths =
      currentDockerfilePaths.length > 0
        ? currentDockerfilePaths
        : workflow.dockerfilePaths[job.jobName] || [];

    if (dockerfilePaths.length === 0) {
      console.log(
        `No dockerfiles found for job ${job.jobName}, skipping image build`
      );
      continue;
    }

    // Check for .dockerignore files and filter modified files accordingly
    let relevantModifiedFiles = allModifiedFiles;
    const dockerignorePaths: string[] = [];

    // For each dockerfile path, check if there's a .dockerignore in the same directory
    for (const dockerfilePath of dockerfilePaths) {
      const dockerfileDir = dockerfilePath.substring(
        0,
        dockerfilePath.lastIndexOf("/")
      );
      const dockerignorePath = dockerfileDir
        ? `${dockerfileDir}/.dockerignore`
        : ".dockerignore";

      // Track .dockerignore paths to exclude them from code change detection
      dockerignorePaths.push(dockerignorePath);

      try {
        // Try to fetch .dockerignore file
        const dockerignoreContent = await GithubHelper.getRepositoryContent(
          accessToken,
          owner,
          repo,
          dockerignorePath,
          commitHash
        );

        if (dockerignoreContent && dockerignoreContent.content) {
          // Parse .dockerignore content
          const dockerignoreText = Buffer.from(
            dockerignoreContent.content,
            "base64"
          ).toString("utf-8");
          const dockerignoreLines = dockerignoreText
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0);

          console.log(
            `Found .dockerignore at ${dockerignorePath} for job ${job.jobName}`
          );

          // Filter modified files: only consider files in the dockerfile directory that are NOT ignored
          const dockerfileDirPath = dockerfileDir || ".";
          relevantModifiedFiles = relevantModifiedFiles.filter((file) => {
            // Exclude .dockerignore files themselves from triggering rebuilds
            if (dockerignorePaths.includes(file)) {
              console.log(
                `File ${file} is a .dockerignore file, excluding from code change detection for job ${job.jobName}`
              );
              return false;
            }

            // Check if file is in the dockerfile directory context
            const isInContext =
              file.startsWith(dockerfileDirPath + "/") ||
              (dockerfileDirPath === "." && !file.includes("/"));

            if (!isInContext) {
              return true; // Keep files outside dockerfile context
            }

            // For files in dockerfile context, check if they're ignored
            const relativePath = file.startsWith(dockerfileDirPath + "/")
              ? file.substring(dockerfileDirPath.length + 1)
              : file;

            const ignored = isFileIgnored(relativePath, dockerignoreLines);

            if (ignored) {
              console.log(
                `File ${file} (relative: ${relativePath}) is ignored by .dockerignore for job ${job.jobName}`
              );
            } else {
              console.log(
                `File ${file} (relative: ${relativePath}) is NOT ignored by .dockerignore for job ${job.jobName}`
              );
            }

            return !ignored; // Only keep files that are NOT ignored
          });
        }
      } catch (error) {
        // .dockerignore doesn't exist or couldn't be fetched - that's okay, continue without filtering
        console.log(
          `No .dockerignore found at ${dockerignorePath} for job ${job.jobName} (or error fetching):`,
          error
        );
      }
    }

    // Check if dockerfile paths, task definition, or related code changed
    // Use filtered modified files that respect .dockerignore
    const codeChanged =
      dockerfilePathsChanged ||
      (hasMatchingFiles(
        relevantModifiedFiles,
        dockerfilePaths.map((dockerfilePath: string) =>
          dockerfilePath.substring(0, dockerfilePath.lastIndexOf("/"))
        )
      ) &&
        !allModifiedFiles.includes(taskDefPath));

    // Determine if we need to build
    let needsRebuild = false;
    let reason = "";
    let imageUriToUse = "";
    console.log(`job`, JSON.stringify(job, null, 2));
    if (codeChanged) {
      needsRebuild = true;
      if (dockerfilePathsChanged) {
        reason = "Dockerfile path in task definition changed";
      } else {
        reason = "Code or Dockerfile changed";
      }
      // Will use newly built image
      const imageTag = `${commitHash}-${workflowNameHash}-${jobNameHash}-0`;
      imageUriToUse = `${ECR_REPOSITORY_URI}:${imageTag}`;
    } else if (!job.lastImageUri) {
      needsRebuild = true;
      reason = "No cached image available (first build)";
      // Will use newly built image
      const imageTag = `${commitHash}-${workflowNameHash}-${jobNameHash}-0`;
      imageUriToUse = `${ECR_REPOSITORY_URI}:${imageTag}`;
    } else {
      needsRebuild = false;
      reason = `Using cached image from commit ${job.lastImageBuildCommitHash}`;
      // Use cached image
      imageUriToUse = job.lastImageUri;
    }

    // Store the image URI decision for this job
    jobImageUris[jobNameHash] = imageUriToUse;

    console.log(`Job ${job.jobName}: ${reason} - ${imageUriToUse}`);

    if (needsRebuild) {
      // Trigger image builds for each container
      for (let i = 0; i < dockerfilePaths.length; i++) {
        const containerIndex = i;
        const imageBuildKey = `${jobNameHash}-${containerIndex}`;

        imageBuildJobs[imageBuildKey] = {
          jobNameHash: jobNameHash,
          jobName: job.jobName,
          containerIndex: containerIndex,
          containerName: "Image-Builder",
          dockerfilePath: dockerfilePaths[i],
          status: "PENDING",
          imageBuildResources: job.imageBuildResources, // Pass resources for image build
        };
        imageBuildJobCount++;
      }
    }
  }

  // Generate unique runId for this workflow run
  const runId = generateRunId();

  // Create workflow run entity
  // GSI3-SK uses createdAt timestamp for sorting (ISO 8601 format sorts chronologically)
  const workflowRunEntity = {
    PK: `workflowRun#${repositoryId}#${workflowNameHash}#${commitHash}`,
    SK: `workflowRun#${repositoryId}#${workflowNameHash}#${commitHash}#${runId}`,
    "GSI2-PK": `commitRuns#${commitHash}`,
    "GSI2-SK": `workflowRun#${repositoryId}#${workflowNameHash}`,
    "GSI3-PK": "workflowRuns",
    "GSI3-SK": timestamp, // ISO 8601 timestamp for chronological sorting
    entityType: "workflowRun",
    entityId: `${repositoryId}#${workflowNameHash}#${commitHash}#${runId}`,
    runId: runId,
    workflowName: workflow.workflowName,
    jobCount: jobs.length,
    completedJobCount: 0,
    status: imageBuildJobCount > 0 ? "WAITING_FOR_IMAGE_BUILDS" : "RUNNING",
    imageBuildJobs: imageBuildJobs,
    imageBuildJobCount: imageBuildJobCount,
    jobImageUris: jobImageUris, // Store image URI decisions for all jobs
    workflowNameHash: workflowNameHash,
    completedImageBuildJobCount: 0,
    githubRepositoryId: repositoryId,
    commitHash: commitHash,
    branch: branch,
    commitMessage: commitMessage || "", // Store commit message
    taskDefinitionPaths: workflow.taskDefinitionPaths || {}, // Store task definition paths
    sharedVolumes: workflow.sharedVolumes || [], // Store shared volumes from workflow
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  await dynamoClient.send(
    new PutItemCommand({
      TableName: TABLE_NAME,
      Item: marshall(workflowRunEntity, { removeUndefinedValues: true }),
    })
  );

  console.log(`Created workflow run entity`);

  // Create EFS directories for shared volumes if defined
  const sharedVolumes = workflow.sharedVolumes || [];
  if (sharedVolumes.length > 0) {
    console.log(`Creating ${sharedVolumes.length} shared volume directories`);
    for (const sharedVolume of sharedVolumes) {
      const sharedVolumePath = `${commitHash}/${runId}/${workflowNameHash}/${sharedVolume.name}`;
      try {
        await lambdaClient.send(
          new InvokeCommand({
            FunctionName: EFS_CONTROLLER_LAMBDA_ARN,
            InvocationType: "RequestResponse",
            Payload: JSON.stringify({
              action: "createDirectory",
              path: sharedVolumePath,
            }),
          })
        );
        console.log(`Created shared volume directory: ${sharedVolume.name}`);
      } catch (error) {
        console.error(
          `Error creating shared volume directory for ${sharedVolume.name}:`,
          error
        );
      }
    }
  }

  // Create job run entities
  for (const job of jobs) {
    const jobNameHash = job.entityId;

    // Calculate dependent job IDs (jobs that depend on this job)
    const dependentJobIds = jobs
      .filter((j) => j.dependsOn && j.dependsOn.includes(job.jobName))
      .map((j) => j.entityId);

    // Get job entity IDs for dependencies (job name hashes)
    const dependsOnJobIds = (job.dependsOn || [])
      .map((depJobName: string) => {
        const depJob = jobs.find((j) => j.jobName === depJobName);
        return depJob ? depJob.entityId : null;
      })
      .filter((id: string | null) => id !== null) as string[];

    const jobRunEntity: any = {
      PK: `jobRun#${workflowNameHash}#${jobNameHash}#${commitHash}`,
      SK: `jobRun#${workflowNameHash}#${jobNameHash}#${commitHash}#${runId}`,
      "GSI1-PK": `workflowRun#${workflowNameHash}#${commitHash}#${runId}`,
      "GSI1-SK": `jobRun#${workflowNameHash}#${jobNameHash}#${commitHash}#${runId}`,
      entityType: "jobRun",
      entityId: `${workflowNameHash}#${jobNameHash}#${commitHash}#${runId}`,
      runId: runId,
      jobName: job.jobName,
      workflowNameHash: workflowNameHash,
      taskCount: job.concurrency,
      completedTaskCount: 0,
      dependsOn: job.dependsOn || [],
      dependsOnJobIds: dependsOnJobIds,
      dependentJobIds: dependentJobIds,
      dependencyCount: (job.dependsOn || []).length,
      completedDependencyCount: 0,
      status: "PENDING",
      efsOutputLocation: `/hyperp-artifacts/${commitHash}/${runId}/${workflowNameHash}/${jobNameHash}`,
      githubRepositoryId: repositoryId,
      commitHash: commitHash,
      owner: owner,
      repo: repo,
      installationId: installationId,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    // Store downloadable flag from job entity
    if (job.downloadable) {
      jobRunEntity.downloadable = true;
    }

    await dynamoClient.send(
      new PutItemCommand({
        TableName: TABLE_NAME,
        Item: marshall(jobRunEntity, { removeUndefinedValues: true }),
      })
    );

    console.log(`Created job run entity for ${job.jobName}`);
  }

  // Trigger image builds
  if (imageBuildJobCount > 0) {
    await triggerImageBuilds(
      imageBuildJobs,
      workflowNameHash,
      commitHash,
      repositoryId,
      accessToken,
      owner,
      repo,
      runId
    );
  } else {
    // No image builds needed, start workflow immediately
    console.log("No image builds needed, starting workflow immediately");
    await startWorkflowJobs(
      workflowNameHash,
      commitHash,
      repositoryId,
      jobs,
      workflow,
      accessToken,
      owner,
      repo,
      branch,
      allModifiedFiles,
      jobImageUris,
      runId
    );
  }
}

// ============================================
// Helper: Mark Workflow Run as Failed
// ============================================
async function markWorkflowRunAsFailed(
  repositoryId: string,
  workflowNameHash: string,
  commitHash: string,
  runId: string,
  failureReason: string
): Promise<void> {
  const workflowRunPK = `workflowRun#${repositoryId}#${workflowNameHash}#${commitHash}`;
  const workflowRunSK = `${workflowRunPK}#${runId}`;

  await dynamoClient.send(
    new UpdateItemCommand({
      TableName: TABLE_NAME,
      Key: marshall({
        PK: workflowRunPK,
        SK: workflowRunSK,
      }),
      UpdateExpression:
        "SET #status = :status, failureReason = :failureReason, updatedAt = :updatedAt",
      ExpressionAttributeNames: {
        "#status": "status",
      },
      ExpressionAttributeValues: marshall({
        ":status": "FAILED",
        ":failureReason": failureReason,
        ":updatedAt": new Date().toISOString(),
      }),
    })
  );
}

// ============================================
// Helper: Mark Job Run as Failed
// ============================================
async function markJobRunAsFailed(
  workflowNameHash: string,
  jobNameHash: string,
  commitHash: string,
  runId: string,
  failureReason: string
): Promise<void> {
  const jobRunPK = `jobRun#${workflowNameHash}#${jobNameHash}#${commitHash}`;
  const jobRunSK = `${jobRunPK}#${runId}`;

  await dynamoClient.send(
    new UpdateItemCommand({
      TableName: TABLE_NAME,
      Key: marshall({
        PK: jobRunPK,
        SK: jobRunSK,
      }),
      UpdateExpression: "SET #status = :status, updatedAt = :updatedAt",
      ExpressionAttributeNames: {
        "#status": "status",
      },
      ExpressionAttributeValues: marshall({
        ":status": "FAILED",
        ":updatedAt": new Date().toISOString(),
      }),
    })
  );
}

// ============================================
// Trigger Image Builds
// ============================================
async function triggerImageBuilds(
  imageBuildJobs: Record<string, any>,
  workflowNameHash: string,
  commitHash: string,
  repositoryId: string,
  accessToken: string,
  owner: string,
  repo: string,
  runId: string
): Promise<void> {
  console.log(`Triggering ${Object.keys(imageBuildJobs).length} image builds`);

  for (const [key, buildJob] of Object.entries(imageBuildJobs)) {
    const { jobNameHash, containerIndex, dockerfilePath, imageBuildResources } =
      buildJob;
    const family = `image-build-${repositoryId}-${commitHash}-${workflowNameHash}-${jobNameHash}-${containerIndex}-${runId}`;
    const imageTag = `${commitHash}-${workflowNameHash}-${jobNameHash}-${containerIndex}`;

    // Get context path from dockerfile path
    const contextSubPath = dockerfilePath.substring(
      0,
      dockerfilePath.lastIndexOf("/")
    );

    // Get dockerfile name from path
    const dockerfileName = dockerfilePath.substring(
      dockerfilePath.lastIndexOf("/") + 1
    );

    // Use imageBuildResources if defined, otherwise use defaults
    const cpu = imageBuildResources?.cpu || "1024";
    const memory = imageBuildResources?.memory || "4096";

    // Register task definition
    const taskDefinition = {
      family: family,
      networkMode: "awsvpc" as NetworkMode,
      requiresCompatibilities: ["FARGATE"] as Compatibility[],
      cpu: cpu,
      memory: memory,
      executionRoleArn: ECS_TASK_EXECUTION_ROLE_ARN,
      taskRoleArn: ECS_TASK_ROLE_ARN,
      containerDefinitions: [
        {
          name: "Image-Builder",
          image: "public.ecr.aws/b6g9t8f1/kaniko-executor-ecr:latest",
          command: [
            "--context",
            `git://oauth2:${accessToken}@github.com/${owner}/${repo}.git#${commitHash}`,
            "--context-sub-path",
            contextSubPath,
            "--dockerfile",
            dockerfileName,
            "--destination",
            `${ECR_REPOSITORY_URI}:${imageTag}`,
            "--force",
          ],
          logConfiguration: {
            logDriver: "awslogs" as LogDriver,
            options: {
              "awslogs-group": "/hyperp",
              "awslogs-region": process.env.AWS_REGION!,
              "awslogs-stream-prefix": `${commitHash}/${workflowNameHash}/${jobNameHash}/${runId}`,
            },
          },
        },
      ],
    };

    try {
      const registerResponse = await ecsClient.send(
        new RegisterTaskDefinitionCommand(taskDefinition)
      );

      console.log(`Registered task definition: ${family}`);

      // Run task
      const runTaskInput = {
        cluster: ECS_CLUSTER,
        taskDefinition: family,
        launchType: "FARGATE" as LaunchType,
        networkConfiguration: {
          awsvpcConfiguration: {
            subnets: PUBLIC_SUBNET_IDS,
            securityGroups: [ECS_TASK_SECURITY_GROUP_ID],
            assignPublicIp: "ENABLED" as AssignPublicIp,
          },
        },
      };

      console.log(
        `Running task with config:`,
        JSON.stringify(runTaskInput, null, 2)
      );

      const runTaskResponse = await ecsClient.send(
        new RunTaskCommand(runTaskInput)
      );

      console.log(
        `Started image build task for ${family}`,
        runTaskResponse.tasks?.[0]?.taskArn
      );
    } catch (error: any) {
      const errorMessage = error?.message || String(error);
      const failureReason = `Failed to register or run image build task for ${
        buildJob.jobName || buildJob.jobNameHash
      } (container ${containerIndex}): ${errorMessage}`;
      console.error(failureReason, error);

      // Mark workflow run as failed
      await markWorkflowRunAsFailed(
        repositoryId,
        workflowNameHash,
        commitHash,
        runId,
        failureReason
      );

      throw error; // Re-throw to stop processing
    }
  }
}

// ============================================
// Start Workflow Jobs
// ============================================
async function startWorkflowJobs(
  workflowNameHash: string,
  commitHash: string,
  repositoryId: string,
  jobs: any[],
  workflow: any,
  accessToken: string,
  owner: string,
  repo: string,
  branch: string,
  modifiedFiles: string[] = [],
  jobImageUris: Record<string, string> = {},
  runId: string
): Promise<void> {
  console.log("Starting workflow jobs...");

  // Start jobs that have no dependencies
  const jobsWithNoDependencies = jobs.filter(
    (job) => !job.dependsOn || job.dependsOn.length === 0
  );

  for (const job of jobsWithNoDependencies) {
    await startJobRun(
      job,
      workflowNameHash,
      commitHash,
      workflow,
      accessToken,
      owner,
      repo,
      jobs,
      jobImageUris,
      runId
    );
  }
}

// ============================================
// Start Job Run
// ============================================
async function startJobRun(
  job: any,
  workflowNameHash: string,
  commitHash: string,
  workflow: any,
  accessToken: string,
  owner: string,
  repo: string,
  allJobs: any[],
  jobImageUris: Record<string, string> = {},
  runId: string
): Promise<void> {
  console.log(`Starting job run: ${job.jobName}`);

  const jobNameHash = job.entityId;

  // Create EFS directories for this job
  // Access point mounts at /hyperp-artifacts, so pass relative path only to EFS controller
  const efsControllerPath = `${commitHash}/${runId}/${workflowNameHash}/${jobNameHash}`;
  await lambdaClient.send(
    new InvokeCommand({
      FunctionName: EFS_CONTROLLER_LAMBDA_ARN,
      InvocationType: "RequestResponse",
      Payload: JSON.stringify({
        action: "createDirectory",
        path: efsControllerPath,
      }),
    })
  );

  // Full path for ECS task volume mounting (ECS mounts EFS directly, not via access point)
  const jobOutputDir = `/hyperp-artifacts/${commitHash}/${runId}/${workflowNameHash}/${jobNameHash}`;

  // Fetch task definition template
  const taskDefPath = workflow.taskDefinitionPaths[job.jobName];
  const taskDefContent = await GithubHelper.getRepositoryContent(
    accessToken,
    owner,
    repo,
    taskDefPath,
    commitHash
  );

  if (!taskDefContent || !taskDefContent.content) {
    console.error(`Could not fetch task definition for ${job.jobName}`);
    return;
  }

  const taskDefTemplate = JSON.parse(
    Buffer.from(taskDefContent.content, "base64").toString("utf-8")
  );

  // Get the predetermined image URI for this job
  // This was already decided during workflow run creation based on caching logic
  const imageUriForJob = jobImageUris[jobNameHash];

  // Replace dockerfilePath with actual image URIs
  for (let i = 0; i < taskDefTemplate.containerDefinitions.length; i++) {
    const container = taskDefTemplate.containerDefinitions[i];
    container.name = generateHash(job.jobName);
    if (container.dockerfilePath) {
      if (imageUriForJob) {
        // Use the pre-determined image URI (cached or new)
        container.image = imageUriForJob;
        console.log(`Using image for ${job.jobName}: ${imageUriForJob}`);
      } else {
        // Fallback: construct new image tag
        const imageTag = `${commitHash}-${workflowNameHash}-${jobNameHash}-${i}`;
        container.image = `${ECR_REPOSITORY_URI}:${imageTag}`;
        console.log(
          `Using fallback image for ${job.jobName}: ${container.image}`
        );
      }
      delete container.dockerfilePath;
    }
  }

  // Configure EFS volumes for dependencies
  const dependencyJobs = allJobs.filter(
    (j) => job.dependsOn && job.dependsOn.includes(j.jobName)
  );

  // Update volumes and mount points
  taskDefTemplate.volumes = taskDefTemplate.volumes || [];
  taskDefTemplate.containerDefinitions[0].mountPoints =
    taskDefTemplate.containerDefinitions[0].mountPoints || [];

  // Add output volume
  taskDefTemplate.volumes.push({
    name: "volume-output",
    efsVolumeConfiguration: {
      fileSystemId: EFS_FILE_SYSTEM_ID,
      rootDirectory: jobOutputDir,
      transitEncryption: "ENABLED",
    },
  });

  taskDefTemplate.containerDefinitions[0].mountPoints.push({
    sourceVolume: "volume-output",
    containerPath: "/output",
    readOnly: false,
  });

  // Add dependency volumes
  for (const depJob of dependencyJobs) {
    const depJobNameHash = depJob.entityId;
    const volumeName = `volume-${depJobNameHash}`;

    taskDefTemplate.volumes.push({
      name: volumeName,
      efsVolumeConfiguration: {
        fileSystemId: EFS_FILE_SYSTEM_ID,
        rootDirectory: `/hyperp-artifacts/${commitHash}/${runId}/${workflowNameHash}/${depJobNameHash}`,
        transitEncryption: "ENABLED",
      },
    });

    taskDefTemplate.containerDefinitions[0].mountPoints.push({
      sourceVolume: volumeName,
      containerPath: `/input/${depJob.jobName}`,
      readOnly: true,
    });
  }

  // Add shared volumes if defined
  const sharedVolumes = workflow.sharedVolumes || [];
  for (const sharedVolume of sharedVolumes) {
    const volumeName = `volume-shared-${sharedVolume.name}`;
    const sharedVolumePath = `/hyperp-artifacts/${commitHash}/${runId}/${workflowNameHash}/${sharedVolume.name}`;

    taskDefTemplate.volumes.push({
      name: volumeName,
      efsVolumeConfiguration: {
        fileSystemId: EFS_FILE_SYSTEM_ID,
        rootDirectory: sharedVolumePath,
        transitEncryption: "ENABLED",
      },
    });

    taskDefTemplate.containerDefinitions[0].mountPoints.push({
      sourceVolume: volumeName,
      containerPath: `/shared/${sharedVolume.name}`,
      readOnly: false, // Shared volumes are read-write
    });
  }

  // Set family and other required fields
  taskDefTemplate.family = `jobRun-${commitHash}-${workflowNameHash}-${jobNameHash}-${runId}`;
  taskDefTemplate.executionRoleArn = ECS_TASK_EXECUTION_ROLE_ARN;
  taskDefTemplate.taskRoleArn = ECS_TASK_ROLE_ARN;
  taskDefTemplate.networkMode = "awsvpc";

  // Update log configuration to include runId
  for (const container of taskDefTemplate.containerDefinitions) {
    if (container.logConfiguration && container.logConfiguration.options) {
      const logPrefix = `${commitHash}/${workflowNameHash}/${jobNameHash}/${runId}`;
      container.logConfiguration.options["awslogs-stream-prefix"] = logPrefix;
    }
  }

  // Get repositoryId from job entity
  const repositoryId = job.githubRepositoryId;

  // Register task definition
  try {
    await ecsClient.send(new RegisterTaskDefinitionCommand(taskDefTemplate));
    console.log(`Registered task definition for job: ${job.jobName}`);
  } catch (error: any) {
    const errorMessage = error?.message || String(error);
    const failureReason = `Failed to register task definition for job ${job.jobName}: ${errorMessage}`;
    console.error(failureReason, error);

    // Mark job run as failed
    await markJobRunAsFailed(
      workflowNameHash,
      jobNameHash,
      commitHash,
      runId,
      failureReason
    );

    // Mark workflow run as failed
    await markWorkflowRunAsFailed(
      repositoryId,
      workflowNameHash,
      commitHash,
      runId,
      failureReason
    );

    throw error; // Re-throw to stop processing
  }

  // Run tasks (based on concurrency)
  const concurrency = job.concurrency || 1;

  // Get container name from task definition (first container)
  const containerName =
    taskDefTemplate.containerDefinitions[0]?.name || generateHash(job.jobName);

  // Get existing environment variables from task definition
  const existingEnvVars =
    taskDefTemplate.containerDefinitions[0]?.environment || [];

  for (let i = 1; i < concurrency + 1; i++) {
    try {
      // Build environment variables: preserve existing ones and add task index/total if concurrency > 1
      const environment = [...existingEnvVars];
      if (concurrency > 1) {
        environment.push(
          { name: "TASK_INDEX", value: i.toString() },
          { name: "TASK_TOTAL_SIZE", value: concurrency.toString() }
        );
      }

      const runTaskInput: any = {
        cluster: ECS_CLUSTER,
        taskDefinition: taskDefTemplate.family,
        launchType: "FARGATE",
        networkConfiguration: {
          awsvpcConfiguration: {
            subnets: PUBLIC_SUBNET_IDS,
            securityGroups: [ECS_TASK_SECURITY_GROUP_ID],
            assignPublicIp: "ENABLED" as AssignPublicIp,
          },
        },
      };

      // Add container overrides if concurrency > 1
      if (concurrency > 1) {
        runTaskInput.overrides = {
          containerOverrides: [
            {
              name: containerName,
              environment: environment,
            },
          ],
        };
      }

      console.log(
        `Running job task ${i + 1}/${concurrency} with config:`,
        JSON.stringify(runTaskInput, null, 2)
      );

      const runTaskResponse: RunTaskCommandOutput = await ecsClient.send(
        new RunTaskCommand(runTaskInput)
      );
      const taskArn = runTaskResponse.tasks?.at(0)?.taskArn;

      if (!taskArn) {
        throw new Error(
          `No task ARN returned from RunTaskCommand for job ${job.jobName}`
        );
      }

      const taskPK = `task#${taskArn}`;
      const taskSK = taskPK; // PK and SK are the same for tasks
      const taskGSI1PK = `jobRun#${workflowNameHash}#${jobNameHash}#${commitHash}`;
      const taskGSI1SK = `task#${taskArn}`;
      const timestamp = new Date().toISOString();

      const taskEntity = {
        PK: taskPK,
        SK: taskSK,
        "GSI1-PK": taskGSI1PK,
        "GSI1-SK": taskGSI1SK,
        entityType: "task",
        entityId: taskArn,
        taskArn: taskArn,
        jobRunEntityId: `${workflowNameHash}#${jobNameHash}#${commitHash}`,
        lastStatus: "RUNNING",
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      await dynamoClient.send(
        new PutItemCommand({
          TableName: TABLE_NAME,
          Item: marshall(taskEntity),
        })
      );
      console.log(
        `Started job task ${i + 1}/${concurrency} for ${job.jobName}`,
        runTaskResponse.tasks?.[0]?.taskArn
      );
    } catch (error: any) {
      const errorMessage = error?.message || String(error);
      const failureReason = `Failed to run task ${
        i + 1
      }/${concurrency} for job ${job.jobName}: ${errorMessage}`;
      console.error(failureReason, error);

      // Mark job run as failed
      await markJobRunAsFailed(
        workflowNameHash,
        jobNameHash,
        commitHash,
        runId,
        failureReason
      );

      // Mark workflow run as failed
      await markWorkflowRunAsFailed(
        repositoryId,
        workflowNameHash,
        commitHash,
        runId,
        failureReason
      );

      throw error; // Re-throw to stop processing
    }
  }

  // Update job run status (use UpdateItemCommand to preserve existing attributes)
  await dynamoClient.send(
    new UpdateItemCommand({
      TableName: TABLE_NAME,
      Key: marshall({
        PK: `jobRun#${workflowNameHash}#${jobNameHash}#${commitHash}`,
        SK: `jobRun#${workflowNameHash}#${jobNameHash}#${commitHash}#${runId}`,
      }),
      UpdateExpression: "SET #status = :status, updatedAt = :updatedAt",
      ExpressionAttributeNames: {
        "#status": "status",
      },
      ExpressionAttributeValues: marshall({
        ":status": "RUNNING",
        ":updatedAt": new Date().toISOString(),
      }),
    })
  );
}

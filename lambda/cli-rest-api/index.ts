import {
  DynamoDBClient,
  QueryCommand,
  GetItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import * as crypto from "crypto";
import {
  CloudWatchLogsClient,
  GetLogEventsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import {
  ECSClient,
  RegisterTaskDefinitionCommand,
  RunTaskCommand,
} from "@aws-sdk/client-ecs";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// ============================================
// Types
// ============================================
interface WorkflowRunEntity {
  PK: string;
  SK: string;
  "GSI1-PK": string;
  "GSI1-SK": string;
  "GSI2-PK": string;
  "GSI2-SK": string;
  "GSI3-PK"?: string;
  "GSI3-SK"?: string;
  entityType: "workflowRun";
  entityId: string;
  workflowName: string;
  jobCount: number;
  completedJobCount: number;
  status: "WAITING_FOR_IMAGE_BUILDS" | "RUNNING" | "SUCCEEDED" | "FAILED";
  imageBuildJobs: Record<string, ImageBuildJobStatus>;
  imageBuildJobCount: number;
  completedImageBuildJobCount: number;
  githubRepositoryId: string;
  commitHash: string;
  branch: string;
  estimatedCost?: number;
  storageUsage?: number;
  failureReason?: string;
  createdAt: string;
  updatedAt: string;
}

interface ImageBuildJobStatus {
  jobNameHash: string;
  containerIndex: number;
  status: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED";
  startedAt?: string;
  stoppedAt?: string;
  estimatedCost?: number;
}

interface JobRunEntity {
  PK: string;
  SK: string;
  "GSI1-PK": string;
  "GSI1-SK": string;
  entityType: "jobRun";
  entityId: string;
  jobName: string;
  workflowNameHash: string;
  taskCount: number;
  completedTaskCount: number;
  status: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED";
  githubRepositoryId: string;
  commitHash: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  stoppedAt?: string;
  taskArn?: string;
  estimatedCost?: number;
  storageUsage?: number;
  downloadable?: boolean;
  downloadableArtifactsReady?: boolean;
  dependsOn?: string[];
}

// ============================================
// Main Handler
// ============================================
const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const cloudWatchLogsClient = new CloudWatchLogsClient({
  region: process.env.AWS_REGION,
});
const ecsClient = new ECSClient({ region: process.env.AWS_REGION });
const s3Client = new S3Client({ region: process.env.AWS_REGION });
const TABLE_NAME = process.env.DYNAMODB_TABLE_NAME!;
const LOG_GROUP_NAME = "/hyperp";
const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME!;

// ============================================
// API Secret Validation
// ============================================
function validateApiSecret(event: any): boolean {
  const expectedSecret = process.env.GITHUB_APP_WEBHOOK_SECRET;

  // If no secret is configured, allow all requests (for backward compatibility)
  if (!expectedSecret) {
    console.warn(
      "⚠️  GITHUB_APP_WEBHOOK_SECRET not set, skipping API secret validation"
    );
    return true;
  }

  // Get secret from headers
  // Try different header formats (Function URL vs API Gateway)
  let providedSecret: string | undefined;
  if (event.headers) {
    providedSecret =
      event.headers["x-api-secret"] ||
      event.headers["X-Api-Secret"] ||
      event.headers["authorization"]?.replace("Bearer ", "") ||
      event.headers["Authorization"]?.replace("Bearer ", "");
  }
  if (!providedSecret && event.requestContext?.http?.headers) {
    providedSecret =
      event.requestContext.http.headers["x-api-secret"] ||
      event.requestContext.http.headers["X-Api-Secret"] ||
      event.requestContext.http.headers["authorization"]?.replace(
        "Bearer ",
        ""
      ) ||
      event.requestContext.http.headers["Authorization"]?.replace(
        "Bearer ",
        ""
      );
  }

  if (!providedSecret) {
    console.error("Missing API secret in request headers");
    return false;
  }

  // Use timing-safe comparison to prevent timing attacks
  const isValid = crypto.timingSafeEqual(
    Buffer.from(providedSecret),
    Buffer.from(expectedSecret)
  );

  if (!isValid) {
    console.error("Invalid API secret");
  }

  return isValid;
}

export const handler = async (event: any): Promise<any> => {
  console.log("REST API request");

  try {
    // Support both Function URL and API Gateway event formats
    // Function URL format: requestContext.http.path, requestContext.http.method, rawQueryString
    // API Gateway format: path, httpMethod, queryStringParameters
    const path =
      event.requestContext?.http?.path ||
      event.requestContext?.path ||
      event.path ||
      "";
    const method =
      event.requestContext?.http?.method ||
      event.requestContext?.httpMethod ||
      event.httpMethod ||
      "";

    // Extract query parameters
    let queryParams: Record<string, string> = {};
    if (event.queryStringParameters) {
      queryParams = event.queryStringParameters;
    } else if (event.rawQueryString) {
      const params = new URLSearchParams(event.rawQueryString);
      params.forEach((value, key) => {
        queryParams[key] = value;
      });
    }

    // CORS headers
    const headers = {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type, X-Api-Secret, Authorization",
    };

    // Handle OPTIONS for CORS
    if (method === "OPTIONS") {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({}),
      };
    }

    // Validate API secret for all non-OPTIONS requests
    if (!validateApiSecret(event)) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({
          error: "Unauthorized: Invalid or missing API secret",
        }),
      };
    }

    console.log("✅ API secret validated");

    // Route: GET /workflow-runs?commitHash=xxx
    if (path === "/workflow-runs" && method === "GET") {
      const commitHash = queryParams.commitHash;

      if (!commitHash) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({
            error: "commitHash query parameter is required",
          }),
        };
      }

      const workflowRuns = await getWorkflowRunsByCommitHash(commitHash);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ workflowRuns }),
      };
    }

    // Route: GET /workflow-runs/:workflowRunId/job-runs
    const jobRunsMatch = path.match(/^\/workflow-runs\/([^\/]+)\/job-runs$/);
    if (jobRunsMatch && method === "GET") {
      const workflowRunId = jobRunsMatch[1];
      const jobRuns = await getJobRunsByWorkflowRun(workflowRunId);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ jobRuns }),
      };
    }

    // Route: GET /workflow-runs/:workflowRunId/image-builds
    const imageBuildsMatch = path.match(
      /^\/workflow-runs\/([^\/]+)\/image-builds$/
    );
    if (imageBuildsMatch && method === "GET") {
      const workflowRunId = imageBuildsMatch[1];
      const imageBuilds = await getImageBuildsByWorkflowRun(workflowRunId);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ imageBuilds }),
      };
    }

    // Route: GET /logs?logStream=...
    if (path === "/logs" && method === "GET") {
      const logStream = queryParams.logStream;

      if (!logStream) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({
            error: "logStream query parameter is required",
          }),
        };
      }

      const logs = await getLogs(logStream);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ logs }),
      };
    }

    // Route: POST /job-runs/:jobRunId/trigger-downloadable
    const triggerDownloadableMatch = path.match(
      /^\/job-runs\/([^\/]+)\/trigger-downloadable$/
    );
    if (triggerDownloadableMatch && method === "POST") {
      const jobRunId = triggerDownloadableMatch[1];
      const result = await triggerDownloadableForJobRun(jobRunId);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify(result),
      };
    }

    // Route: GET /job-runs/:jobRunId/download-url
    const downloadUrlMatch = path.match(/^\/job-runs\/([^\/]+)\/download-url$/);
    if (downloadUrlMatch && method === "GET") {
      const jobRunId = downloadUrlMatch[1];
      const result = await getDownloadUrlForJobRun(jobRunId);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify(result),
      };
    }

    // Route: GET /job-runs/:jobRunId/tasks
    const tasksMatch = path.match(/^\/job-runs\/([^\/]+)\/tasks$/);
    if (tasksMatch && method === "GET") {
      const jobRunId = tasksMatch[1];
      const tasks = await getTasksByJobRun(jobRunId);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ tasks }),
      };
    }

    // Route: GET /runs (list last 10 workflow runs or by commit hash)
    if (path === "/runs" && method === "GET") {
      // Check for commitHash query parameter
      const commitHash = queryParams?.commitHash;

      let workflowRuns;
      if (commitHash) {
        workflowRuns = await getWorkflowRunsByCommitHash(commitHash);
      } else {
        workflowRuns = await getLastWorkflowRuns(10);
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ workflowRuns }),
      };
    }

    // Route: GET /runs/:entityId (get workflow run details by entityId)
    const runDetailsMatch = path.match(/^\/runs\/([^\/]+)$/);
    if (runDetailsMatch && method === "GET") {
      const entityId = runDetailsMatch[1];
      const workflowRun = await getWorkflowRunByEntityId(entityId);

      if (!workflowRun) {
        return {
          statusCode: 404,
          headers,
          body: JSON.stringify({ error: "Workflow run not found" }),
        };
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ workflowRun }),
      };
    }

    return {
      statusCode: 404,
      headers,
      body: JSON.stringify({ error: "Not found" }),
    };
  } catch (error: any) {
    console.error("Error:", error);
    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({
        error: "Internal server error",
        message: error.message,
      }),
    };
  }
};

// ============================================
// Query Workflow Runs by Commit Hash
// ============================================
async function getWorkflowRunsByCommitHash(commitHash: string): Promise<any[]> {
  const response = await dynamoClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: "GSI2",
      KeyConditionExpression: "#gsi2pk = :gsi2pk",
      ExpressionAttributeNames: {
        "#gsi2pk": "GSI2-PK",
      },
      ExpressionAttributeValues: {
        ":gsi2pk": { S: `commitRuns#${commitHash}` },
      },
    })
  );

  const workflowRuns = (response.Items || []).map((item) =>
    unmarshall(item)
  ) as WorkflowRunEntity[];

  // Format response
  return workflowRuns.map((run) => {
    const imageBuildStatuses = Object.values(run.imageBuildJobs || {}).map(
      (job) => job.status
    );
    const succeededBuilds = imageBuildStatuses.filter(
      (s) => s === "SUCCEEDED"
    ).length;
    const failedBuilds = imageBuildStatuses.filter(
      (s) => s === "FAILED"
    ).length;
    const runningBuilds = imageBuildStatuses.filter(
      (s) => s === "RUNNING"
    ).length;
    const pendingBuilds = imageBuildStatuses.filter(
      (s) => s === "PENDING"
    ).length;

    return {
      id: run.entityId,
      entityId: run.entityId,
      workflowName: run.workflowName,
      commitHash: run.commitHash,
      branch: run.branch,
      status: run.status,
      startDate: run.createdAt,
      endDate:
        run.status === "SUCCEEDED" || run.status === "FAILED"
          ? run.updatedAt
          : null,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      completedJobs: run.completedJobCount,
      totalJobs: run.jobCount,
      totalImageBuilds: run.imageBuildJobCount,
      completedImageBuilds: run.completedImageBuildJobCount,
      estimatedCost: run.estimatedCost,
      storageUsage: run.storageUsage,
      imageBuildStatuses: {
        succeeded: succeededBuilds,
        failed: failedBuilds,
        running: runningBuilds,
        pending: pendingBuilds,
      },
    };
  });
}

// ============================================
// Query Job Runs by Workflow Run
// ============================================
async function getJobRunsByWorkflowRun(workflowRunId: string): Promise<any[]> {
  // Parse workflowRunId: {repositoryId}#{workflowNameHash}#{commitHash}#{runId}
  const parts = workflowRunId.split("#");
  if (parts.length !== 4) {
    throw new Error("Invalid workflowRunId format");
  }

  const [repositoryId, workflowNameHash, commitHash, runId] = parts;

  const response = await dynamoClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: "GSI1",
      KeyConditionExpression: "#gsi1pk = :gsi1pk",
      ExpressionAttributeNames: {
        "#gsi1pk": "GSI1-PK",
      },
      ExpressionAttributeValues: {
        ":gsi1pk": {
          S: `workflowRun#${workflowNameHash}#${commitHash}#${runId}`,
        },
      },
    })
  );

  const jobRuns = (response.Items || [])
    .map((item) => unmarshall(item))
    .filter((item: any) => item.entityType === "jobRun") as JobRunEntity[];

  // Format response
  return jobRuns.map((run) => ({
    id: run.entityId,
    jobName: run.jobName,
    status: run.status,
    startDate: run.startedAt || run.createdAt,
    endDate:
      run.stoppedAt ||
      (run.status === "SUCCEEDED" || run.status === "FAILED"
        ? run.updatedAt
        : null),
    startedAt: run.startedAt,
    stoppedAt: run.stoppedAt,
    completedTasks: run.completedTaskCount,
    totalTasks: run.taskCount,
    taskArn: run.taskArn,
    estimatedCost: run.estimatedCost,
    downloadable: run.downloadable || false,
    downloadableArtifactsReady: run.downloadableArtifactsReady || false,
    dependsOn: run.dependsOn || [],
    storageUsage: run.storageUsage,
  }));
}

// ============================================
// Query Last N Workflow Runs (using GSI3)
// ============================================
async function getLastWorkflowRuns(limit: number): Promise<any[]> {
  const response = await dynamoClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: "GSI3",
      KeyConditionExpression: "#gsi3pk = :gsi3pk",
      ExpressionAttributeNames: {
        "#gsi3pk": "GSI3-PK",
      },
      ExpressionAttributeValues: {
        ":gsi3pk": { S: "workflowRuns" },
      },
      ScanIndexForward: false, // Sort descending (newest first)
      Limit: limit,
    })
  );

  const workflowRuns = (response.Items || []).map((item) =>
    unmarshall(item)
  ) as WorkflowRunEntity[];

  // Format response
  return workflowRuns.map((run) => ({
    id: run.entityId,
    workflowName: run.workflowName,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    entityId: run.entityId,
  }));
}

// ============================================
// Get Workflow Run Details by EntityId
// ============================================
async function getWorkflowRunByEntityId(entityId: string): Promise<any | null> {
  // Parse entityId: {repositoryId}#{workflowNameHash}#{commitHash}#{runId}
  const parts = entityId.split("#");
  if (parts.length !== 4) {
    throw new Error("Invalid entityId format");
  }

  const [repositoryId, workflowNameHash, commitHash, runId] = parts;
  const pk = `workflowRun#${repositoryId}#${workflowNameHash}#${commitHash}`;
  const sk = `${pk}#${runId}`;

  const response = await dynamoClient.send(
    new GetItemCommand({
      TableName: TABLE_NAME,
      Key: marshall({
        PK: pk,
        SK: sk,
      }),
    })
  );

  if (!response.Item) {
    return null;
  }

  const run = unmarshall(response.Item) as WorkflowRunEntity;

  // Format response with all details
  const imageBuildStatuses = Object.values(run.imageBuildJobs || {}).map(
    (job) => job.status
  );
  const succeededBuilds = imageBuildStatuses.filter(
    (s) => s === "SUCCEEDED"
  ).length;
  const failedBuilds = imageBuildStatuses.filter((s) => s === "FAILED").length;
  const runningBuilds = imageBuildStatuses.filter(
    (s) => s === "RUNNING"
  ).length;
  const pendingBuilds = imageBuildStatuses.filter(
    (s) => s === "PENDING"
  ).length;

  return {
    id: run.entityId,
    entityId: run.entityId,
    workflowName: run.workflowName,
    commitHash: run.commitHash,
    branch: run.branch,
    status: run.status,
    failureReason: run.failureReason,
    startDate: run.createdAt,
    endDate:
      run.status === "SUCCEEDED" || run.status === "FAILED"
        ? run.updatedAt
        : null,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    completedJobs: run.completedJobCount,
    totalJobs: run.jobCount,
    totalImageBuilds: run.imageBuildJobCount,
    completedImageBuilds: run.completedImageBuildJobCount,
    imageBuildStatuses: {
      succeeded: succeededBuilds,
      failed: failedBuilds,
      running: runningBuilds,
      pending: pendingBuilds,
    },
    estimatedCost: run.estimatedCost,
    storageUsage: run.storageUsage,
    githubRepositoryId: run.githubRepositoryId,
  };
}

// ============================================
// Get Image Builds by Workflow Run
// ============================================
async function getImageBuildsByWorkflowRun(
  workflowRunId: string
): Promise<any[]> {
  // Parse workflowRunId: {repositoryId}#{workflowNameHash}#{commitHash}#{runId}
  const parts = workflowRunId.split("#");
  if (parts.length !== 4) {
    throw new Error("Invalid workflowRunId format");
  }

  const [repositoryId, workflowNameHash, commitHash, runId] = parts;
  const pk = `workflowRun#${repositoryId}#${workflowNameHash}#${commitHash}`;
  const sk = `${pk}#${runId}`;

  const response = await dynamoClient.send(
    new GetItemCommand({
      TableName: TABLE_NAME,
      Key: marshall({
        PK: pk,
        SK: sk,
      }),
    })
  );

  if (!response.Item) {
    return [];
  }

  const workflowRun = unmarshall(response.Item) as WorkflowRunEntity;
  const imageBuildJobs = workflowRun.imageBuildJobs || {};

  // Convert imageBuildJobs object to array
  return Object.values(imageBuildJobs).map((build: any) => ({
    id: `${build.jobNameHash}-${build.containerIndex}`,
    jobNameHash: build.jobNameHash,
    jobName: build.jobName || "Unknown",
    containerIndex: build.containerIndex,
    containerName: build.containerName || "Image-Builder",
    status: build.status,
    taskArn: build.taskArn,
    exitCode: build.exitCode,
    reason: build.reason,
    startedAt: build.startedAt,
    stoppedAt: build.stoppedAt,
    dockerfilePath: build.dockerfilePath,
    estimatedCost: build.estimatedCost,
    commitHash: commitHash,
    workflowNameHash: workflowNameHash,
  }));
}

// ============================================
// Get Logs from CloudWatch
// ============================================
async function getLogs(logStream: string): Promise<any> {
  try {
    const response = await cloudWatchLogsClient.send(
      new GetLogEventsCommand({
        logGroupName: LOG_GROUP_NAME,
        logStreamName: logStream,
        limit: 1000, // Get up to 1000 log events
        startFromHead: false, // Get most recent logs first
      })
    );

    if (!response.events || response.events.length === 0) {
      return {
        logStream,
        logGroup: LOG_GROUP_NAME,
        events: [],
        message: "No log events found",
      };
    }

    // Sort events by timestamp (oldest first)
    const sortedEvents = (response.events || []).sort(
      (a: any, b: any) => (a.timestamp || 0) - (b.timestamp || 0)
    );

    return {
      logStream,
      logGroup: LOG_GROUP_NAME,
      events: sortedEvents.map((event: any) => ({
        timestamp: event.timestamp,
        message: event.message,
        ingestionTime: event.ingestionTime,
      })),
    };
  } catch (error: any) {
    console.error("Error fetching logs:", error);
    return {
      logStream,
      logGroup: LOG_GROUP_NAME,
      error: error.message,
      events: [],
    };
  }
}

// ============================================
// Trigger Downloadable for Job Run
// ============================================
async function triggerDownloadableForJobRun(jobRunId: string): Promise<any> {
  // Parse jobRunId: {workflowNameHash}#{jobNameHash}#{commitHash}#{runId}
  const parts = jobRunId.split("#");
  if (parts.length !== 4) {
    throw new Error("Invalid jobRunId format");
  }

  const [workflowNameHash, jobNameHash, commitHash, runId] = parts;

  // Construct PK and SK directly from entityId (PK doesn't include runId, SK does)
  const jobRunPK = `jobRun#${workflowNameHash}#${jobNameHash}#${commitHash}`;
  const jobRunSK = `${jobRunPK}#${runId}`;

  // Get job run
  const jobRunResponse = await dynamoClient.send(
    new GetItemCommand({
      TableName: TABLE_NAME,
      Key: marshall({
        PK: jobRunPK,
        SK: jobRunSK,
      }),
    })
  );

  if (!jobRunResponse.Item) {
    throw new Error("Job run not found");
  }

  const jobRun = unmarshall(jobRunResponse.Item);

  // Check if job is already downloadable
  if (jobRun.downloadable) {
    return {
      message: "Job run is already marked as downloadable",
      downloadable: true,
    };
  }

  // Update job run to set downloadable = true
  await dynamoClient.send(
    new UpdateItemCommand({
      TableName: TABLE_NAME,
      Key: marshall({
        PK: jobRun.PK,
        SK: jobRun.SK,
      }),
      UpdateExpression:
        "SET downloadable = :downloadable, updatedAt = :updatedAt",
      ExpressionAttributeValues: marshall({
        ":downloadable": true,
        ":updatedAt": new Date().toISOString(),
      }),
    })
  );

  // Trigger downloadable creator task (similar to task-state-change-handler)
  const family = `downloadableCreator-${commitHash}-${runId}-${workflowNameHash}-${jobNameHash}`;
  const s3OutputLocation = `s3://${process.env.S3_BUCKET_NAME}/hyperp-artifacts/${commitHash}/${runId}/${workflowNameHash}/${jobNameHash}/artifacts.zip`;

  const taskDefinition: any = {
    family: family,
    networkMode: "awsvpc",
    requiresCompatibilities: ["FARGATE"],
    cpu: "1024",
    memory: "2048",
    executionRoleArn: process.env.ECS_TASK_EXECUTION_ROLE_ARN!,
    taskRoleArn: process.env.ECS_TASK_ROLE_ARN!,
    containerDefinitions: [
      {
        name: "DownloadableArtifactsCreator",
        image: process.env.DOWNLOADABLE_CREATOR_IMAGE!,
        essential: true,
        environment: [
          {
            name: "INPUT_DIR",
            value: "/input",
          },
          {
            name: "S3_OUTPUT_LOCATION",
            value: s3OutputLocation,
          },
        ],
        mountPoints: [
          {
            sourceVolume: "volume-input",
            containerPath: "/input",
            readOnly: true,
          },
        ],
        logConfiguration: {
          logDriver: "awslogs" as const,
          options: {
            "awslogs-group": "/hyperp",
            "awslogs-region": process.env.AWS_REGION!,
            "awslogs-stream-prefix": `${commitHash}/${workflowNameHash}/${jobNameHash}/downloadable`,
          },
        },
      },
    ],
    volumes: [
      {
        name: "volume-input",
        efsVolumeConfiguration: {
          fileSystemId: process.env.EFS_FILE_SYSTEM_ID!,
          rootDirectory: jobRun.efsOutputLocation,
          transitEncryption: "ENABLED" as const,
        },
      },
    ],
  };

  try {
    await ecsClient.send(new RegisterTaskDefinitionCommand(taskDefinition));
    console.log(`Registered task definition: ${family}`);

    const runTaskInput = {
      cluster: process.env.ECS_CLUSTER_NAME!,
      taskDefinition: family,
      launchType: "FARGATE" as const,
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: process.env.PUBLIC_SUBNET_IDS?.split(",") || [],
          securityGroups: [process.env.ECS_TASK_SECURITY_GROUP_ID!],
          assignPublicIp: "ENABLED" as const,
        },
      },
    };

    const runTaskResponse = await ecsClient.send(
      new RunTaskCommand(runTaskInput)
    );

    return {
      message: "Downloadable creator task triggered successfully",
      taskArn: runTaskResponse.tasks?.[0]?.taskArn,
      downloadable: true,
    };
  } catch (error: any) {
    console.error("Error triggering downloadable creator task:", error);
    throw new Error(
      `Failed to trigger downloadable creator task: ${error.message}`
    );
  }
}

// ============================================
// Get Download URL for Job Run
// ============================================
async function getDownloadUrlForJobRun(jobRunId: string): Promise<any> {
  // Parse jobRunId: {workflowNameHash}#{jobNameHash}#{commitHash}#{runId}
  const parts = jobRunId.split("#");
  if (parts.length !== 4) {
    throw new Error("Invalid jobRunId format");
  }

  const [workflowNameHash, jobNameHash, commitHash, runId] = parts;

  // Construct PK and SK directly from entityId (PK doesn't include runId, SK does)
  const jobRunPK = `jobRun#${workflowNameHash}#${jobNameHash}#${commitHash}`;
  const jobRunSK = `${jobRunPK}#${runId}`;

  // Get job run
  const jobRunResponse = await dynamoClient.send(
    new GetItemCommand({
      TableName: TABLE_NAME,
      Key: marshall({
        PK: jobRunPK,
        SK: jobRunSK,
      }),
    })
  );

  if (!jobRunResponse.Item) {
    throw new Error("Job run not found");
  }

  const jobRun = unmarshall(jobRunResponse.Item);

  // Check if artifacts are ready
  if (!jobRun.downloadableArtifactsReady) {
    throw new Error("Downloadable artifacts are not ready yet");
  }

  // Generate presigned URL for the S3 object (includes runId in path)
  const s3Key = `hyperp-artifacts/${commitHash}/${runId}/${workflowNameHash}/${jobNameHash}/artifacts.zip`;

  const command = new GetObjectCommand({
    Bucket: S3_BUCKET_NAME,
    Key: s3Key,
  });

  // Generate presigned URL valid for 1 hour
  const presignedUrl = await getSignedUrl(s3Client, command, {
    expiresIn: 3600, // 1 hour
  });

  return {
    downloadUrl: presignedUrl,
    expiresIn: 3600,
    jobName: jobRun.jobName,
    s3Location: `s3://${S3_BUCKET_NAME}/${s3Key}`,
  };
}

// ============================================
// Get Tasks by Job Run
// ============================================
async function getTasksByJobRun(jobRunId: string): Promise<any[]> {
  // Parse jobRunId: {workflowNameHash}#{jobNameHash}#{commitHash}#{runId}
  const parts = jobRunId.split("#");
  if (parts.length !== 4) {
    throw new Error("Invalid jobRunId format");
  }

  const [workflowNameHash, jobNameHash, commitHash, runId] = parts;

  // Construct GSI1-PK for querying tasks (includes runId)
  const taskGSI1PK = `jobRun#${workflowNameHash}#${jobNameHash}#${commitHash}#${runId}`;

  const response = await dynamoClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: "GSI1",
      KeyConditionExpression: "#gsi1pk = :gsi1pk",
      ExpressionAttributeNames: {
        "#gsi1pk": "GSI1-PK",
      },
      ExpressionAttributeValues: marshall({
        ":gsi1pk": taskGSI1PK,
      }),
    })
  );

  const tasks = (response.Items || [])
    .map((item) => unmarshall(item))
    .filter((item: any) => item.entityType === "task");

  // Format response
  return tasks.map((task) => ({
    id: task.entityId,
    taskArn: task.taskArn,
    status: task.lastStatus,
    pullStartedAt: task.pullStartedAt,
    stoppedAt: task.stoppedAt,
    stoppedReason: task.stoppedReason,
    estimatedCost: task.estimatedCost,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  }));
}

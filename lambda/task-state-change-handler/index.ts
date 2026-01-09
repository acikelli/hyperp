import {
  DynamoDBClient,
  GetItemCommand,
  UpdateItemCommand,
  QueryCommand,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import {
  ECSClient,
  RegisterTaskDefinitionCommand,
  RunTaskCommand,
  DescribeTasksCommand,
  NetworkMode,
  LaunchType,
  LogDriver,
  AssignPublicIp,
  EFSTransitEncryption,
  Compatibility,
} from "@aws-sdk/client-ecs";
import { ECRClient, BatchDeleteImageCommand } from "@aws-sdk/client-ecr";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import GithubHelper from "./githubHelper";
import * as crypto from "crypto";

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

function parseImageBuildFamily(family: string): {
  commitHash: string;
  workflowNameHash: string;
  jobNameHash: string;
  containerIndex: number;
  repositoryId: string;
  runId: string;
} | null {
  const match = family.match(
    /^image-build-([^-]+)-([^-]+)-([^-]+)-([^-]+)-(\d+)-(.+)$/
  );
  if (!match) return null;
  return {
    repositoryId: match[1],
    commitHash: match[2],
    workflowNameHash: match[3],
    jobNameHash: match[4],
    containerIndex: parseInt(match[5], 10),
    runId: match[6],
  };
}

function parseJobRunFamily(family: string): {
  commitHash: string;
  workflowNameHash: string;
  jobNameHash: string;
  runId: string;
} | null {
  const match = family.match(/^jobRun-([^-]+)-([^-]+)-([^-]+)-(.+)$/);
  if (!match) return null;
  return {
    commitHash: match[1],
    workflowNameHash: match[2],
    jobNameHash: match[3],
    runId: match[4],
  };
}

function parseDownloadableCreatorFamily(family: string): {
  commitHash: string;
  runId: string;
  workflowNameHash: string;
  jobNameHash: string;
} | null {
  const match = family.match(
    /^downloadableCreator-([^-]+)-([^-]+)-([^-]+)-([^-]+)$/
  );
  if (!match) return null;
  return {
    commitHash: match[1],
    runId: match[2],
    workflowNameHash: match[3],
    jobNameHash: match[4],
  };
}

// ============================================
// Main Handler
// ============================================
const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const ecsClient = new ECSClient({ region: process.env.AWS_REGION });
const ecrClient = new ECRClient({ region: process.env.AWS_REGION });
const lambdaClient = new LambdaClient({ region: process.env.AWS_REGION });

const TABLE_NAME = process.env.DYNAMODB_TABLE_NAME!;
const ECS_CLUSTER = process.env.ECS_CLUSTER_ARN!;
const ECS_CLUSTER_NAME = process.env.ECS_CLUSTER_NAME!;
const ECR_REPOSITORY_URI = process.env.ECR_REPOSITORY_URI!;
const ECS_TASK_EXECUTION_ROLE_ARN = process.env.ECS_TASK_EXECUTION_ROLE_ARN!;
const ECS_TASK_ROLE_ARN = process.env.ECS_TASK_ROLE_ARN!;
const EFS_FILE_SYSTEM_ID = process.env.EFS_FILE_SYSTEM_ID!;
const ECS_TASK_SECURITY_GROUP_ID = process.env.ECS_TASK_SECURITY_GROUP_ID!;
const PUBLIC_SUBNET_IDS = process.env.PUBLIC_SUBNET_IDS!.split(",");
const EFS_CONTROLLER_LAMBDA_ARN = process.env.EFS_CONTROLLER_LAMBDA_ARN!;
const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME!;

// Fargate pricing constants (per hour)
const FARGATE_VCPU_PRICE_PER_HOUR = parseFloat(
  process.env.FARGATE_VCPU_PRICE_PER_HOUR || "0.04048"
);
const FARGATE_GB_PRICE_PER_HOUR = parseFloat(
  process.env.FARGATE_GB_PRICE_PER_HOUR || "0.004445"
);

export const handler = async (event: any): Promise<any> => {
  console.log("Task state change event:", JSON.stringify(event, null, 2));

  try {
    const detail = event.detail;
    const taskArn = detail.taskArn;
    const lastStatus = detail.lastStatus;
    const stoppedReason = detail.stoppedReason;
    const containers = detail.containers || [];
    const pullStartedAt = detail.pullStartedAt; // When container image pull started
    const stoppedAt = detail.stoppedAt; // When task stopped

    // Only process STOPPED tasks
    if (lastStatus !== "STOPPED") {
      console.log(`Ignoring task with status: ${lastStatus}`);
      return;
    }

    // Get task definition family
    const taskDefinitionArn = detail.taskDefinitionArn;
    const family = taskDefinitionArn.split("/")[1].split(":")[0];

    console.log(`Processing stopped task with family: ${family}`);

    // Determine if this is an image build, job run, or downloadable creator task
    const imageBuildInfo = parseImageBuildFamily(family);
    const jobRunInfo = parseJobRunFamily(family);
    const downloadableCreatorInfo = parseDownloadableCreatorFamily(family);

    if (imageBuildInfo) {
      await handleImageBuildTaskComplete(
        imageBuildInfo,
        containers,
        taskArn,
        detail,
        pullStartedAt,
        stoppedAt
      );
    } else if (jobRunInfo) {
      await handleJobRunTaskComplete(
        jobRunInfo,
        containers,
        taskArn,
        pullStartedAt,
        stoppedAt,
        detail
      );
    } else if (downloadableCreatorInfo) {
      await handleDownloadableCreatorTaskComplete(
        downloadableCreatorInfo,
        containers,
        taskArn
      );
    } else {
      console.log(`Unknown task family format: ${family}`);
    }

    return { statusCode: 200 };
  } catch (error) {
    console.error("Error processing task state change:", error);
    throw error;
  }
};

// ============================================
// Calculate Fargate Pricing
// ============================================
function calculateFargatePricing(
  detail: any,
  containers: any[],
  pullStartedAt?: string,
  stoppedAt?: string
): number | null {
  // Only calculate for Fargate launch type
  if (detail.launchType !== "FARGATE") {
    return null;
  }

  if (!pullStartedAt || !stoppedAt) {
    console.log("Missing pullStartedAt or stoppedAt, cannot calculate pricing");
    return null;
  }

  // Calculate duration in seconds
  const startTime = new Date(pullStartedAt).getTime();
  const endTime = new Date(stoppedAt).getTime();
  const durationSeconds = Math.max(60, Math.ceil((endTime - startTime) / 1000)); // Minimum 60 seconds (1 minute)

  // Convert to hours
  const durationHours = durationSeconds / 3600;

  // CPU is in CPU units (1024 = 1 vCPU)
  const cpu = detail.cpu / 1024;
  // Memory is in MB
  const memoryGB = detail.memory / 1024;

  if (cpu === 0 || memoryGB === 0) {
    console.log("Missing CPU or memory information, cannot calculate pricing");
    return null;
  }

  // Calculate pricing: (vCPU * price_per_vCPU_per_hour + GB * price_per_GB_per_hour) * hours
  const vcpuCost = cpu * FARGATE_VCPU_PRICE_PER_HOUR * durationHours;
  const memoryCost = memoryGB * FARGATE_GB_PRICE_PER_HOUR * durationHours;
  const totalCost = vcpuCost + memoryCost;

  console.log(
    `Fargate pricing: ${cpu} vCPU, ${memoryGB} GB, ${durationSeconds}s (${durationHours.toFixed(
      4
    )}h) = $${totalCost.toFixed(4)}`
  );

  return totalCost;
}

// ============================================
// Delete Image from ECR
// ============================================
async function deleteImageFromECR(imageUri: string): Promise<void> {
  // Parse image URI: <account>.dkr.ecr.<region>.amazonaws.com/<repo>:<tag>
  // Extract repository name and image tag
  const uriParts = imageUri.split("/");
  if (uriParts.length !== 2) {
    console.error(`Invalid image URI format: ${imageUri}`);
    return;
  }

  const [repositoryName, imageTag] = uriParts[1].split(":");

  if (!repositoryName || !imageTag) {
    console.error(`Invalid image URI format (missing tag): ${imageUri}`);
    return;
  }

  console.log(
    `Deleting image from ECR: repository=${repositoryName}, tag=${imageTag}`
  );

  try {
    await ecrClient.send(
      new BatchDeleteImageCommand({
        repositoryName: repositoryName,
        imageIds: [
          {
            imageTag: imageTag,
          },
        ],
      })
    );
    console.log(
      `Successfully deleted image ${imageTag} from repository ${repositoryName}`
    );
  } catch (error: any) {
    // If image doesn't exist, that's okay - just log and continue
    if (error.name === "ImageNotFoundException") {
      console.log(
        `Image ${imageTag} not found in repository ${repositoryName}, skipping deletion`
      );
      return;
    }
    throw error;
  }
}

// ============================================
// Handle Image Build Task Completion
// ============================================
async function handleImageBuildTaskComplete(
  buildInfo: any,
  containers: any[],
  taskArn: string,
  detail: any,
  pullStartedAt?: string,
  stoppedAt?: string
): Promise<void> {
  console.log("Handling image build task completion:", buildInfo);

  const {
    commitHash,
    workflowNameHash,
    jobNameHash,
    containerIndex,
    repositoryId,
    runId,
  } = buildInfo;

  // Check if all containers exited successfully
  const allSucceeded = containers.every((c) => c.exitCode === 0);
  const exitCode = containers[0]?.exitCode;

  console.log(
    `Image build task status: ${
      allSucceeded ? "SUCCEEDED" : "FAILED"
    }, exitCode: ${exitCode}`
  );

  // Calculate pricing
  const estimatedCost = calculateFargatePricing(
    detail,
    containers,
    pullStartedAt,
    stoppedAt
  );

  // Build the image build job status object
  const imageBuildKey = `${jobNameHash}-${containerIndex}`;
  const imageBuildJobStatus: any = {
    status: allSucceeded ? "SUCCEEDED" : "FAILED",
    exitCode: exitCode,
    taskArn: taskArn,
    stoppedAt: stoppedAt || new Date().toISOString(),
  };

  if (pullStartedAt) {
    imageBuildJobStatus.startedAt = pullStartedAt;
  }
  if (estimatedCost !== null) {
    imageBuildJobStatus.estimatedCost = estimatedCost;
  }

  // Construct workflow run PK/SK
  const workflowRunPK = `workflowRun#${repositoryId}#${workflowNameHash}#${commitHash}`;
  const workflowRunSK = `${workflowRunPK}#${runId}`;

  // Update workflow run directly - update nested map and increment counter
  let updatedWorkflowRun: any = null;
  if (allSucceeded) {
    const updateResponse = await dynamoClient.send(
      new UpdateItemCommand({
        TableName: TABLE_NAME,
        Key: marshall({
          PK: workflowRunPK,
          SK: workflowRunSK,
        }),
        UpdateExpression:
          "SET imageBuildJobs.#imageBuildKey = :imageBuildJobStatus, updatedAt = :updatedAt ADD completedImageBuildJobCount :inc",
        ExpressionAttributeNames: {
          "#imageBuildKey": imageBuildKey,
        },
        ExpressionAttributeValues: marshall({
          ":imageBuildJobStatus": imageBuildJobStatus,
          ":inc": 1,
          ":updatedAt": new Date().toISOString(),
        }),
        ReturnValues: "ALL_NEW",
      })
    );

    // Extract updated workflow run from response
    if (updateResponse.Attributes) {
      updatedWorkflowRun = unmarshall(updateResponse.Attributes);
    }
  } else {
    // Image build failed, mark workflow as failed
    const updateResponse = await dynamoClient.send(
      new UpdateItemCommand({
        TableName: TABLE_NAME,
        Key: marshall({
          PK: workflowRunPK,
          SK: workflowRunSK,
        }),
        UpdateExpression:
          "SET imageBuildJobs.#imageBuildKey = :imageBuildJobStatus, #status = :failedStatus, updatedAt = :updatedAt",
        ExpressionAttributeNames: {
          "#imageBuildKey": imageBuildKey,
          "#status": "status",
        },
        ExpressionAttributeValues: marshall({
          ":imageBuildJobStatus": imageBuildJobStatus,
          ":failedStatus": "FAILED",
          ":updatedAt": new Date().toISOString(),
        }),
        ReturnValues: "ALL_NEW",
      })
    );

    if (updateResponse.Attributes) {
      updatedWorkflowRun = unmarshall(updateResponse.Attributes);
    }
  }

  console.log("Updated workflow run with image build status");

  // If build succeeded, save image URI to job entity for caching
  if (allSucceeded) {
    // Delete old image will be handled after update
    const imageTag = `${commitHash}-${workflowNameHash}-${jobNameHash}-${containerIndex}`;
    const imageUri = `${ECR_REPOSITORY_URI}:${imageTag}`;

    console.log(`Saving cached image URI for job ${jobNameHash}: ${imageUri}`);

    try {
      // Update job entity and get old lastImageUri
      const updateResponse = await dynamoClient.send(
        new UpdateItemCommand({
          TableName: TABLE_NAME,
          Key: marshall({
            PK: `job#${repositoryId}#${workflowNameHash}#${jobNameHash}`,
            SK: `job#${repositoryId}#${workflowNameHash}#${jobNameHash}`,
          }),
          UpdateExpression:
            "SET lastImageUri = :imageUri, lastImageBuildCommitHash = :commitHash, updatedAt = :updatedAt",
          ExpressionAttributeValues: marshall({
            ":imageUri": imageUri,
            ":commitHash": commitHash,
            ":updatedAt": new Date().toISOString(),
          }),
          ReturnValues: "UPDATED_OLD",
        })
      );

      // Extract old lastImageUri from response
      const oldAttributes = updateResponse.Attributes
        ? unmarshall(updateResponse.Attributes)
        : {};
      const oldImageUri = oldAttributes.lastImageUri;

      console.log(`Successfully saved cached image for job ${jobNameHash}`);

      // Delete old image from ECR if it exists and is different from new one
      if (oldImageUri && oldImageUri !== imageUri) {
        try {
          await deleteImageFromECR(oldImageUri);
          console.log(
            `Successfully deleted old image from ECR: ${oldImageUri}`
          );
        } catch (error) {
          console.error(
            `Error deleting old image from ECR: ${oldImageUri}`,
            error
          );
          // Don't fail the whole operation if image deletion fails
        }
      }
    } catch (error) {
      console.error(`Error saving cached image for job ${jobNameHash}:`, error);
    }
  }

  // Check if all image builds are complete
  if (allSucceeded && updatedWorkflowRun) {
    if (
      updatedWorkflowRun.completedImageBuildJobCount ===
        updatedWorkflowRun.imageBuildJobCount &&
      updatedWorkflowRun.status !== "RUNNING"
    ) {
      console.log("All image builds complete, starting workflow");

      // Update status to RUNNING
      await dynamoClient.send(
        new UpdateItemCommand({
          TableName: TABLE_NAME,
          Key: marshall({
            PK: workflowRunPK,
            SK: workflowRunSK,
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

      // Start workflow jobs
      await startWorkflowJobs(updatedWorkflowRun);
    }
  }
}

// ============================================
// Handle Job Run Task Completion
// ============================================
async function handleJobRunTaskComplete(
  jobInfo: any,
  containers: any[],
  taskArn: string,
  pullStartedAt?: string,
  stoppedAt?: string,
  detail?: any
): Promise<void> {
  console.log("Handling job run task completion:", jobInfo);

  const { commitHash, workflowNameHash, jobNameHash, runId } = jobInfo;

  // Check if all containers exited successfully
  const allSucceeded = containers.every((c) => c.exitCode === 0);

  console.log(`Job run task status: ${allSucceeded ? "SUCCEEDED" : "FAILED"}`);

  // TODO: remove this with a refactor
  const jobRunResponse = await dynamoClient.send(
    new GetItemCommand({
      TableName: TABLE_NAME,
      Key: marshall({
        PK: `jobRun#${workflowNameHash}#${jobNameHash}#${commitHash}`,
        SK: `jobRun#${workflowNameHash}#${jobNameHash}#${commitHash}#${runId}`,
      }),
    })
  );

  const jobRun = unmarshall(jobRunResponse.Item!);
  const jobRunEntityId = jobRun.entityId; // {workflowNameHash}#{jobNameHash}#{commitHash}

  // Calculate pricing if detail is available
  let taskEstimatedCost: number | null = null;
  if (detail) {
    taskEstimatedCost = calculateFargatePricing(
      detail,
      containers,
      pullStartedAt,
      stoppedAt
    );
  }

  const timestamp = new Date().toISOString();
  const lastStatus = allSucceeded ? "SUCCEEDED" : "FAILED";
  const stoppedReason = detail?.stoppedReason;

  // Create or update task entity (always use PutItemCommand - will overwrite if exists)
  const taskPK = `task#${taskArn}`;
  const taskSK = taskPK; // PK and SK are the same for tasks
  const taskGSI1PK = `jobRun#${workflowNameHash}#${jobNameHash}#${commitHash}#${runId}`;
  const taskGSI1SK = `task#${taskArn}`;

  const taskEntity = {
    PK: taskPK,
    SK: taskSK,
    "GSI1-PK": taskGSI1PK,
    "GSI1-SK": taskGSI1SK,
    entityType: "task",
    entityId: taskArn,
    taskArn: taskArn,
    jobRunEntityId: jobRunEntityId,
    lastStatus: lastStatus,
    stoppedReason: stoppedReason,
    pullStartedAt: pullStartedAt,
    stoppedAt: stoppedAt,
    estimatedCost: taskEstimatedCost,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  await dynamoClient.send(
    new PutItemCommand({
      TableName: TABLE_NAME,
      Item: marshall(taskEntity),
    })
  );

  console.log(`Created/updated task entity: ${taskArn}`);

  // If task failed, mark job as failed immediately
  if (!allSucceeded) {
    // Update job run status to FAILED
    await dynamoClient.send(
      new UpdateItemCommand({
        TableName: TABLE_NAME,
        Key: marshall({
          PK: jobRun.PK,
          SK: jobRun.SK,
        }),
        UpdateExpression: "SET #status = :failedStatus, updatedAt = :updatedAt",
        ExpressionAttributeNames: {
          "#status": "status",
        },
        ExpressionAttributeValues: marshall({
          ":failedStatus": "FAILED",
          ":updatedAt": timestamp,
        }),
      })
    );

    console.log("Job run failed, marking workflow as FAILED");
    await failWorkflowRun(
      commitHash,
      workflowNameHash,
      jobRun.githubRepositoryId,
      jobRun.runId
    );
    return;
  }

  // If task succeeded, update job run's completed task count
  if (allSucceeded) {
    // Build SET and ADD expressions for job run update
    const setExpressions: string[] = [];
    const addExpressions: string[] = [];
    const expressionAttributeNames: Record<string, string> = {};
    const expressionAttributeValues: Record<string, any> = {};

    // Set startedAt from pullStartedAt if not already set (first task to start)
    if (pullStartedAt && !jobRun.startedAt) {
      setExpressions.push("startedAt = :startedAt");
      expressionAttributeValues[":startedAt"] = pullStartedAt;
      console.log(`Setting startedAt to pullStartedAt: ${pullStartedAt}`);
    }

    // Increment completed task count
    addExpressions.push("completedTaskCount :inc");
    expressionAttributeValues[":inc"] = 1;

    setExpressions.push("updatedAt = :updatedAt");
    expressionAttributeValues[":updatedAt"] = timestamp;

    // Build UpdateExpression with SET and ADD clauses
    const updateParts: string[] = [];
    if (setExpressions.length > 0) {
      updateParts.push(`SET ${setExpressions.join(", ")}`);
    }
    if (addExpressions.length > 0) {
      updateParts.push(`ADD ${addExpressions.join(", ")}`);
    }

    // Update job run and get updated values
    const updateResponse = await dynamoClient.send(
      new UpdateItemCommand({
        TableName: TABLE_NAME,
        Key: marshall({
          PK: jobRun.PK,
          SK: jobRun.SK,
        }),
        UpdateExpression: updateParts.join(" "),
        ExpressionAttributeNames:
          Object.keys(expressionAttributeNames).length > 0
            ? expressionAttributeNames
            : undefined,
        ExpressionAttributeValues: marshall(expressionAttributeValues),
        ReturnValues: "UPDATED_NEW",
      })
    );

    // Extract updated job run from response and merge with original
    let updatedJob: any = { ...jobRun };
    if (updateResponse.Attributes) {
      const updatedAttributes = unmarshall(updateResponse.Attributes);
      updatedJob = { ...jobRun, ...updatedAttributes };
    }

    console.log("Updated job run with task completion");

    // Check if job is complete
    if (updatedJob.completedTaskCount === updatedJob.taskCount) {
      // Set stoppedAt when job completes
      await dynamoClient.send(
        new UpdateItemCommand({
          TableName: TABLE_NAME,
          Key: marshall({
            PK: jobRun.PK,
            SK: jobRun.SK,
          }),
          UpdateExpression:
            "SET stoppedAt = :stoppedAt, updatedAt = :updatedAt",
          ExpressionAttributeValues: marshall({
            ":stoppedAt": stoppedAt || timestamp,
            ":updatedAt": new Date().toISOString(),
          }),
        })
      );
      console.log(`Setting stoppedAt: ${stoppedAt || timestamp}`);
      console.log("Job completed successfully");

      // Update job status to SUCCEEDED
      await dynamoClient.send(
        new UpdateItemCommand({
          TableName: TABLE_NAME,
          Key: marshall({
            PK: jobRun.PK,
            SK: jobRun.SK,
          }),
          UpdateExpression: "SET #status = :status, updatedAt = :updatedAt",
          ExpressionAttributeNames: {
            "#status": "status",
          },
          ExpressionAttributeValues: marshall({
            ":status": "SUCCEEDED",
            ":updatedAt": new Date().toISOString(),
          }),
        })
      );

      // Increment dependent jobs' completed dependency count
      for (const dependentJobId of updatedJob.dependentJobIds || []) {
        await incrementDependencyCount(
          dependentJobId,
          commitHash,
          workflowNameHash,
          runId
        );
      }

      // Increment workflow run's completed job count
      await incrementWorkflowJobCount(
        commitHash,
        workflowNameHash,
        updatedJob.githubRepositoryId,
        updatedJob.runId
      );

      // If job is downloadable, trigger downloadable creator task
      if (updatedJob.downloadable) {
        console.log(
          `Job ${updatedJob.jobName} is downloadable, triggering artifact creation`
        );
        await triggerDownloadableCreatorTask(
          updatedJob,
          commitHash,
          workflowNameHash
        );
      }
    }
  }
}

// ============================================
// Start Workflow Jobs
// ============================================
async function startWorkflowJobs(workflowRun: any): Promise<void> {
  console.log("Starting workflow jobs for workflow run:", workflowRun.entityId);

  // Get all job runs for this workflow
  const jobRunsResponse = await dynamoClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: "GSI1",
      KeyConditionExpression: "#gsi1pk = :gsi1pk",
      ExpressionAttributeNames: {
        "#gsi1pk": "GSI1-PK",
      },
      ExpressionAttributeValues: marshall({
        ":gsi1pk": `workflowRun#${workflowRun.workflowNameHash}#${workflowRun.commitHash}#${workflowRun.runId}`,
      }),
    })
  );

  const jobRuns = (jobRunsResponse.Items || []).map((item) => unmarshall(item));

  // Start jobs with no dependencies
  for (const jobRun of jobRuns) {
    if (jobRun.dependencyCount === 0 && jobRun.status === "PENDING") {
      await startJobRun(jobRun, workflowRun);
    }
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
// Start Job Run
// ============================================
async function startJobRun(jobRun: any, workflowRun: any): Promise<void> {
  console.log(`Starting job run: ${jobRun.jobName}`);

  // Parse entityId: {workflowNameHash}#{jobNameHash}#{commitHash}
  const entityIdParts = jobRun.entityId.split("#");
  const workflowNameHash = entityIdParts[0];
  const jobNameHash = entityIdParts[1];
  const commitHash = entityIdParts[2] || jobRun.commitHash; // Fallback to jobRun.commitHash for backward compatibility

  // Get runId from jobRun
  const runId = jobRun.runId;

  // Create EFS directory
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

  // Get the image URI for this job (cached or new)
  const imageUri = workflowRun.jobImageUris?.[jobNameHash];

  let finalImageUri: string;
  if (!imageUri) {
    console.error(`No image URI found for job ${jobNameHash} in workflow run`);
    // Fallback to new image tag
    const imageTag = `${commitHash}-${workflowNameHash}-${jobNameHash}-0`;
    finalImageUri = `${ECR_REPOSITORY_URI}:${imageTag}`;
  } else {
    finalImageUri = imageUri;
  }

  console.log(`Using image for ${jobRun.jobName}: ${finalImageUri}`);

  const family = `jobRun-${commitHash}-${workflowNameHash}-${jobNameHash}-${runId}`;

  // Use dependsOnJobIds to construct dependency EFS paths directly
  // EFS output location pattern: /hyperp-artifacts/${commitHash}/${runId}/${workflowNameHash}/${jobNameHash}
  const dependencyJobIds = jobRun.dependsOnJobIds || [];
  if (dependencyJobIds.length > 0) {
    console.log(
      `Job has ${dependencyJobIds.length} dependencies, constructing their EFS locations`
    );
  }

  // Build mount points and volumes
  const mountPoints: any[] = [
    {
      sourceVolume: "volume-output",
      containerPath: "/output",
      readOnly: false,
    },
  ];

  const volumes: any[] = [
    {
      name: "volume-output",
      efsVolumeConfiguration: {
        fileSystemId: EFS_FILE_SYSTEM_ID,
        rootDirectory: jobOutputDir,
        transitEncryption: "ENABLED",
      },
    },
  ];

  // Add dependency volumes and mount points using dependsOnJobIds
  // EFS output location pattern: /hyperp-artifacts/${commitHash}/${runId}/${workflowNameHash}/${jobNameHash}
  // We can construct EFS paths directly from job IDs without fetching job runs
  // Use dependsOn array (job names) to get mount path names - order matches dependsOnJobIds
  const dependsOnJobNames = jobRun.dependsOn || [];
  for (let i = 0; i < dependencyJobIds.length; i++) {
    const depJobId = dependencyJobIds[i];
    const depJobName = dependsOnJobNames[i] || depJobId; // Use job name from dependsOn, fallback to job ID

    // Construct EFS output location using the structural pattern
    const depEfsOutputLocation = `/hyperp-artifacts/${commitHash}/${runId}/${workflowNameHash}/${depJobId}`;
    const volumeName = `volume-${depJobId}`;

    volumes.push({
      name: volumeName,
      efsVolumeConfiguration: {
        fileSystemId: EFS_FILE_SYSTEM_ID,
        rootDirectory: depEfsOutputLocation,
        transitEncryption: "ENABLED",
      },
    });

    mountPoints.push({
      sourceVolume: volumeName,
      containerPath: `/input/${depJobName}`,
      readOnly: true,
    });

    console.log(
      `Added input mount for dependency ${depJobName} (${depJobId}): ${depEfsOutputLocation} -> /input/${depJobName}`
    );
  }

  // Add shared volumes if defined in workflow run
  const sharedVolumes = workflowRun.sharedVolumes || [];
  for (const sharedVolume of sharedVolumes) {
    const volumeName = `volume-shared-${sharedVolume.name}`;
    const sharedVolumePath = `/hyperp-artifacts/${commitHash}/${runId}/${workflowNameHash}/${sharedVolume.name}`;

    volumes.push({
      name: volumeName,
      efsVolumeConfiguration: {
        fileSystemId: EFS_FILE_SYSTEM_ID,
        rootDirectory: sharedVolumePath,
        transitEncryption: "ENABLED",
      },
    });

    mountPoints.push({
      sourceVolume: volumeName,
      containerPath: `/shared/${sharedVolume.name}`,
      readOnly: false, // Shared volumes are read-write
    });

    console.log(
      `Added shared volume mount: ${sharedVolume.name} -> /shared/${sharedVolume.name}`
    );
  }

  // Fetch task definition from GitHub
  const taskDefPath = workflowRun.taskDefinitionPaths?.[jobRun.jobName];
  if (!taskDefPath) {
    console.error(`No task definition path found for job ${jobRun.jobName}`);
    return;
  }

  if (!jobRun.owner || !jobRun.repo || !jobRun.installationId) {
    console.error(
      `Missing GitHub information for job run: owner=${jobRun.owner}, repo=${jobRun.repo}, installationId=${jobRun.installationId}`
    );
    return;
  }

  // Create installation access token
  const accessTokenData = await GithubHelper.createInstallationAccessToken(
    jobRun.installationId
  );
  const accessToken = accessTokenData.token;

  // Fetch task definition from GitHub
  const taskDefContent = await GithubHelper.getRepositoryContent(
    accessToken,
    jobRun.owner,
    jobRun.repo,
    taskDefPath,
    commitHash
  );

  if (!taskDefContent || !taskDefContent.content) {
    console.error(`Could not fetch task definition for ${jobRun.jobName}`);
    return;
  }

  const taskDefTemplate = JSON.parse(
    Buffer.from(taskDefContent.content, "base64").toString("utf-8")
  );

  // Use template and override fields while keeping the logic the same
  // Replace dockerfilePath with actual image URI
  for (let i = 0; i < taskDefTemplate.containerDefinitions.length; i++) {
    const container = taskDefTemplate.containerDefinitions[i];
    container.name = generateHash(jobRun.jobName);
    if (container.dockerfilePath) {
      container.image = finalImageUri;
      delete container.dockerfilePath;
    }
  }

  // Update volumes and mount points
  taskDefTemplate.volumes = taskDefTemplate.volumes || [];
  if (taskDefTemplate.containerDefinitions[0]) {
    taskDefTemplate.containerDefinitions[0].mountPoints =
      taskDefTemplate.containerDefinitions[0].mountPoints || [];
  }

  // Override volumes with our constructed volumes (output, dependencies, shared)
  taskDefTemplate.volumes = volumes;

  // Override mount points for the first container
  if (taskDefTemplate.containerDefinitions[0]) {
    taskDefTemplate.containerDefinitions[0].mountPoints = mountPoints;
  }

  // Override required fields
  const taskDefinition = {
    ...taskDefTemplate,
    family: family,
    networkMode: (taskDefTemplate.networkMode || "awsvpc") as NetworkMode,
    requiresCompatibilities: (taskDefTemplate.requiresCompatibilities || [
      "FARGATE",
    ]) as Compatibility[],
    executionRoleArn: ECS_TASK_EXECUTION_ROLE_ARN,
    taskRoleArn: ECS_TASK_ROLE_ARN,
    // Ensure log configuration is set
    containerDefinitions: taskDefTemplate.containerDefinitions.map(
      (container: any, index: number) => ({
        ...container,
        logConfiguration: container.logConfiguration || {
          logDriver: "awslogs" as LogDriver,
          options: {
            "awslogs-group": "/hyperp",
            "awslogs-region": process.env.AWS_REGION!,
            "awslogs-stream-prefix": `${commitHash}/${workflowNameHash}/${jobNameHash}/${runId}`,
          },
        },
      })
    ),
  };

  // Get repositoryId from workflowRun
  const repositoryId = workflowRun.githubRepositoryId;

  // Register task definition
  try {
    await ecsClient.send(new RegisterTaskDefinitionCommand(taskDefinition));
    console.log(`Registered task definition: ${family}`);
  } catch (error: any) {
    const errorMessage = error?.message || String(error);
    const failureReason = `Failed to register task definition for job ${jobRun.jobName}: ${errorMessage}`;
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

  // Run tasks
  const concurrency = jobRun.taskCount;

  // Get container name from task definition (first container)
  const containerName =
    taskDefinition.containerDefinitions[0]?.name ||
    generateHash(jobRun.jobName);

  // Get existing environment variables from task definition
  const existingEnvVars =
    taskDefinition.containerDefinitions[0]?.environment || [];

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
        cluster: ECS_CLUSTER_NAME,
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
        `Running task ${i + 1}/${concurrency} with config:`,
        JSON.stringify(runTaskInput, null, 2)
      );

      const runTaskResponse = await ecsClient.send(
        new RunTaskCommand(runTaskInput)
      );

      console.log(`Started task:`, runTaskResponse.tasks?.[0]?.taskArn);
      const taskArn = runTaskResponse.tasks?.at(0)?.taskArn;

      if (!taskArn) {
        throw new Error(
          `No task ARN returned from RunTaskCommand for job ${jobRun.jobName}`
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
    } catch (error: any) {
      const errorMessage = error?.message || String(error);
      const failureReason = `Failed to run task ${
        i + 1
      }/${concurrency} for job ${jobRun.jobName}: ${errorMessage}`;
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

  // Update job run status
  await dynamoClient.send(
    new UpdateItemCommand({
      TableName: TABLE_NAME,
      Key: marshall({
        PK: jobRun.PK,
        SK: jobRun.SK,
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

  console.log(`Started ${concurrency} tasks for job: ${jobRun.jobName}`);
}

// ============================================
// Increment Dependency Count for Dependent Jobs
// ============================================
async function incrementDependencyCount(
  dependentJobId: string,
  commitHash: string,
  workflowNameHash: string,
  runId: string
): Promise<void> {
  console.log(`Incrementing dependency count for job: ${dependentJobId}`);

  const jobRunKey = `jobRun#${workflowNameHash}#${dependentJobId}#${commitHash}`;
  const jobRunKeySK = `jobRun#${workflowNameHash}#${dependentJobId}#${commitHash}#${runId}`;

  // Increment completed dependency count using atomic ADD operation and get updated values
  const updateResponse = await dynamoClient.send(
    new UpdateItemCommand({
      TableName: TABLE_NAME,
      Key: marshall({
        PK: jobRunKey,
        SK: jobRunKeySK,
      }),
      UpdateExpression:
        "ADD completedDependencyCount :inc SET updatedAt = :updatedAt",
      ExpressionAttributeValues: marshall({
        ":inc": 1,
        ":updatedAt": new Date().toISOString(),
      }),
      ReturnValues: "ALL_NEW",
    })
  );

  if (!updateResponse.Attributes) {
    console.error("Job run not found");
    return;
  }

  const jobRun = unmarshall(updateResponse.Attributes);

  // Check if all dependencies are complete
  if (
    jobRun.completedDependencyCount === jobRun.dependencyCount &&
    jobRun.status === "PENDING"
  ) {
    console.log("All dependencies complete, starting job:", jobRun.jobName);

    // Get workflow run using PK and SK
    const repositoryId = jobRun.githubRepositoryId;
    const runId = jobRun.runId;
    const workflowRunPK = `workflowRun#${repositoryId}#${workflowNameHash}#${commitHash}`;
    const workflowRunSK = `${workflowRunPK}#${runId}`;

    const workflowRunResponse = await dynamoClient.send(
      new GetItemCommand({
        TableName: TABLE_NAME,
        Key: marshall({
          PK: workflowRunPK,
          SK: workflowRunSK,
        }),
      })
    );

    if (workflowRunResponse.Item) {
      const workflowRun = unmarshall(workflowRunResponse.Item);
      await startJobRun(jobRun, workflowRun);
    } else {
      console.error("Workflow run not found");
    }
  }
}

// ============================================
// Increment Workflow Job Count
// ============================================
async function incrementWorkflowJobCount(
  commitHash: string,
  workflowNameHash: string,
  repositoryId: string,
  runId: string
): Promise<void> {
  console.log("Incrementing workflow job count");

  const workflowRunPK = `workflowRun#${repositoryId}#${workflowNameHash}#${commitHash}`;
  const workflowRunSK = `${workflowRunPK}#${runId}`;

  // Increment completed job count using atomic ADD operation and get all updated values
  const updateResponse = await dynamoClient.send(
    new UpdateItemCommand({
      TableName: TABLE_NAME,
      Key: marshall({
        PK: workflowRunPK,
        SK: workflowRunSK,
      }),
      UpdateExpression: "ADD completedJobCount :inc SET updatedAt = :updatedAt",
      ExpressionAttributeValues: marshall({
        ":inc": 1,
        ":updatedAt": new Date().toISOString(),
      }),
      ReturnValues: "ALL_NEW",
    })
  );

  if (!updateResponse.Attributes) {
    console.error("Workflow run not found");
    return;
  }

  const workflowRun = unmarshall(updateResponse.Attributes);

  // Check if workflow is complete
  if (workflowRun.completedJobCount === workflowRun.jobCount) {
    console.log("Workflow run completed successfully!");

    // Update workflow status to SUCCEEDED
    await dynamoClient.send(
      new UpdateItemCommand({
        TableName: TABLE_NAME,
        Key: marshall({
          PK: workflowRunPK,
          SK: workflowRunSK,
        }),
        UpdateExpression: "SET #status = :status, updatedAt = :updatedAt",
        ExpressionAttributeNames: {
          "#status": "status",
        },
        ExpressionAttributeValues: marshall({
          ":status": "SUCCEEDED",
          ":updatedAt": new Date().toISOString(),
        }),
      })
    );

    // Trigger usage calculator task
    await triggerUsageCalculatorTask(
      commitHash,
      workflowNameHash,
      repositoryId,
      runId
    );
  }
}

// ============================================
// Trigger Downloadable Creator Task
// ============================================
async function triggerDownloadableCreatorTask(
  jobRun: any,
  commitHash: string,
  workflowNameHash: string
): Promise<void> {
  console.log(
    `Triggering downloadable creator task for job: ${jobRun.jobName}`
  );

  const jobNameHash = generateHash(jobRun.jobName);
  const family = `downloadableCreator-${commitHash}-${jobRun.runId}-${workflowNameHash}-${jobNameHash}`;

  // S3 output location: s3://bucket-name/hyperp-artifacts/${commitHash}/${workflowNameHash}/${jobNameHash}/artifacts.zip
  const s3OutputLocation = `s3://${S3_BUCKET_NAME}/hyperp-artifacts/${commitHash}/${jobRun.runId}/${workflowNameHash}/${jobNameHash}/artifacts.zip`;

  // Create task definition (template will be loaded from environment or use inline)
  // Note: In Lambda, we'll use inline definition since file system access is limited
  const taskDefTemplate = {
    family: family,
    networkMode: "awsvpc" as NetworkMode,
    requiresCompatibilities: ["FARGATE"] as Compatibility[],
    cpu: "1024",
    memory: "2048",
    executionRoleArn: ECS_TASK_EXECUTION_ROLE_ARN,
    taskRoleArn: ECS_TASK_ROLE_ARN,
    containerDefinitions: [
      {
        name: "DownloadableArtifactsCreator",
        image: process.env.DOWNLOADABLE_CREATOR_IMAGE,
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
          logDriver: "awslogs" as LogDriver,
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
          fileSystemId: EFS_FILE_SYSTEM_ID,
          rootDirectory: jobRun.efsOutputLocation,
          transitEncryption: "ENABLED" as EFSTransitEncryption,
        },
      },
    ],
  };

  // Set values in task definition
  taskDefTemplate.family = family;
  taskDefTemplate.executionRoleArn = ECS_TASK_EXECUTION_ROLE_ARN;
  taskDefTemplate.taskRoleArn = ECS_TASK_ROLE_ARN;

  const taskDefinition = taskDefTemplate;

  try {
    // Register task definition
    const registerResponse = await ecsClient.send(
      new RegisterTaskDefinitionCommand(taskDefinition)
    );
    console.log(`Registered task definition: ${family}`);

    // Run task
    const runTaskInput = {
      cluster: ECS_CLUSTER_NAME,
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

    const runTaskResponse = await ecsClient.send(
      new RunTaskCommand(runTaskInput)
    );

    console.log(
      `Started downloadable creator task for ${family}`,
      runTaskResponse.tasks?.[0]?.taskArn
    );
  } catch (error) {
    console.error(`Error triggering downloadable creator task:`, error);
  }
}

// ============================================
// Trigger Usage Calculator Task
// ============================================
async function triggerUsageCalculatorTask(
  commitHash: string,
  workflowNameHash: string,
  repositoryId: string,
  runId: string
): Promise<void> {
  console.log(
    `Triggering usage calculator task for workflow: ${workflowNameHash}#${commitHash}#${runId}`
  );

  const family = `usageCalculator-${commitHash}-${workflowNameHash}-${runId}`;
  const workflowRunPK = `workflowRun#${repositoryId}#${workflowNameHash}#${commitHash}`;
  const workflowRunSK = `${workflowRunPK}#${runId}`;
  const workflowRunId = workflowRunSK;

  // Get all job runs to determine EFS volumes to mount
  const jobRunsResponse = await dynamoClient.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: "GSI1",
      KeyConditionExpression: "#gsi1pk = :gsi1pk",
      ExpressionAttributeNames: {
        "#gsi1pk": "GSI1-PK",
      },
      ExpressionAttributeValues: marshall({
        ":gsi1pk": `workflowRun#${workflowNameHash}#${commitHash}#${runId}`,
      }),
    })
  );

  const jobRuns = (jobRunsResponse.Items || [])
    .map((item) => unmarshall(item))
    .filter((item: any) => item.entityType === "jobRun");

  // Build volumes and mount points for each job run's output location
  const volumes: any[] = [];
  const mountPoints: any[] = [];

  for (const jobRun of jobRuns) {
    const efsOutputLocation = jobRun.efsOutputLocation;
    if (efsOutputLocation) {
      // Parse entityId to get jobNameHash
      const entityIdParts = jobRun.entityId.split("#");
      const jobNameHash = generateHash(jobRun.jobName);
      const volumeName = `volume-${jobNameHash}`;

      volumes.push({
        name: volumeName,
        efsVolumeConfiguration: {
          fileSystemId: EFS_FILE_SYSTEM_ID,
          rootDirectory: efsOutputLocation,
          transitEncryption: "ENABLED" as EFSTransitEncryption,
        },
      });

      mountPoints.push({
        sourceVolume: volumeName,
        containerPath: `/input/${jobNameHash}`,
        readOnly: true,
      });
    }
  }

  const taskDefinition: any = {
    family: family,
    networkMode: "awsvpc" as NetworkMode,
    requiresCompatibilities: ["FARGATE"] as Compatibility[],
    cpu: "256",
    memory: "512",
    executionRoleArn: ECS_TASK_EXECUTION_ROLE_ARN,
    taskRoleArn: ECS_TASK_ROLE_ARN,
    containerDefinitions: [
      {
        name: "UsageCalculator",
        image: process.env.USAGE_CALCULATOR_IMAGE!,
        essential: true,
        environment: [
          {
            name: "WORKFLOW_RUN_ID",
            value: workflowRunId,
          },
          {
            name: "DYNAMODB_TABLE_NAME",
            value: TABLE_NAME,
          },
          {
            name: "AWS_REGION",
            value: process.env.AWS_REGION!,
          },
        ],
        mountPoints: mountPoints,
        logConfiguration: {
          logDriver: "awslogs" as LogDriver,
          options: {
            "awslogs-group": "/hyperp",
            "awslogs-region": process.env.AWS_REGION!,
            "awslogs-stream-prefix": `${commitHash}/${workflowNameHash}/usage-calculator`,
          },
        },
      },
    ],
    volumes: volumes,
  };

  try {
    await ecsClient.send(new RegisterTaskDefinitionCommand(taskDefinition));
    console.log(`Registered task definition: ${family}`);

    const runTaskInput = {
      cluster: ECS_CLUSTER_NAME,
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

    const runTaskResponse = await ecsClient.send(
      new RunTaskCommand(runTaskInput)
    );

    console.log(
      `Started usage calculator task: ${runTaskResponse.tasks?.[0]?.taskArn}`
    );
  } catch (error: any) {
    console.error("Error triggering usage calculator task:", error);
    throw new Error(
      `Failed to trigger usage calculator task: ${error.message}`
    );
  }
}

// ============================================
// Handle Downloadable Creator Task Completion
// ============================================
async function handleDownloadableCreatorTaskComplete(
  creatorInfo: any,
  containers: any[],
  taskArn: string
): Promise<void> {
  console.log("Handling downloadable creator task completion:", creatorInfo);

  const { commitHash, workflowNameHash, jobNameHash, runId } = creatorInfo;

  // Check if task succeeded
  const allSucceeded = containers.every((c) => c.exitCode === 0);
  const exitCode = containers[0]?.exitCode;

  console.log(
    `Downloadable creator task status: ${
      allSucceeded ? "SUCCEEDED" : "FAILED"
    }, exitCode: ${exitCode}`
  );

  // Update job run with downloadableArtifactsReady status
  const jobRunPK = `jobRun#${workflowNameHash}#${jobNameHash}#${commitHash}`;
  const jobRunSK = `${jobRunPK}#${runId}`;

  const updateResponse = await dynamoClient.send(
    new UpdateItemCommand({
      TableName: TABLE_NAME,
      Key: marshall({
        PK: jobRunPK,
        SK: jobRunSK,
      }),
      UpdateExpression:
        "SET downloadableArtifactsReady = :ready, updatedAt = :updatedAt",
      ExpressionAttributeValues: marshall({
        ":ready": allSucceeded,
        ":updatedAt": new Date().toISOString(),
      }),
      ReturnValues: "ALL_NEW",
    })
  );

  if (!updateResponse.Attributes) {
    console.error("Job run not found");
    return;
  }

  const jobRun = unmarshall(updateResponse.Attributes);

  if (allSucceeded) {
    console.log(
      `Downloadable artifacts ready for job ${jobRun.jobName} at s3://${S3_BUCKET_NAME}/hyperp-artifacts/${commitHash}/${jobRun.runId}/${workflowNameHash}/${jobNameHash}/artifacts.zip`
    );
  } else {
    console.error(
      `Downloadable creator task failed for job ${jobRun.jobName}, exitCode: ${exitCode}`
    );
  }
}

// ============================================
// Fail Workflow Run
// ============================================
async function failWorkflowRun(
  commitHash: string,
  workflowNameHash: string,
  repositoryId: string,
  runId: string
): Promise<void> {
  console.log("Marking workflow run as FAILED");

  const workflowRunPK = `workflowRun#${repositoryId}#${workflowNameHash}#${commitHash}`;
  const workflowRunSK = `${workflowRunPK}#${runId}`;

  // Update workflow status to FAILED
  await dynamoClient.send(
    new UpdateItemCommand({
      TableName: TABLE_NAME,
      Key: marshall({
        PK: workflowRunPK,
        SK: workflowRunSK,
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

  // Check if workflow is already complete (all jobs done) before triggering usage calculator
  const workflowRunResponse = await dynamoClient.send(
    new GetItemCommand({
      TableName: TABLE_NAME,
      Key: marshall({
        PK: workflowRunPK,
        SK: workflowRunSK,
      }),
    })
  );

  if (workflowRunResponse.Item) {
    const workflowRun = unmarshall(workflowRunResponse.Item);
    // Only trigger usage calculator if workflow is complete (all jobs done)
    if (workflowRun.completedJobCount === workflowRun.jobCount) {
      await triggerUsageCalculatorTask(
        commitHash,
        workflowNameHash,
        repositoryId,
        runId
      );
    }
  }

  console.log("Workflow run marked as FAILED");
}

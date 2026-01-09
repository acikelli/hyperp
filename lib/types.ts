// ============================================
// Type Definitions for Hyperp Platform
// ============================================

export interface WorkflowYaml {
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

export interface JobDefinition {
  name: string;
  description?: string;
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

export interface WorkflowEntity {
  PK: string; // workflow#{github repository id}#{workflow name hash}
  SK: string; // workflow#{github repository id}#{workflow name hash}
  "GSI1-PK": string; // workflows
  "GSI1-SK": string; // workflow#{github repository id}#{workflow name hash}
  entityType: "workflow";
  entityId: string; // workflow name hash
  workflowName: string;
  workflowDescription?: string;
  jobCount: number;
  gitHubURL: string;
  githubRepositoryId: string;
  branches: string[];
  dockerfilePaths: Record<string, string[]>; // job name -> dockerfile paths
  taskDefinitionPaths: Record<string, string>; // job name -> task definition path
  runTaskPaths: Record<string, string>; // job name -> run task path
  sharedVolumes?: Array<{ name: string }>; // Shared volumes for all jobs
  createdAt: string;
  updatedAt: string;
}

export interface JobEntity {
  PK: string; // job#{repositoryId}#{workflowNameHash}#{job name hash}
  SK: string; // job#{repositoryId}#{workflowNameHash}#{job name hash}
  "GSI1-PK": string; // workflow#{workflowId}
  "GSI1-SK": string; // job#{repositoryId}#{workflowNameHash}#{job name hash}
  entityType: "job";
  entityId: string; // job name hash
  jobName: string;
  jobDescription?: string;
  concurrency: number;
  dependsOn?: string[];
  lastImageUri?: string; // Last successfully built image URI
  lastImageBuildCommitHash?: string; // Commit hash when image was last built
  githubRepositoryId: string;
  workflowNameHash: string;
  imageBuildResources?: {
    cpu: string;
    memory: string;
  };
  downloadable?: boolean; // Whether artifacts should be downloadable
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowRunEntity {
  PK: string; // workflowRun#{github repository id}#{workflow name hash}#{commitHash}
  SK: string; // workflowRun#{github repository id}#{workflow name hash}#{commitHash}#{runId}
  "GSI1-PK": string; // workflowRuns#{github repository id}#{workflow name hash}
  "GSI1-SK": string; // workflowRun#{commitHash}
  "GSI2-PK": string; // commitRuns#{commitHash}
  "GSI2-SK": string; // workflowRun#{github repository id}#{workflow name hash}
  "GSI3-PK": string; // workflowRuns
  "GSI3-SK": string; // {createdAt timestamp}
  entityType: "workflowRun";
  entityId: string; // {github repository id}#{workflow name hash}#{commitHash}
  runId: string; // Unique run identifier
  workflowName: string;
  jobCount: number;
  completedJobCount: number;
  status: "WAITING_FOR_IMAGE_BUILDS" | "RUNNING" | "SUCCEEDED" | "FAILED";
  imageBuildJobs: Record<string, ImageBuildJobStatus>; // job name hash -> status
  imageBuildJobCount: number;
  completedImageBuildJobCount: number;
  jobImageUris: Record<string, string>; // job name hash -> image URI to use (cached or new)
  githubRepositoryId: string;
  commitHash: string;
  branch: string;
  taskDefinitionPaths?: Record<string, string>; // Job name -> task definition path
  sharedVolumes?: Array<{ name: string }>; // Shared volumes defined in workflow
  estimatedCost?: number; // Total estimated Fargate cost in USD (sum of all job runs)
  storageUsage?: number; // Total storage usage in KB (sum of all job runs)
  failureReason?: string; // Reason for failure if status is FAILED
  createdAt: string;
  updatedAt: string;
}

export interface ImageBuildJobStatus {
  jobNameHash: string;
  jobName?: string;
  containerIndex: number;
  containerName?: string;
  status: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED";
  taskArn?: string;
  exitCode?: number;
  reason?: string;
  startedAt?: string;
  stoppedAt?: string;
  dockerfilePath?: string;
  estimatedCost?: number; // Estimated Fargate cost in USD
}

export interface JobRunEntity {
  PK: string; // jobRun#{workflowNameHash}#{job name hash}#{commitHash}
  SK: string; // jobRun#{workflowNameHash}#{job name hash}#{commitHash}#{runId}
  "GSI1-PK": string; // workflowRun#{workflow name hash}#{commitHash}#{runId}
  "GSI1-SK": string; // jobRun#{workflowNameHash}#{job name hash}#{commitHash}#{runId}
  entityType: "jobRun";
  entityId: string; // {workflow name hash}#{job name hash}#{commit hash}
  runId: string; // Unique run identifier
  jobName: string;
  workflowNameHash: string;
  taskCount: number;
  completedTaskCount: number;
  dependsOn?: string[]; // Job names this job depends on
  dependsOnJobIds?: string[]; // Job entity IDs (job name hashes) this job depends on
  dependentJobIds: string[]; // Jobs that depend on this job
  dependencyCount: number;
  completedDependencyCount: number;
  status: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED";
  taskArn?: string; // First task ARN (for logs)
  efsOutputLocation: string; // EFS output path for this job
  githubRepositoryId: string;
  commitHash: string;
  owner?: string; // GitHub repository owner
  repo?: string; // GitHub repository name
  installationId?: string; // GitHub App installation ID for creating access tokens
  downloadable?: boolean; // Whether artifacts should be downloadable
  downloadableArtifactsReady?: boolean; // Whether downloadable artifacts are ready in S3
  createdAt: string;
  updatedAt: string;
  startedAt?: string; // Set from pullStartedAt when first task starts
  stoppedAt?: string; // Set from stoppedAt when last task stops
  estimatedCost?: number; // Estimated Fargate cost in USD (cumulative sum from all tasks)
  storageUsage?: number; // Storage usage in KB
}

export interface TaskEntity {
  PK: string; // task#{taskArn}
  SK: string; // task#{taskArn}
  "GSI1-PK": string; // jobRun#{workflowNameHash}#{jobNameHash}#{commitHash}
  "GSI1-SK": string; // task#{taskArn}
  entityType: "task";
  entityId: string; // {taskArn}
  taskArn: string;
  jobRunEntityId: string; // {workflowNameHash}#{jobNameHash}#{commitHash}
  lastStatus: string;
  stoppedReason?: string;
  pullStartedAt?: string;
  stoppedAt?: string;
  estimatedCost?: number; // Estimated Fargate cost for this task
  createdAt: string;
  updatedAt: string;
}

export interface TaskDefinitionTemplate {
  family?: string;
  networkMode?: string;
  requiresCompatibilities?: string[];
  cpu?: string;
  memory?: string;
  executionRoleArn?: string;
  taskRoleArn?: string;
  containerDefinitions: ContainerDefinition[];
  volumes?: VolumeDefinition[];
}

export interface ContainerDefinition {
  name?: string;
  image?: string;
  dockerfilePath?: string;
  cpu?: number;
  memory?: number;
  essential?: boolean;
  command?: string[];
  environment?: Array<{ name: string; value: string }>;
  mountPoints?: MountPoint[];
  logConfiguration?: LogConfiguration;
}

export interface MountPoint {
  sourceVolume: string;
  containerPath: string;
  readOnly: boolean;
}

export interface LogConfiguration {
  logDriver: string;
  options: Record<string, string>;
}

export interface VolumeDefinition {
  name: string;
  efsVolumeConfiguration?: {
    fileSystemId: string;
    rootDirectory: string;
    transitEncryption?: string;
    transitEncryptionPort?: number;
    authorizationConfig?: {
      accessPointId: string;
      iam: string;
    };
  };
}

export interface RunTaskInput {
  cluster?: string;
  taskDefinition?: string;
  launchType?: string;
  networkConfiguration?: {
    awsvpcConfiguration: {
      subnets: string[];
      securityGroups?: string[];
      assignPublicIp?: string;
    };
  };
  overrides?: {
    containerOverrides?: Array<{
      name: string;
      command?: string[];
      environment?: Array<{ name: string; value: string }>;
    }>;
  };
}

export interface GitHubCommitEvent {
  ref: string;
  before: string;
  after: string;
  repository: {
    id: number;
    name: string;
    full_name: string;
    owner: {
      name: string;
      login: string;
    };
    html_url: string;
  };
  installation: {
    id: number;
  };
  commits: Array<{
    id: string;
    message: string;
    added: string[];
    removed: string[];
    modified: string[];
  }>;
  head_commit: {
    id: string;
    message: string;
  };
}

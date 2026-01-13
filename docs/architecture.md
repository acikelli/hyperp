# Hyperp Architecture

hyperp is a fully automated serverless compute platform built on AWS. It embraces a complete GitOps workflow, automatically managing CI/CD pipelines while providing integrated artifact storage for data transfer between jobs and local download. The platform includes built-in cost estimation for both compute and storage resources per run, and offers a straightforward CLI for easy interaction. [Setup instructions](./setup.md)

![Alt text](./images/hyperp-overview.png)

---

## Table of Contents

1. [Overview](#1-overview)
2. [Workflow Configuration](#2-workflow-configuration)
3. [CI/CD & Image Building](#3-cicd--image-building)
4. [Job Orchestration & State Management](#4-job-orchestration--state-management)
5. [Artifact Mechanism](#5-artifact-mechanism)
6. [Downloadable Artifacts](#6-downloadable-artifacts)
7. [Cost Estimation](#7-cost-estimation)

---

## 1. Overview

This demonstration workflow computes `f(x) = (x * y) + (x / z)` through a series of orchestrated operations. The calculation pipeline consists of four sequentially executed jobs:

- Generate x
- Generate y and multiply x with y (x\*y)
- Generate z and divide x by z (x/z)
- Sum (x\*y) + (x/z)

Each operation executes within an isolated container environment.

## 2. Workflow Configuration

Hyperp automatically reads and parses all YAML/YML files located under the `hyperp-workflows/` directory path. Let's examine the YAML interface.

```yaml
branches:
  - wf-test
  - main
workflowName: Calculator
workflowDescription: Calculator
artifacts:
  shared:
    - name: shared-folder
jobs:
  - jobName: Generate x
    jobDescription: Generates random value for x and writes the result to /output/result.txt
    taskDefinitionPath: pipeline-examples/calculator/x/taskDefinition.json
  - jobName: x * y
    jobDescription: Creates a random value for y, multiplies x with y and writes the result to /output/result.txt
    taskDefinitionPath: pipeline-examples/calculator/y/taskDefinition.json
    dependsOn:
      - Generate x
  - jobName: x / z
    jobDescription: Creates a random value for z, divides x by z and writes the result to /output/result.txt
    taskDefinitionPath: pipeline-examples/calculator/z/taskDefinition.json
    dependsOn:
      - Generate x
    imageBuildResources:
      cpu: "1024"
      memory: "2048"
    downloadable: true
    concurrency: 2
  - jobName: (x * y) + (x / z)
    jobDescription: Reads previous results from /input/x * y/result.txt and /input/x / z/result.txt, sums both results and writes to /output/result.txt
    taskDefinitionPath: pipeline-examples/calculator/sum/taskDefinition.json
    dependsOn:
      - x * y
      - x / z
```

The platform uses a simple yaml interface where you can define name/description metadata for the workflow and the jobs, give ECS task definition path stored in the repository, define dependencies between jobs etc. We'll explore each parameter.

### Workflow Configuration Parameters

| Parameter                    | Description                                |
| ---------------------------- | ------------------------------------------ |
| `branches`                   | List of branches that trigger the workflow |
| `workflowName`               | Name of the workflow                       |
| `workflowDescription`        | Description of the workflow                |
| `artifacts.shared`           | Shared volumes accessible by all jobs      |
| `jobs[].jobName`             | Name of the job                            |
| `jobs[].taskDefinitionPath`  | Path to ECS task definition in repository  |
| `jobs[].dependsOn`           | List of job names this job depends on      |
| `jobs[].imageBuildResources` | CPU/memory for image build task            |
| `jobs[].downloadable`        | Enable artifact download via CLI           |
| `jobs[].concurrency`         | Number of parallel tasks for the job       |

### Job Dependency Graph

```
                    ┌───────────────┐
                    │  Generate x   │
                    └───────┬───────┘
                            │
              ┌─────────────┴─────────────┐
              │                           │
              ▼                           ▼
      ┌───────────────┐           ┌───────────────┐
      │    x * y      │           │    x / z      │
      │               │           │(concurrency:2)│
      └───────┬───────┘           └───────┬───────┘
              │                           │
              └─────────────┬─────────────┘
                            │
                            ▼
                ┌───────────────────────┐
                │  (x * y) + (x / z)    │
                └───────────────────────┘
```

---

## 3. CI/CD

![Alt text](./images/general-diagram.png)

Lets start by checking the triggerred run using our CLI tool by running `hyperp list-runs` command. We can use arrow keys to use the interactive tool and optionally pass `--commit-hash <commit hash>` parameter if we need to investigate a specific run.

![Alt text](./images/1_tyqoKE4cxXgN1MR6q21w7g.gif)

Since this is the initial push for the workflow, the system automatically detected that 4 container images require building. Because image builds must complete before job executions, the workflow run is initialized with a Waiting status, while the jobs are assigned a Pending status.

Lets check ECS tasks for the image build jobs.

![Alt text](./images/1_9DDJxM0YzYrjjlFylVzG3g.png)

Under the hood, the system registers a task definition and constructs its family name as `imageBuild-{repositoryId}-{commitHash}-{workflowNameHash}-{jobNameHash}-{containerIndex}-{runId}` for each image to be built. Let's also check the task definition details for an image build job. If `imageBuildResources` is not defined in the yaml for a job, the system [assigns](https://github.com/acikelli/hyperp/blob/main/lambda/github-webhook-handler/index.ts#L1309) 1024 cpu and 4096 memory to every image build job by default.

![Alt text](./images/1_bexdobt2aUVfCW-Chkclgg.png)

The system uses [kaniko](https://github.com/acikelli/hyperp/tree/main/utilities/kaniko-executor-ecr) to build container images in Fargate environment, automatically generates an access token and constructs the context parameter as `git://oauth2:{accessToken}@github.com/{owner}/{repo}.git#{commitHash}`.

The `--context-sub-path` and `--dockerfile` parameters are extracted from the provided task definition. Lets examine the task definition structure:

```json
{
  "containerDefinitions": [
    {
      "dockerfilePath": "pipeline-examples/calculator/z/Dockerfile"
    }
  ],
  "cpu": "256",
  "memory": "512",
  "requiresCompatibilities": ["FARGATE"]
}
```

Within the container definitions, we've specified a `dockerfilePath` parameter (absolute repository path), which is not a standard parameter in the native ECS task definition template - the standard template only accepts pre-built images via the `image` parameter. The system automatically detects the `dockerfilePath` parameter and populates the `--context-sub-path` and `--dockerfile` arguments, enabling each job to build its images accordingly.

For the push destination, the system constructs the image tag as `{commitHash}-{workflowNameHash}-{jobNameHash}-{containerIndex}` and pushes to the ECR repository named `hyperp-1`, where all images are stored. The system automatically replaces the `image` field in the actual task definitions of the jobs defined in the yaml to let them pull the built images once they are ready to run.

### Change Detection Mechanism

Since this was the workflow's initial execution, image build jobs were triggered for each of the four jobs defined in the YAML. The system also automatically detects code changes in subsequent commits and builds only the required images.

```
pipeline-examples/
│
├─── calculator/
      └─── z/
            ├─── main.py           ◄── Changes trigger rebuild
            └─── requirements.txt  ◄── Changes trigger rebuild
            └─── Dockerfile        ◄── Changes trigger rebuild
            └─── .dockerignore     ◄── Patterns exclude files
            └─── taskDefinition.json  ◄── Runtime fetch (no rebuild)
            └─── readme.md         ◄── Ignored (*.md in .dockerignore)
```

The system triggers an image build job based on changes to files referenced by the provided Dockerfile path. For example the job X / Z has [given](https://github.com/acikelli/hyperp/blob/main/pipeline-examples/calculator/z/taskDefinition.json#L5) `pipeline-examples/calculator/z/Dockerfile`. The system detects all the file changes made on the path where Dockerfile resides, in this case `pipeline-examples/calculator/z`, and triggers an image build task for the job. In this example job, modifications to `main.py`, `requirements.txt` and `Dockerfile` will trigger a new image build. The `.dockerignore` file [includes](https://github.com/acikelli/hyperp/blob/main/pipeline-examples/calculator/z/.dockerignore#L1) `*.md`, the system automatically detects patterns in ignore files, meaning changes to files matching this pattern are ignored and do not trigger image rebuilds. Changes to `taskDefinition.json` do not require an image rebuild (unless the `dockerfilePath` parameter changes) because the system fetches JSON files at runtime using the GitHub API with commit hash reference, ensuring the repository remains the single source of truth for task definitions. The system does not persist any Dockerfiles or task definitions, adhering to the GitOps pattern.

![Alt text](./images/1_gRPNo6ejx8MLkwf4osYgGQ.gif)

We can monitor build status using the interactive CLI tool. Once all images are built and pushed, the workflow status transitions to Running and the first job (X) begins execution.

---

## 4. Job Orchestration & State Management

### State Tracking via EventBridge

The system tracks ECS tasks' state via the ECS Task State Change [rule](https://github.com/acikelli/hyperp/blob/main/lib/hyperp-stack.ts#L570-L587) on EventBridge This rule triggers a Lambda function named `hyperp-task-state-change-handler`, which decodes each task's family field to update the `workflowRun` and `jobRun` entities in DynamoDB.

![Alt text](./images/1_dFBwf1D6XtIZy07xkZK_7g.png)

Task definitions for the actual jobs defined in the yaml are constructed with encoded parameters as `jobRun-{commitHash}-{workflowNameHash}-{jobNameHash}-{runId}`.

### State Management Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         State Management Flow                                │
└─────────────────────────────────────────────────────────────────────────────┘

  ┌──────────────┐         ┌──────────────┐         ┌──────────────┐
  │  ECS Task    │         │  EventBridge │         │   Lambda     │
  │  Completes   │────────▶│    Rule      │────────▶│  (handler)   │
  └──────────────┘         └──────────────┘         └──────┬───────┘
                                                          │
                                                          ▼
                                              ┌───────────────────────┐
                                              │  Decode task family:  │
                                              │  imageBuild-* or      │
                                              │  jobRun-*             │
                                              └───────────┬───────────┘
                                                          │
                           ┌──────────────────────────────┴──────────────────┐
                           │                                                  │
                           ▼                                                  ▼
              ┌────────────────────────┐                      ┌────────────────────────┐
              │    Image Build Task    │                      │      Job Run Task      │
              │                        │                      │                        │
              │ • Increment completed  │                      │ • Increment completed  │
              │   imageBuildJobCount   │                      │   taskCount            │
              │ • Delete old ECR image │                      │ • Update job status    │
              │ • If all done:         │                      │ • If all tasks done:   │
              │   - Set status=Running │                      │   - Increment deps     │
              │   - Start first jobs   │                      │   - Start next jobs    │
              └────────────────────────┘                      └────────────────────────┘
                           │                                                  │
                           └──────────────────────────────────────────────────┘
                                                          │
                                                          ▼
                                              ┌───────────────────────┐
                                              │      DynamoDB         │
                                              │  (workflowRun/jobRun) │
                                              └───────────────────────┘
```

### WorkflowRun Entity

Let's examine the [workflowRun](https://github.com/acikelli/hyperp/blob/main/lambda/github-webhook-handler/index.ts#L1054) entity structure. It maintains `imageBuildJobCount` (calculated based on code changes) and `completedImageBuildJobCount` (initialized at 0) attributes. Within the task-state-change-handler Lambda, when a task family [begins with](https://github.com/acikelli/hyperp/blob/main/lambda/task-state-change-handler/index.ts#L150) `imageBuild` and the task succeeds, the function [increments](https://github.com/acikelli/hyperp/blob/main/lambda/task-state-change-handler/index.ts#L362) the completed count by 1, [deletes](https://github.com/acikelli/hyperp/blob/main/lambda/task-state-change-handler/index.ts#L443) the previous image built for that job from ECR, and if the completed count [reaches](https://github.com/acikelli/hyperp/blob/main/lambda/task-state-change-handler/index.ts#L462) the total count, transitions the workflow run status to Running and initiates workflow job execution.

### JobRun Entity

For [jobRun](https://github.com/acikelli/hyperp/blob/main/lambda/github-webhook-handler/index.ts#L1130) entities, we store `taskCount` (equal to the specified concurrency), `completedTaskCount`, `dependentJobIds` (IDs of jobs depending on the current job), `dependencyCount`, and `completedDependencyCount`. When a task family [begins with](https://github.com/acikelli/hyperp/blob/main/lambda/task-state-change-handler/index.ts#L160) `jobRun` and the task succeeds, the jobRun entity's `completedTaskCount` is [incremented](https://github.com/acikelli/hyperp/blob/main/lambda/task-state-change-handler/index.ts#L622) by one. When `completedTaskCount` [reaches](https://github.com/acikelli/hyperp/blob/main/lambda/task-state-change-handler/index.ts#L666) `taskCount`, all tasks have succeeded and the job status is set to Succeeded. Although our workflow defines 4 jobs, the task list shows 5 entries because job `x / z` has a concurrency of 2, resulting in 2 tasks triggered with the same family identifier and the same task definition. Additionally, `TASK_INDEX` and `TASK_TOTAL_SIZE` environment variables are [passed](https://github.com/acikelli/hyperp/blob/main/lambda/github-webhook-handler/index.ts#L1655) to concurrent jobs, enabling different task instances to process different workloads.

### Dependency Resolution

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       Dependency Resolution Flow                             │
└─────────────────────────────────────────────────────────────────────────────┘

  Job "x * y" completes                    Job "x / z" completes
         │                                         │
         │                                         │
         ▼                                         ▼
  ┌──────────────────┐                    ┌──────────────────┐
  │ Increment        │                    │ Increment        │
  │ completedDep     │                    │ completedDep     │
  │ Count for        │                    │ Count for        │
  │ "(x*y)+(x/z)"    │                    │ "(x*y)+(x/z)"    │
  └────────┬─────────┘                    └────────┬─────────┘
           │                                       │
           │    completedDepCount = 1              │    completedDepCount = 2
           │                                       │
           ▼                                       ▼
  ┌──────────────────┐                    ┌──────────────────┐
  │ depCount = 2     │                    │ depCount = 2     │
  │ 1 < 2            │                    │ 2 == 2           │
  │ → Wait           │                    │ → Start job!     │
  └──────────────────┘                    └──────────────────┘
```

If a job run has `dependentJobIds`, the `completedDependencyCount` attribute for each dependent job is incremented by one when the job succeeds. When this count [reaches](https://github.com/acikelli/hyperp/blob/main/lambda/task-state-change-handler/index.ts#L1278) `dependencyCount`, that means all of the dependent job's dependencies have completed and the job can begin execution. For example, the job `(x * y) + (x / z)` has 2 dependencies-it can only start when both `x * y` and `x / z` succeed. Each of the jobs increment the `(x * y) + (x / z)`'s `completedDependencyCount` attribute when they succeed. Additionally, for every successful job, the workflowRun entity's `completedJobCount` attribute is incremented. When `completedJobCount` [reaches](https://github.com/acikelli/hyperp/blob/main/lambda/task-state-change-handler/index.ts#L1348) `jobCount`, meaning all jobs have succeeded and the workflow run status is set to Succeeded.

---

## 5. Artifact Mechanism

### Job Implementation

Now let's examine the job implementation codes.

- [Job X](https://github.com/acikelli/hyperp/blob/main/pipeline-examples/calculator/x/main.py) generates a random number and writes it to `/output/result.txt`.

- Job [X \* Y](https://github.com/acikelli/hyperp/blob/main/pipeline-examples/calculator/y/main.py) reads the generated value for x from `/input/Generate x/result.txt`, generates a value for y, and writes the x \* y result to `/output/result.txt`.

- Job [X / Z](https://github.com/acikelli/hyperp/blob/main/pipeline-examples/calculator/z/main.py) reads the generated value for x from `/input/Generate x/result.txt`, generates a value for z, and writes the x / z result to `/output/result.txt`.

- The final job [(X \* Y) + (X / Z)](https://github.com/acikelli/hyperp/blob/main/pipeline-examples/calculator/sum/main.py) reads all directories under `/input`, sums the values from text files found within, and writes the result to `/output/result.txt`.

### Volume Configuration

Lets check the volume configuration for the job `(X * Y) + (X / Z)`.

![Alt text](./images/1_dH5NRZnfXrc_qQvmnDSPrg.png)

### Artifact Storage Structure

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          EFS Volume Structure                                │
└─────────────────────────────────────────────────────────────────────────────┘

  /hyperp-artifacts/
  │
  └── {commit-hash}/
      │
      └── {run-id}/
          │
          └── {workflow-name-hash}/
              │
              ├── {job-x-hash}/
              │   └── result.txt          ◄── Written by Job X
              │
              ├── {job-xy-hash}/
              │   └── result.txt          ◄── Written by Job X*Y
              │
              ├── {job-xz-hash}/
              │   └── result.txt          ◄── Written by Job X/Z
              │
              └── {job-sum-hash}/
                  └── result.txt          ◄── Written by Job Sum
```

### Volume Mount Points

```
┌─────────────────────────────────────────────────────────────────────────────┐
│              Job Container Volume Mounts                                     │
│              Example: Job "(X * Y) + (X / Z)"                                │
└─────────────────────────────────────────────────────────────────────────────┘

  Container Paths                          EFS Paths
  ───────────────                          ─────────

  /input/x * y/         ◄── READ-ONLY ──── /hyperp-artifacts/{commit}/{run}/{wf}/{job-xy}/
  /input/x / z/         ◄── READ-ONLY ──── /hyperp-artifacts/{commit}/{run}/{wf}/{job-xz}/
  /output/              ◄── READ-WRITE ─── /hyperp-artifacts/{commit}/{run}/{wf}/{job-sum}/
  /shared/shared-folder ◄── READ-WRITE ─── /hyperp-artifacts/{commit}/{run}/{wf}/shared/shared-folder/
```

Since the job `(X * Y) + (X / Z)` depends on `X * Y` and `X / Z`, it accesses the previous jobs' artifacts (written to their `/output/` paths) under the path `/input/{depending job name}`. Each job writes its outputs to a volume on EFS, the location is constructed as `/hyperp-artifacts/{commit hash}/{run id}/{workflow name hash}/{job name hash}`. Additionally, since we defined a shared artifact volume, every job can access this volume under the path `/shared/{shared artifact name}`. Input volume mount points are configured as read-only, while output and shared volumes are configured as read-write.

![Alt text](./images/1_UPC6YOJGdrHkQwr55OOozg.png)

---

## 6. Downloadable Artifacts

Since artifacts are stored on EFS, we cannot directly access them. To address this, we configured job `X / Z` with `downloadable: true`. The system executes a [downloadableCreator](https://github.com/acikelli/hyperp/blob/main/utilities/downloadable-creator/downloadable-artifacts-creator.py) task for downloadable jobs upon successful completion. The downloadable creator task compresses and transfers files from EFS to S3 using the path structure `/hyperp-artifacts/{commit hash}/{run id}/{workflow name hash}/{job name hash}/artifacts.zip`. We can download this archive via the CLI.

### Download Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       Downloadable Artifacts Flow                            │
└─────────────────────────────────────────────────────────────────────────────┘

  ┌──────────────┐         ┌──────────────┐         ┌──────────────┐
  │  Job with    │         │ Downloadable │         │     S3       │
  │ downloadable │────────▶│   Creator    │────────▶│   Bucket     │
  │    = true    │         │    Task      │         │              │
  └──────────────┘         └──────────────┘         └──────┬───────┘
                                                          │
                                  EFS                     │
                           ┌──────────────┐               │
                           │ /hyperp-     │               │
                           │  artifacts/  │───compress───▶│
                           │  {path}/     │               │
                           └──────────────┘               │
                                                          │
                                                          ▼
                                              ┌───────────────────────┐
                                              │  {path}/artifacts.zip │
                                              └───────────┬───────────┘
                                                          │
                                                          │ CLI Request
                                                          ▼
                                              ┌───────────────────────┐
                                              │   Presigned URL       │
                                              │   (Download)          │
                                              └───────────────────────┘
```

![Alt text](./images/1_pSYoC5tWJG2lNSSvxv30LA.gif)

We can select download artifacts for the downloadable jobs using CLI. Under the hood it creates a presigned URL for us to download the private zip file on S3.

![Alt text](./images/1_zM7b9g0eOEE8ZKyKewWm5w.gif)

If we do not define `downloadable: true` for a job in the yaml, we can manually trigger a downloadable creation job using the CLI as well. Once it's artifacts are transferred to S3, we can download the zip file using same way.

---

## 7. Cost Estimation

Once the workflow finished, an [usage calculator](https://github.com/acikelli/hyperp/tree/main/utilities/usage-calculator) task is deployed to calculate the cumulative CPU, Memory and storage usage. We can see price estimations of the usages on the CLI.

---

## Summary

Hyperp provides a complete serverless workflow orchestration platform with:

1. **GitOps-First Design** - All configuration lives in your repository
2. **Automatic CI/CD** - Smart change detection triggers only necessary builds
3. **Flexible Dependencies** - DAG-based job orchestration with concurrent execution
4. **Artifact Sharing** - EFS-based storage with input/output/shared volumes
5. **Downloadable Outputs** - S3-based artifact downloads via presigned URLs
6. **Cost Visibility** - Per-run resource usage and cost estimation

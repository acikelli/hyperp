# Infrastructure Components

This document explains all the AWS infrastructure components that make Hyperp work. Think of Hyperp as a factory that builds and runs your code—each AWS service plays a specific role in making that happen.

---

## Table of Contents

1. [Overview](#overview)
2. [Networking](#networking)
3. [Compute](#compute)
4. [Storage](#storage)
5. [Serverless Functions](#serverless-functions)
6. [Event System](#event-system)
7. [Security](#security)
8. [Logging & Monitoring](#logging--monitoring)
9. [Component Diagram](#component-diagram)

---

## Overview

Hyperp is a serverless compute platform. "Serverless" means you don't manage any servers—AWS handles all the infrastructure scaling automatically. When you push code to GitHub, Hyperp:

1. Receives a webhook notification
2. Builds container images from your code
3. Runs your jobs in isolated containers
4. Stores outputs for sharing between jobs
5. Tracks everything in a database

Each AWS component below makes one of these steps possible.

---

## Networking

### VPC (Virtual Private Cloud)

**What it is:** Your own private network inside AWS. Think of it as a secure office building where all your Hyperp resources live.

**Configuration:**

- CIDR: `10.0.0.0/16` (65,536 available IP addresses)
- 3 Availability Zones for reliability
- Public subnets only (no NAT gateway to save costs)

```
┌─────────────────────────────────────────────────────────────────┐
│                         Hyperp VPC                              │
│                       10.0.0.0/16                               │
│                                                                 │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐ │
│  │  Public Subnet  │  │  Public Subnet  │  │  Public Subnet  │ │
│  │     AZ-1        │  │     AZ-2        │  │     AZ-3        │ │
│  │   /20 CIDR      │  │   /20 CIDR      │  │   /20 CIDR      │ │
│  │                 │  │                 │  │                 │ │
│  │  • ECS Tasks    │  │  • ECS Tasks    │  │  • ECS Tasks    │ │
│  │  • Lambdas      │  │  • Lambdas      │  │  • Lambdas      │ │
│  │  • EFS Mounts   │  │  • EFS Mounts   │  │  • EFS Mounts   │ │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘ │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Why public subnets only?** NAT Gateways cost money ($0.045/hour + data charges). Since our tasks need internet access (to pull from GitHub, push to ECR), using public subnets with public IPs is more cost-effective for this use case.

### Security Group

**What it is:** A virtual firewall that controls what traffic can go in and out of your resources.

**Name:** `EcsTaskSecurityGroup`

**Rules:**
| Direction | Port | Protocol | Source/Destination | Purpose |
|-----------|------|----------|-------------------|---------|
| Inbound | 2049 | TCP | Self | EFS mount (NFS) |
| Outbound | All | All | 0.0.0.0/0 | Internet access |

**Why needed?** ECS tasks need to:

- Mount EFS volumes (port 2049 for NFS)
- Pull images from ECR
- Access GitHub API
- Push logs to CloudWatch

---

## Compute

### ECS Cluster (Elastic Container Service)

**What it is:** A managed container orchestration service. It's where all your jobs run.

**Name:** `hyperp-1`

**Configuration:**

- Fargate launch type (serverless containers)
- Container Insights enabled for monitoring
- No EC2 instances to manage

**Why Fargate?** Pay only for what you use. No need to manage or scale servers. Containers spin up in seconds and shut down automatically.

### How Tasks Run

```
┌─────────────────────────────────────────────────────────────────┐
│                       ECS Cluster                               │
│                                                                 │
│   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐         │
│   │ Image Build  │  │ Image Build  │  │ Image Build  │         │
│   │   Task 1     │  │   Task 2     │  │   Task 3     │  ...    │
│   │  (Kaniko)    │  │  (Kaniko)    │  │  (Kaniko)    │         │
│   └──────────────┘  └──────────────┘  └──────────────┘         │
│                                                                 │
│   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐         │
│   │   Job Run    │  │   Job Run    │  │   Job Run    │  ...    │
│   │   Task 1     │  │   Task 2     │  │   Task 3     │         │
│   │ (Your Code)  │  │ (Your Code)  │ (Your Code)    │         │
│   └──────────────┘  └──────────────┘  └──────────────┘         │
│                                                                 │
│   ┌──────────────┐  ┌──────────────┐                           │
│   │ Downloadable │  │    Usage     │                           │
│   │   Creator    │  │  Calculator  │                           │
│   └──────────────┘  └──────────────┘                           │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Task Types:**
| Task Type | Purpose | Image |
|-----------|---------|-------|
| Image Build | Build Docker images using Kaniko | Kaniko executor |
| Job Run | Execute your workflow jobs | Your custom images |
| Downloadable Creator | Compress artifacts for download | Public utility image |
| Usage Calculator | Calculate costs after workflow | Public utility image |

---

## Storage

Hyperp uses four different storage services, each optimized for a specific purpose.

### DynamoDB (Database)

**What it is:** A fast, serverless NoSQL database for storing all platform state.

**Table Name:** `hyperp`

**What it stores:**

- Workflows (configuration from your YAML files)
- Jobs (individual job definitions)
- Workflow Runs (execution state and metadata)
- Job Runs (individual job execution state)
- Tasks (ECS task tracking)

**Key Design:**

```
Primary Key: PK (Partition Key) + SK (Sort Key)

Example Keys:
┌────────────────────────────────────────────────────────────────┐
│ Entity Type    │ PK                              │ SK          │
├────────────────┼─────────────────────────────────┼─────────────┤
│ Workflow       │ workflow#{repoId}#{nameHash}    │ (same)      │
│ WorkflowRun    │ workflowRun#{repoId}#...        │ ...#{runId} │
│ JobRun         │ jobRun#{wfHash}#{jobHash}#...   │ ...#{runId} │
└────────────────────────────────────────────────────────────────┘
```

**Global Secondary Indexes (GSIs):**
| Index | Purpose |
|-------|---------|
| GSI1 | Query jobs by workflow, job runs by workflow run |
| GSI2 | Query workflow runs by commit hash |
| GSI3 | List all workflow runs sorted by time |

**Why DynamoDB?** Serverless, scales automatically, pay per request, millisecond response times.

### EFS (Elastic File System)

**What it is:** A shared file system that multiple containers can read/write simultaneously.

**Purpose:** Pass artifacts between jobs in a workflow.

**Mount Structure:**

```
/hyperp-artifacts/
└── {commit-hash}/
    └── {run-id}/
        └── {workflow-hash}/
            ├── {job-1-hash}/
            │   └── output files...
            ├── {job-2-hash}/
            │   └── output files...
            └── shared/
                └── {shared-volume-name}/
                    └── shared files...
```

**How Jobs Access Artifacts:**
| Mount Point | Access | Source |
|-------------|--------|--------|
| `/output/` | Read-Write | Current job's output directory |
| `/input/{job-name}/` | Read-Only | Dependency job's output |
| `/shared/{name}/` | Read-Write | Shared volume |

**Configuration:**

- Encrypted at rest
- Elastic throughput (scales with usage)
- Lifecycle policy: Move to Infrequent Access after 14 days

### ECR (Elastic Container Registry)

**What it is:** A private Docker registry for storing your container images.

**Repository Name:** `hyperp-1`

**Image Tag Format:**

```
{commit-hash}-{workflow-hash}-{job-hash}-{container-index}
```

**Why a single repository?** Tags contain all identifying information. Lifecycle rules keep the last image to prevent unbounded growth.

**Lifecycle Rules:**

- Keep the last image
- Older images automatically deleted

### S3 (Simple Storage Service)

**What it is:** Object storage for files that need to be downloaded.

**Bucket Purpose:**

1. **GitHub App Private Key** - Your `githubappkey.pem` file
2. **Downloadable Artifacts** - Compressed job outputs (zip files)

**Structure:**

```
s3://hyperp-artifacts-{random}/
├── githubappkey.pem                    # GitHub App auth
└── hyperp-artifacts/
    └── {commit}/{run}/{wf}/{job}/
        └── artifacts.zip               # Downloadable outputs
```

**Security:**

- Block all public access
- Versioning enabled
- S3-managed encryption

---

## Serverless Functions

Hyperp uses four Lambda functions, each handling a specific responsibility.

### 1. GitHub Webhook Handler

**Name:** `hyperp-github-webhook-handler`

**Trigger:** HTTP POST from GitHub (via Function URL)

**Responsibilities:**

- Validate webhook signature
- Parse push events
- Sync workflow configurations from repository
- Detect code changes that require image rebuilds
- Create workflow runs, job runs in DynamoDB
- Trigger image build tasks
- Start jobs when no builds needed

**Memory:** 1024 MB | **Timeout:** 5 minutes

### 2. Task State Change Handler

**Name:** `hyperp-task-state-change-handler`

**Trigger:** EventBridge (when ECS tasks stop)

**Responsibilities:**

- Track image build completions
- Track job run completions
- Start dependent jobs when dependencies complete
- Mark workflows as succeeded/failed
- Delete old ECR images
- Trigger downloadable creator tasks
- Launch usage calculator

**Memory:** 512 MB | **Timeout:** 2 minutes

### 3. EFS Controller

**Name:** `hyperp-efs-controller`

**Trigger:** Invoked by other Lambdas

**Responsibilities:**

- Create directories on EFS for job outputs
- Create shared volume directories
- Set proper permissions

**Why a separate Lambda?** Only Lambdas with VPC access can mount EFS. This Lambda is invoked to create directories before tasks run.

**Memory:** 512 MB | **Timeout:** 30 seconds

### 4. CLI REST API

**Name:** `hyperp-cli-rest-api`

**Trigger:** HTTP requests from CLI (via Function URL)

**Responsibilities:**

- List workflow runs
- Get workflow run details
- Get job run details
- Get task details and logs
- Trigger downloadable creation
- Generate presigned URLs for downloads

**Memory:** 512 MB | **Timeout:** 30 seconds

### Lambda Function Flow

```
┌─────────────┐     ┌─────────────────────────┐
│   GitHub    │────▶│  GitHub Webhook Handler │
│   Push      │     └───────────┬─────────────┘
└─────────────┘                 │
                                │ Creates runs
                                │ Triggers image builds
                                ▼
                    ┌─────────────────────────┐
                    │      ECS Tasks          │
                    │  (Image Builds / Jobs)  │
                    └───────────┬─────────────┘
                                │
                                │ Task stops
                                ▼
                    ┌─────────────────────────┐
                    │  Task State Change      │
                    │       Handler           │
                    └───────────┬─────────────┘
                                │
                    ┌───────────┴───────────┐
                    │                       │
                    ▼                       ▼
           Start next jobs          Mark complete
           Update DynamoDB          Clean up ECR

┌─────────────┐     ┌─────────────────────────┐
│  Hyperp     │────▶│     CLI REST API        │
│   CLI       │◀────│       Lambda            │
└─────────────┘     └─────────────────────────┘
```

---

## Event System

### EventBridge Rule

**What it is:** A serverless event bus that routes events to targets.

**Rule Name:** `EcsTaskStateChangeRule`

**Event Pattern:**

```json
{
  "source": ["aws.ecs"],
  "detail-type": ["ECS Task State Change"],
  "detail": {
    "clusterArn": ["arn:aws:ecs:...:cluster/hyperp-1"],
    "lastStatus": ["STOPPED"]
  }
}
```

**Why needed?** When any ECS task in the Hyperp cluster stops (success or failure), EventBridge automatically triggers the Task State Change Handler Lambda. This is how Hyperp knows when:

- An image build completed
- A job finished
- A task failed

---

## Security

### IAM Roles

Hyperp uses three IAM roles with principle of least privilege.

#### 1. ECS Task Execution Role

**Purpose:** Allows ECS to pull images and write logs on behalf of tasks.

**Permissions:**

- `AmazonECSTaskExecutionRolePolicy` (AWS managed)
- ECR pull access

**Used by:** All ECS tasks (to start up)

#### 2. ECS Task Role

**Purpose:** Permissions that your running containers have.

**Permissions:**
| Service | Actions | Purpose |
|---------|---------|---------|
| EFS | ClientMount, ClientWrite | Access shared storage |
| ECR | Push, Pull | Build and store images |
| S3 | Get, Put, List | Upload artifacts |
| DynamoDB | Read, Write | Usage calculator updates |

**Used by:** Running job containers

#### 3. Lambda Role

**Purpose:** Permissions for all Lambda functions.

**Permissions:**
| Service | Actions | Purpose |
|---------|---------|---------|
| DynamoDB | Full access | Store/retrieve state |
| S3 | Read, Write | Manage artifacts |
| ECS | Register tasks, Run tasks | Start containers |
| ECR | Auth, Delete | Manage images |
| CloudWatch Logs | Get events | Stream logs to CLI |
| Lambda | Invoke | Call EFS controller |
| IAM | PassRole | Pass roles to ECS |

### Permission Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                     IAM Role Relationships                       │
└─────────────────────────────────────────────────────────────────┘

┌──────────────┐                          ┌──────────────────────┐
│   Lambda     │─── PassRole ────────────▶│ ECS Task Execution   │
│    Role      │                          │       Role           │
└──────┬───────┘                          └──────────────────────┘
       │                                           │
       │                                           │ Pull images
       │ PassRole                                  │ Write logs
       │                                           ▼
       │                                  ┌──────────────────────┐
       └─────────────────────────────────▶│   ECS Task Role      │
                                          └──────────────────────┘
                                                   │
                                                   │ Mount EFS
                                                   │ Push to ECR
                                                   │ Write to S3
                                                   ▼
                                          ┌──────────────────────┐
                                          │  Running Container   │
                                          └──────────────────────┘
```

---

## Logging & Monitoring

### CloudWatch Logs

**Log Group:** `/hyperp`

**What gets logged:**

- All ECS task output (stdout/stderr)
- Lambda function logs
- Container build logs

**Log Stream Format:**

```
{commit-hash}/{workflow-hash}/{job-hash}/{run-id}
```

**Retention:** 7 days (to minimize costs)

### Container Insights

Enabled on the ECS cluster for:

- CPU/Memory utilization metrics
- Task count metrics
- Container-level insights

---

## Component Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            HYPERP INFRASTRUCTURE                             │
└─────────────────────────────────────────────────────────────────────────────┘

                                    INTERNET
                                       │
           ┌───────────────────────────┼───────────────────────────┐
           │                           │                           │
           ▼                           ▼                           ▼
    ┌─────────────┐            ┌─────────────┐             ┌─────────────┐
    │   GitHub    │            │  Hyperp CLI │             │   GitHub    │
    │   Webhook   │            │   (User)    │             │    API      │
    └──────┬──────┘            └──────┬──────┘             └──────▲──────┘
           │                          │                           │
           │ POST                     │ GET/POST                  │ Token
           ▼                          ▼                           │
┌──────────────────────────────────────────────────────────────────────────────┐
│                                 AWS CLOUD                                     │
│                                                                               │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │                          LAMBDA FUNCTIONS                                │ │
│  │                                                                          │ │
│  │  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐      │ │
│  │  │    Webhook       │  │  Task State      │  │    CLI REST      │      │ │
│  │  │    Handler       │  │  Change Handler  │  │      API         │      │ │
│  │  └────────┬─────────┘  └────────▲─────────┘  └────────┬─────────┘      │ │
│  │           │                     │                     │                 │ │
│  │           │                ┌────┴────┐                │                 │ │
│  │           │                │EventBridge               │                 │ │
│  │           │                └────▲────┘                │                 │ │
│  └───────────│─────────────────────│─────────────────────│─────────────────┘ │
│              │                     │                     │                   │
│              ▼                     │                     ▼                   │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │                              VPC                                         │ │
│  │                                                                          │ │
│  │  ┌────────────────────────────────────────────────────────────────────┐ │ │
│  │  │                        ECS CLUSTER                                  │ │ │
│  │  │  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐  │ │ │
│  │  │  │ Image   │  │  Job    │  │  Job    │  │Download │  │ Usage   │  │ │ │
│  │  │  │ Build   │  │ Task 1  │  │ Task 2  │  │ Creator │  │ Calc    │  │ │ │
│  │  │  └────┬────┘  └────┬────┘  └────┬────┘  └────┬────┘  └────┬────┘  │ │ │
│  │  │       │            │            │            │            │       │ │ │
│  │  └───────│────────────│────────────│────────────│────────────│───────┘ │ │
│  │          │            │            │            │            │         │ │
│  │          │            └─────┬──────┘            │            │         │ │
│  │          │                  │                   │            │         │ │
│  │          ▼                  ▼                   ▼            ▼         │ │
│  │  ┌─────────────┐    ┌─────────────┐     ┌─────────────┐               │ │
│  │  │     ECR     │    │     EFS     │     │      S3     │               │ │
│  │  │  (Images)   │    │ (Artifacts) │     │ (Downloads) │               │ │
│  │  └─────────────┘    └─────────────┘     └─────────────┘               │ │
│  │                                                                        │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                               │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │                            DYNAMODB                                      │ │
│  │                                                                          │ │
│  │   Workflows │ Jobs │ WorkflowRuns │ JobRuns │ Tasks │ ImageBuilds       │ │
│  │                                                                          │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                               │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │                          CLOUDWATCH LOGS                                 │ │
│  │                          /hyperp (all task logs)                         │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                               │
└───────────────────────────────────────────────────────────────────────────────┘
```

---

## Cost Optimization

Hyperp is designed to minimize costs:

| Decision                   | Cost Saving                        |
| -------------------------- | ---------------------------------- |
| Public subnets only        | Avoids NAT Gateway (~$32/month)    |
| Fargate (serverless)       | Pay only when tasks run            |
| DynamoDB on-demand         | Pay only for actual requests       |
| EFS with lifecycle         | Automatic tiering to cheap storage |
| CloudWatch 7-day retention | Minimal log storage costs          |
| Single ECR repository      | Simplified management              |

**Typical Monthly Costs:**

- Idle: ~$5 (EFS minimum, DynamoDB storage)
- Light usage: ~$10-20
- Heavy usage: Scales with compute time

---

## Summary

| Component         | AWS Service    | Purpose                           |
| ----------------- | -------------- | --------------------------------- |
| Network           | VPC + Subnets  | Isolated network for resources    |
| Firewall          | Security Group | Control traffic to/from tasks     |
| Container Runtime | ECS Fargate    | Run jobs without managing servers |
| Image Storage     | ECR            | Store built Docker images         |
| Shared Storage    | EFS            | Pass files between jobs           |
| Object Storage    | S3             | Downloadable artifacts + PEM key  |
| Database          | DynamoDB       | All platform state                |
| Functions         | Lambda         | Event handling + API              |
| Events            | EventBridge    | React to task state changes       |
| Permissions       | IAM Roles      | Secure access control             |
| Logging           | CloudWatch     | Task output and debugging         |

All components work together to provide a fully serverless, GitOps-driven compute platform where you push code and everything else is handled automatically.

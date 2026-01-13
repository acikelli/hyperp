# hyperp - Fully Automated Serverless Compute Platform

hyperp is a fully automated serverless compute platform built on AWS. It embraces a complete GitOps workflow, automatically managing CI/CD pipelines while providing integrated artifact storage for data transfer between jobs and local download. The platform includes built-in cost estimation for both compute and storage resources per run, and offers a straightforward CLI for easy interaction.

![Alt text](./docs/images/hyperp-overview.png)

[How it works](./docs/architecture.md)

[Setup instructions](./docs/setup.md)

## CLI Features

![Alt text](./docs/images/cli.gif)

- Monitor triggerred runs and view their details.
- View task logs.
- View cost estimations for compute resource usage per task/job/workflow.
- Get storage usage per job/workflow.
- Download artifacts to your local machine.

## Architecture Overview

Hyperp consists of the following components:

### Infrastructure

- **VPC**: Large addressable VPC (10.0.0.0/16) with public subnets
- **ECS Fargate Cluster**: For running containerized jobs
- **ECR Repository**: For storing built Docker images
- **EFS File System**: For sharing artifacts between jobs
- **DynamoDB**: For storing workflow metadata, runs, and state
- **S3 Bucket**: For downloading artifacts
- **EventBridge**: For tracking ECS task state changes

### Lambda Functions

1. **GitHub Webhook Handler**: Processes commit events, syncs workflows, triggers runs
2. **Task State Change Handler**: Tracks ECS task completion, manages job orchestration
3. **EFS Controller**: Creates directories on EFS for artifact storage
4. **CLI REST API**: Provides REST API endpoints for the CLI tool to query workflow runs

import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as efs from "aws-cdk-lib/aws-efs";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as path from "path";
import * as fs from "fs";

export class HyperpStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Resolve Lambda entry paths - handle both development and npm package contexts
    // When compiled, __dirname is dist/lib/, so we need to go up to package root
    // When in npm package, we need to find the package root
    const getLambdaPath = (lambdaPath: string): string => {
      // Try relative to __dirname first (for npm package - go up 2 levels from dist/lib/)
      const npmPath = path.join(__dirname, "../../lambda", lambdaPath);
      if (fs.existsSync(npmPath)) {
        return npmPath;
      }
      // Try relative to __dirname with one less level (for development - from lib/)
      const devPath = path.join(__dirname, "../lambda", lambdaPath);
      if (fs.existsSync(devPath)) {
        return devPath;
      }
      // Fallback: try to find package root by looking for package.json
      let currentDir = __dirname;
      while (currentDir !== path.dirname(currentDir)) {
        const packageJsonPath = path.join(currentDir, "package.json");
        if (fs.existsSync(packageJsonPath)) {
          const lambdaFullPath = path.join(currentDir, "lambda", lambdaPath);
          if (fs.existsSync(lambdaFullPath)) {
            return lambdaFullPath;
          }
        }
        currentDir = path.dirname(currentDir);
      }
      // Last resort: return the path relative to __dirname (will fail if file doesn't exist)
      return path.join(__dirname, "../lambda", lambdaPath);
    };

    // Find root package-lock.json for Lambda bundling
    const getLockFilePath = (): string | undefined => {
      // Try multiple possible locations - including the copied hyperp-package-lock.json for npm package
      const possiblePaths = [
        path.join(__dirname, "../../hyperp-package-lock.json"), // npm package (copied file)
        path.join(__dirname, "../../package-lock.json"), // npm package (from dist/lib/)
        path.join(__dirname, "../package-lock.json"), // development (from lib/)
      ];

      for (const lockPath of possiblePaths) {
        if (fs.existsSync(lockPath)) {
          return lockPath;
        }
      }

      // Try to find package root by looking for package-lock.json or hyperp-package-lock.json
      let currentDir = __dirname;
      while (currentDir !== path.dirname(currentDir)) {
        // Check for the copied lock file first (npm package)
        const hyperpLockPath = path.join(
          currentDir,
          "hyperp-package-lock.json"
        );
        if (fs.existsSync(hyperpLockPath)) {
          return hyperpLockPath;
        }
        // Then check for standard lock file (development)
        const lockPath = path.join(currentDir, "package-lock.json");
        if (fs.existsSync(lockPath)) {
          return lockPath;
        }
        currentDir = path.dirname(currentDir);
      }

      return undefined;
    };

    // Get GitHub App configuration from CDK context
    const githubAppId =
      this.node.tryGetContext("githubAppId") || process.env.GITHUB_APP_ID;
    const githubAppWebhookSecret =
      this.node.tryGetContext("githubAppWebhookSecret") ||
      process.env.GITHUB_APP_WEBHOOK_SECRET;

    if (!githubAppId) {
      throw new Error(
        "GitHub App ID is required. Provide it via --github-app-id or CDK context."
      );
    }

    if (!githubAppWebhookSecret) {
      throw new Error(
        "GitHub App webhook secret is required. Provide it via --github-app-webhook-secret or CDK context."
      );
    }

    // ============================================
    // VPC - Large addressable VPC (Public subnets only to avoid NAT gateway costs)
    // ============================================
    const vpc = new ec2.Vpc(this, "HyperpVpc", {
      maxAzs: 3,
      ipAddresses: ec2.IpAddresses.cidr("10.0.0.0/16"),
      natGateways: 0, // No NAT gateways - using public subnets only
      subnetConfiguration: [
        {
          cidrMask: 20,
          name: "Public",
          subnetType: ec2.SubnetType.PUBLIC,
        },
      ],
    });

    // ============================================
    // S3 Bucket for artifacts (GitHub App PEM key)
    // ============================================
    // Let CDK generate a unique bucket name to avoid global naming conflicts
    // The bucket name will be available via stack outputs
    const artifactsBucket = new s3.Bucket(this, "HyperpArtifactsBucket", {
      // Removed fixed bucketName to avoid global naming conflicts
      // CDK will generate: hyperpstack-hyperpartifactsbucket-<random>
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: false, // Keep objects when stack is deleted
    });

    // ============================================
    // DynamoDB Table with GSI
    // ============================================
    const table = new dynamodb.Table(this, "HyperpTable", {
      tableName: "hyperp",
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pointInTimeRecovery: true,
    });

    // GSI1 for querying workflows, workflow runs, etc.
    table.addGlobalSecondaryIndex({
      indexName: "GSI1",
      partitionKey: { name: "GSI1-PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "GSI1-SK", type: dynamodb.AttributeType.STRING },
    });

    // GSI2 for querying workflow runs by commit hash
    table.addGlobalSecondaryIndex({
      indexName: "GSI2",
      partitionKey: { name: "GSI2-PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "GSI2-SK", type: dynamodb.AttributeType.STRING },
    });

    // GSI3 for querying all workflow runs sorted by creation time
    table.addGlobalSecondaryIndex({
      indexName: "GSI3",
      partitionKey: { name: "GSI3-PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "GSI3-SK", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.INCLUDE,
      nonKeyAttributes: [
        "workflowName",
        "status",
        "createdAt",
        "updatedAt",
        "entityId",
      ],
    });

    // ============================================
    // ECR Repository
    // ============================================
    const ecrRepository = new ecr.Repository(this, "HyperpRepository", {
      repositoryName: "hyperp-1",
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      imageScanOnPush: false,
      lifecycleRules: [
        {
          description: "Keep last 100 images",
          maxImageCount: 100,
        },
      ],
    });

    // ============================================
    // ECS Cluster
    // ============================================
    const cluster = new ecs.Cluster(this, "HyperpCluster", {
      clusterName: "hyperp-1",
      vpc: vpc,
      containerInsights: true,
    });

    // ============================================
    // EFS File System for artifact sharing
    // ============================================
    const fileSystem = new efs.FileSystem(this, "HyperpEfs", {
      vpc: vpc,
      encrypted: true,
      lifecyclePolicy: efs.LifecyclePolicy.AFTER_14_DAYS,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      throughputMode: efs.ThroughputMode.ELASTIC,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      fileSystemPolicy: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            actions: [
              "elasticfilesystem:ClientMount",
              "elasticfilesystem:ClientWrite",
              "elasticfilesystem:ClientRootAccess",
            ],
            principals: [new iam.AnyPrincipal()],
            resources: ["*"],
            conditions: {
              Bool: {
                "elasticfilesystem:AccessedViaMountTarget": "true",
              },
            },
          }),
        ],
      }),
    });

    // Security group for ECS tasks
    const ecsTaskSecurityGroup = new ec2.SecurityGroup(
      this,
      "EcsTaskSecurityGroup",
      {
        vpc: vpc,
        description: "Security group for ECS tasks",
        allowAllOutbound: true,
      }
    );

    // Allow ECS tasks to connect to EFS on NFS port
    fileSystem.connections.allowFrom(
      ecsTaskSecurityGroup,
      ec2.Port.tcp(2049),
      "Allow NFS from ECS tasks"
    );

    // ============================================
    // CloudWatch Logs
    // ============================================
    const ecsLogGroup = new logs.LogGroup(this, "HyperpEcsLogGroup", {
      logGroupName: "/hyperp",
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ============================================
    // IAM Roles
    // ============================================

    // ECS Task Execution Role
    const ecsTaskExecutionRole = new iam.Role(this, "EcsTaskExecutionRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AmazonECSTaskExecutionRolePolicy"
        ),
      ],
    });

    // Grant ECR permissions
    ecrRepository.grantPull(ecsTaskExecutionRole);

    // ECS Task Role (for containers)
    const ecsTaskRole = new iam.Role(this, "EcsTaskRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
    });

    // Grant EFS permissions to task role
    ecsTaskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "elasticfilesystem:ClientMount",
          "elasticfilesystem:ClientWrite",
          "elasticfilesystem:ClientRootAccess",
          "elasticfilesystem:DescribeMountTargets",
        ],
        resources: [fileSystem.fileSystemArn],
      })
    );

    // Grant ECR push/pull for image builds
    ecrRepository.grantPullPush(ecsTaskRole);

    // Grant S3 access for reading repository content and uploading artifacts
    ecsTaskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject", "s3:ListBucket", "s3:PutObject"],
        resources: ["*"],
      })
    );

    // Grant DynamoDB permissions for usage calculator tasks
    table.grantReadWriteData(ecsTaskRole);
    // Explicitly grant UpdateItem permission to ensure usage calculator can update items
    ecsTaskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:Query",
          "dynamodb:Scan",
        ],
        resources: [table.tableArn, `${table.tableArn}/index/*`],
      })
    );

    // ============================================
    // Lambda Execution Role
    // ============================================
    const lambdaRole = new iam.Role(this, "HyperpLambdaRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AWSLambdaVPCAccessExecutionRole"
        ),
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AWSLambdaBasicExecutionRole"
        ),
      ],
    });

    // Grant DynamoDB permissions
    table.grantReadWriteData(lambdaRole);

    // Grant S3 permissions (read and write for downloadable artifacts)
    artifactsBucket.grantReadWrite(lambdaRole);

    // Grant CloudWatch Logs permissions
    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["logs:GetLogEvents", "logs:DescribeLogStreams"],
        resources: ["*"],
      })
    );

    // Grant ECS permissions for downloadable creator tasks
    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "ecs:RegisterTaskDefinition",
          "ecs:RunTask",
          "ecs:DescribeTasks",
        ],
        resources: ["*"],
      })
    );

    // Grant ECS permissions
    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "ecs:RegisterTaskDefinition",
          "ecs:RunTask",
          "ecs:DescribeTasks",
          "ecs:StopTask",
          "ecs:ListTasks",
        ],
        resources: ["*"],
      })
    );

    // Grant IAM PassRole for ECS
    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["iam:PassRole"],
        resources: [ecsTaskExecutionRole.roleArn, ecsTaskRole.roleArn],
      })
    );

    // Grant ECR permissions
    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "ecr:GetAuthorizationToken",
          "ecr:BatchCheckLayerAvailability",
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
          "ecr:BatchDeleteImage",
        ],
        resources: ["*"],
      })
    );

    // Grant Lambda invoke permissions (for EFS controller)
    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["lambda:InvokeFunction"],
        resources: [
          `arn:aws:lambda:${this.region}:${this.account}:function:hyperp-efs-controller`,
          `arn:aws:lambda:${this.region}:${this.account}:function:hyperp-efs-controller:*`,
        ],
      })
    );

    // ============================================
    // EFS Controller Lambda
    // ============================================
    // Create an access point for Lambda to mount EFS
    // Mount at /hyperp-artifacts so Lambda has write access to that directory
    const lambdaAccessPoint = new efs.AccessPoint(
      this,
      "LambdaEfsAccessPoint",
      {
        fileSystem: fileSystem,
        path: "/hyperp-artifacts",
        createAcl: {
          ownerGid: "1000",
          ownerUid: "1000",
          permissions: "777", // More permissive for Lambda to create subdirectories
        },
        posixUser: {
          uid: "1000",
          gid: "1000",
        },
      }
    );

    const efsControllerLambda = new NodejsFunction(
      this,
      "HyperpEfsController",
      {
        functionName: "hyperp-efs-controller",
        runtime: lambda.Runtime.NODEJS_20_X,
        handler: "handler",
        entry: getLambdaPath("efs-controller/index.ts"),
        timeout: cdk.Duration.seconds(30),
        memorySize: 512,
        vpc: vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
        securityGroups: [ecsTaskSecurityGroup],
        allowPublicSubnet: true,
        bundling: {
          minify: true,
          sourceMap: true,
          format: OutputFormat.CJS,
        },
        depsLockFilePath: getLockFilePath(), // Use root package-lock.json
        environment: {
          EFS_FILE_SYSTEM_ID: fileSystem.fileSystemId,
        },
        role: lambdaRole,
        filesystem: lambda.FileSystem.fromEfsAccessPoint(
          lambdaAccessPoint,
          "/mnt/efs"
        ),
      }
    );

    // ============================================
    // Collect subnet IDs for environment variables
    // ============================================
    const publicSubnetIds = vpc.publicSubnets
      .map((subnet) => subnet.subnetId)
      .join(",");

    // ============================================
    // GitHub Webhook Handler Lambda
    // ============================================
    const githubWebhookHandler = new NodejsFunction(
      this,
      "HyperpGithubWebhookHandler",
      {
        functionName: "hyperp-github-webhook-handler",
        runtime: lambda.Runtime.NODEJS_20_X,
        handler: "handler",
        entry: getLambdaPath("github-webhook-handler/index.ts"),
        timeout: cdk.Duration.minutes(5),
        memorySize: 1024,
        environment: {
          DYNAMODB_TABLE_NAME: table.tableName,
          S3_BUCKET_NAME: artifactsBucket.bucketName,
          ECS_CLUSTER_ARN: cluster.clusterArn,
          ECS_CLUSTER_NAME: cluster.clusterName,
          ECR_REPOSITORY_URI: ecrRepository.repositoryUri,
          ECR_REPOSITORY_NAME: ecrRepository.repositoryName,
          ECS_TASK_EXECUTION_ROLE_ARN: ecsTaskExecutionRole.roleArn,
          ECS_TASK_ROLE_ARN: ecsTaskRole.roleArn,
          EFS_FILE_SYSTEM_ID: fileSystem.fileSystemId,
          ECS_TASK_SECURITY_GROUP_ID: ecsTaskSecurityGroup.securityGroupId,
          PUBLIC_SUBNET_IDS: publicSubnetIds,
          EFS_CONTROLLER_LAMBDA_ARN: efsControllerLambda.functionArn,
          GITHUB_APP_ID: githubAppId,
          GITHUB_APP_WEBHOOK_SECRET: githubAppWebhookSecret,
          AWS_ACCOUNT_ID: this.account,
        },
        role: lambdaRole,
        bundling: {
          minify: true,
          sourceMap: true,
          format: OutputFormat.CJS,
        },
        depsLockFilePath: getLockFilePath(), // Use root package-lock.json
      }
    );

    // Create Function URL for GitHub Webhook Handler
    const webhookFunctionUrl = githubWebhookHandler.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE, // Public access for GitHub webhooks
      cors: {
        allowedOrigins: ["*"],
        allowedMethods: [lambda.HttpMethod.POST],
        allowedHeaders: ["*"],
      },
    });

    // ============================================
    // Task State Change Handler Lambda
    // ============================================
    const taskStateChangeHandler = new NodejsFunction(
      this,
      "HyperpTaskStateChangeHandler",
      {
        functionName: "hyperp-task-state-change-handler",
        runtime: lambda.Runtime.NODEJS_20_X,
        handler: "handler",
        entry: getLambdaPath("task-state-change-handler/index.ts"),
        timeout: cdk.Duration.minutes(2),
        memorySize: 512,
        environment: {
          DYNAMODB_TABLE_NAME: table.tableName,
          ECS_CLUSTER_ARN: cluster.clusterArn,
          ECS_CLUSTER_NAME: cluster.clusterName,
          ECR_REPOSITORY_URI: ecrRepository.repositoryUri,
          ECS_TASK_EXECUTION_ROLE_ARN: ecsTaskExecutionRole.roleArn,
          ECS_TASK_ROLE_ARN: ecsTaskRole.roleArn,
          EFS_FILE_SYSTEM_ID: fileSystem.fileSystemId,
          ECS_TASK_SECURITY_GROUP_ID: ecsTaskSecurityGroup.securityGroupId,
          PUBLIC_SUBNET_IDS: publicSubnetIds,
          EFS_CONTROLLER_LAMBDA_ARN: efsControllerLambda.functionArn,
          AWS_ACCOUNT_ID: this.account,
          FARGATE_VCPU_PRICE_PER_HOUR: "0.04048",
          FARGATE_GB_PRICE_PER_HOUR: "0.004445",
          S3_BUCKET_NAME: artifactsBucket.bucketName,
          GITHUB_APP_ID: githubAppId,
          DOWNLOADABLE_CREATOR_IMAGE:
            "public.ecr.aws/b6g9t8f1/downloadable-creator:latest",
          USAGE_CALCULATOR_IMAGE:
            "public.ecr.aws/b6g9t8f1/usage-calculator:latest",
        },
        role: lambdaRole,
        bundling: {
          minify: true,
          sourceMap: true,
          format: OutputFormat.CJS,
        },
        depsLockFilePath: getLockFilePath(), // Use root package-lock.json
      }
    );

    // ============================================
    // EventBridge Rule for ECS Task State Changes
    // ============================================
    const ecsTaskStateChangeRule = new events.Rule(
      this,
      "EcsTaskStateChangeRule",
      {
        eventPattern: {
          source: ["aws.ecs"],
          detailType: ["ECS Task State Change"],
          detail: {
            clusterArn: [cluster.clusterArn],
            lastStatus: ["STOPPED"],
          },
        },
      }
    );

    ecsTaskStateChangeRule.addTarget(
      new targets.LambdaFunction(taskStateChangeHandler)
    );

    // ============================================
    // Outputs
    // ============================================
    new cdk.CfnOutput(this, "VpcId", {
      value: vpc.vpcId,
      description: "VPC ID",
    });

    new cdk.CfnOutput(this, "ClusterArn", {
      value: cluster.clusterArn,
      description: "ECS Cluster ARN",
    });

    new cdk.CfnOutput(this, "EcrRepositoryUri", {
      value: ecrRepository.repositoryUri,
      description: "ECR Repository URI",
    });

    new cdk.CfnOutput(this, "DynamoDbTableName", {
      value: table.tableName,
      description: "DynamoDB Table Name",
    });

    new cdk.CfnOutput(this, "S3BucketName", {
      value: artifactsBucket.bucketName,
      description: "S3 Artifacts Bucket Name",
    });

    new cdk.CfnOutput(this, "EfsFileSystemId", {
      value: fileSystem.fileSystemId,
      description: "EFS File System ID",
    });

    new cdk.CfnOutput(this, "GithubWebhookHandlerArn", {
      value: githubWebhookHandler.functionArn,
      description: "GitHub Webhook Handler Lambda ARN",
    });

    new cdk.CfnOutput(this, "GithubWebhookHandlerUrl", {
      value: webhookFunctionUrl.url,
      description: "GitHub Webhook Handler Function URL",
    });

    new cdk.CfnOutput(this, "TaskStateChangeHandlerArn", {
      value: taskStateChangeHandler.functionArn,
      description: "Task State Change Handler Lambda ARN",
    });

    new cdk.CfnOutput(this, "PublicSubnetIds", {
      value: publicSubnetIds,
      description: "Public Subnet IDs",
    });

    // ============================================
    // REST API Lambda for CLI
    // ============================================
    const cliRestApiLambda = new NodejsFunction(this, "HyperpCliRestApi", {
      functionName: "hyperp-cli-rest-api",
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "handler",
      entry: getLambdaPath("cli-rest-api/index.ts"),
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: {
        DYNAMODB_TABLE_NAME: table.tableName,
        ECS_CLUSTER_NAME: cluster.clusterName,
        EFS_FILE_SYSTEM_ID: fileSystem.fileSystemId,
        PUBLIC_SUBNET_IDS: vpc.publicSubnets.map((s) => s.subnetId).join(","),
        ECS_TASK_SECURITY_GROUP_ID: ecsTaskSecurityGroup.securityGroupId,
        ECS_TASK_EXECUTION_ROLE_ARN: ecsTaskExecutionRole.roleArn,
        ECS_TASK_ROLE_ARN: ecsTaskRole.roleArn,
        S3_BUCKET_NAME: artifactsBucket.bucketName,
        DOWNLOADABLE_CREATOR_IMAGE:
          "public.ecr.aws/b6g9t8f1/downloadable-creator:latest",
        GITHUB_APP_ID: githubAppId,
        GITHUB_APP_WEBHOOK_SECRET: githubAppWebhookSecret,
      },
      role: lambdaRole,
      bundling: {
        minify: true,
        sourceMap: true,
        format: OutputFormat.CJS,
      },
      depsLockFilePath: getLockFilePath(), // Use root package-lock.json
    });

    // Create Function URL
    const functionUrl = cliRestApiLambda.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE, // Public access (can be secured later)
      cors: {
        allowedOrigins: ["*"],
        allowedMethods: [lambda.HttpMethod.GET, lambda.HttpMethod.POST],
        allowedHeaders: ["*"],
      },
    });

    new cdk.CfnOutput(this, "CliRestApiUrl", {
      value: functionUrl.url,
      description: "CLI REST API Function URL",
    });
  }
}

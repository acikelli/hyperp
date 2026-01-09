const https = require("https");
const http = require("http");
const inquirer = require("inquirer");
const fs = require("fs");
const path = require("path");
const os = require("os");

const CONFIG_FILE = path.join(os.homedir(), ".hyperp", "config.json");

function loadConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  }
  return {};
}

function makeRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const isHttps = urlObj.protocol === "https:";
    const client = isHttps ? https : http;

    // Get API secret from config
    const config = loadConfig();
    const apiSecret = config.githubAppWebhookSecret;

    // Build headers with API secret if available
    const headers = { ...(options.headers || {}) };
    if (apiSecret) {
      headers["X-Api-Secret"] = apiSecret;
    }

    const req = client.request(
      {
        hostname: urlObj.hostname,
        port: urlObj.port || (isHttps ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: options.method || "GET",
        headers: headers,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            resolve({ statusCode: res.statusCode, data: json });
          } catch (e) {
            resolve({ statusCode: res.statusCode, data: data });
          }
        });
      }
    );

    req.on("error", reject);
    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

function formatDate(dateString) {
  if (!dateString) return "N/A";
  const date = new Date(dateString);
  return date.toLocaleString();
}

function formatStatus(status) {
  const statusMap = {
    WAITING_FOR_IMAGE_BUILDS: "⏳ Waiting",
    RUNNING: "🔄 Running",
    SUCCEEDED: "✅ Succeeded",
    FAILED: "❌ Failed",
    PENDING: "⏳ Pending",
  };
  return statusMap[status] || status;
}

function formatJobStatus(status) {
  const statusMap = {
    PENDING: "⏳ Pending",
    RUNNING: "🔄 Running",
    SUCCEEDED: "✅ Succeeded",
    FAILED: "❌ Failed",
  };
  return statusMap[status] || status;
}

function formatImageBuildStatus(status) {
  const statusMap = {
    PENDING: "⏳ Pending",
    RUNNING: "🔄 Running",
    SUCCEEDED: "✅ Succeeded",
    FAILED: "❌ Failed",
  };
  return statusMap[status] || status;
}

function formatDuration(startDate, endDate) {
  if (!startDate || !endDate) return "N/A";
  const start = new Date(startDate);
  const end = new Date(endDate);
  const diffMs = end - start;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);

  if (diffHour > 0) {
    return `${diffHour}h ${diffMin % 60}m ${diffSec % 60}s`;
  } else if (diffMin > 0) {
    return `${diffMin}m ${diffSec % 60}s`;
  } else {
    return `${diffSec}s`;
  }
}

// Build dependency graph for DAG display
function buildDependencyGraph(jobRuns) {
  const graph = {
    nodes: new Map(),
    edges: [],
    roots: [],
  };

  jobRuns.forEach((job) => {
    graph.nodes.set(job.jobName, job);
  });

  jobRuns.forEach((job) => {
    if (!job.dependsOn || job.dependsOn.length === 0) {
      graph.roots.push(job.jobName);
    } else {
      job.dependsOn.forEach((depName) => {
        graph.edges.push([depName, job.jobName]);
      });
    }
  });

  return graph;
}

function getExecutionLevels(graph) {
  const levels = [];
  const processed = new Set();
  const inDegree = new Map();

  graph.nodes.forEach((job, name) => {
    inDegree.set(name, job.dependsOn?.length || 0);
  });

  let currentLevel = [];
  graph.nodes.forEach((job, name) => {
    if (inDegree.get(name) === 0) {
      currentLevel.push(name);
      processed.add(name);
    }
  });

  while (currentLevel.length > 0) {
    levels.push([...currentLevel]);
    const nextLevel = [];

    currentLevel.forEach((jobName) => {
      graph.edges.forEach(([from, to]) => {
        if (from === jobName && !processed.has(to)) {
          const currentInDegree = inDegree.get(to) - 1;
          inDegree.set(to, currentInDegree);
          if (currentInDegree === 0) {
            nextLevel.push(to);
            processed.add(to);
          }
        }
      });
    });

    currentLevel = nextLevel;
  }

  return levels;
}

function displayJobDAG(jobRuns) {
  const graph = buildDependencyGraph(jobRuns);
  const levels = getExecutionLevels(graph);

  console.log("\n" + "=".repeat(80));
  console.log("📊 Job Dependency Graph (DAG)");
  console.log("=".repeat(80) + "\n");

  levels.forEach((level, levelIndex) => {
    console.log(
      `Level ${levelIndex + 1} (Executes ${
        levelIndex === 0 ? "first" : `after Level ${levelIndex}`
      }):`
    );
    console.log("-".repeat(80));

    level.forEach((jobName, index) => {
      const job = graph.nodes.get(jobName);
      if (!job) return;

      const prefix = index === level.length - 1 ? "└─" : "├─";
      const statusIcon = formatJobStatus(job.status);
      const taskProgress = `${job.completedTasks}/${job.totalTasks}`;
      const startDate = job.startedAt || job.startDate;
      const endDate = job.stoppedAt || job.endDate;
      const duration = endDate
        ? `Duration: ${formatDuration(startDate, endDate)}`
        : startDate && job.status !== "PENDING"
        ? `Started: ${formatDate(startDate)}`
        : "";

      console.log(`  ${prefix} ${statusIcon} ${job.jobName}`);
      console.log(
        `  ${
          index === level.length - 1 ? " " : "│"
        }    Tasks: ${taskProgress} completed`
      );
      if (duration) {
        console.log(
          `  ${index === level.length - 1 ? " " : "│"}    ${duration}`
        );
      }
      if (job.estimatedCost !== undefined && job.estimatedCost !== null) {
        console.log(
          `  ${
            index === level.length - 1 ? " " : "│"
          }    Estimated Cost: $${job.estimatedCost.toFixed(4)}`
        );
      }
      if (job.storageUsage !== undefined && job.storageUsage !== null) {
        const storageMB = (job.storageUsage / 1024).toFixed(2);
        console.log(
          `  ${
            index === level.length - 1 ? " " : "│"
          }    Storage Usage: ${storageMB} MB (${job.storageUsage} KB)`
        );
      }
      if (job.downloadable !== undefined) {
        if (job.downloadable) {
          if (job.downloadableArtifactsReady) {
            console.log(
              `  ${
                index === level.length - 1 ? " " : "│"
              }    Downloadable: ✅ Ready`
            );
          } else {
            console.log(
              `  ${
                index === level.length - 1 ? " " : "│"
              }    Downloadable: ⏳ Processing...`
            );
          }
        } else {
          console.log(
            `  ${index === level.length - 1 ? " " : "│"}    Downloadable: No`
          );
        }
      }
      if (job.dependsOn && job.dependsOn.length > 0) {
        console.log(
          `  ${
            index === level.length - 1 ? " " : "│"
          }    Depends on: ${job.dependsOn.join(", ")}`
        );
      }
      console.log();
    });
  });

  console.log("=".repeat(80) + "\n");
}

async function listRuns(commitHash = null) {
  const config = loadConfig();
  const apiUrl = config.apiUrl;

  if (!apiUrl) {
    console.error(
      "❌ API URL not found. Please run 'hyperp deploy' first to set up the configuration."
    );
    process.exit(1);
  }

  try {
    let url;
    if (commitHash) {
      console.log(`\n📋 Fetching workflow runs for commit ${commitHash}...\n`);
      url = `${apiUrl}/runs?commitHash=${encodeURIComponent(commitHash)}`;
    } else {
      console.log(`\n📋 Fetching last 10 workflow runs...\n`);
      url = `${apiUrl}/runs`;
    }
    const response = await makeRequest(url);

    if (response.statusCode !== 200) {
      console.error("❌ Error fetching workflow runs:", response.data);
      process.exit(1);
    }

    const { workflowRuns } = response.data;

    if (workflowRuns.length === 0) {
      console.log("No workflow runs found.");
      return;
    }

    const choices = workflowRuns.map((run, index) => {
      const statusIcon = formatStatus(run.status);
      return {
        name: `${statusIcon} ${run.workflowName} - Created: ${formatDate(
          run.createdAt
        )}`,
        value: index,
        short: run.workflowName,
      };
    });

    let selectedIndex;
    while (true) {
      const result = await inquirer.prompt([
        {
          type: "list",
          name: "selectedIndex",
          message: "Select a workflow run to view details:",
          choices: choices,
          pageSize: 10,
        },
      ]);

      selectedIndex = result.selectedIndex;

      const goBack = await showWorkflowRunDetails(
        apiUrl,
        workflowRuns[selectedIndex].entityId
      );

      if (!goBack) {
        break;
      }
    }
  } catch (error) {
    console.error("❌ Error:", error.message);
    process.exit(1);
  }
}

async function showWorkflowRunDetails(apiUrl, entityId) {
  try {
    console.log(`\n📋 Fetching workflow run details...\n`);

    const url = `${apiUrl}/runs/${encodeURIComponent(entityId)}`;
    const response = await makeRequest(url);

    if (response.statusCode !== 200) {
      console.error("❌ Error fetching workflow run details:", response.data);
      return false;
    }

    const { workflowRun } = response.data;

    console.log("=".repeat(80));
    console.log("📊 Workflow Run Details");
    console.log("=".repeat(80) + "\n");

    console.log(`Workflow Name: ${workflowRun.workflowName}`);
    console.log(`Status: ${formatStatus(workflowRun.status)}`);
    if (workflowRun.failureReason) {
      console.log(`❌ Failure Reason: ${workflowRun.failureReason}`);
    }
    console.log(`Branch: ${workflowRun.branch}`);
    console.log(`Commit Hash: ${workflowRun.commitHash}`);
    console.log(`Created At: ${formatDate(workflowRun.createdAt)}`);
    console.log(`Updated At: ${formatDate(workflowRun.updatedAt)}`);

    if (workflowRun.endDate) {
      console.log(`End Date: ${formatDate(workflowRun.endDate)}`);
      console.log(
        `Duration: ${formatDuration(
          workflowRun.startDate,
          workflowRun.endDate
        )}`
      );
    } else {
      console.log(`Start Date: ${formatDate(workflowRun.startDate)}`);
    }

    console.log(
      `\nJobs: ${workflowRun.completedJobs}/${workflowRun.totalJobs} completed`
    );
    console.log(
      `Image Builds: ${workflowRun.completedImageBuilds}/${workflowRun.totalImageBuilds} completed`
    );

    // Display estimated cost and storage usage if calculation is finished
    const hasCostInfo =
      workflowRun.estimatedCost !== undefined &&
      workflowRun.estimatedCost !== null;
    const hasStorageInfo =
      workflowRun.storageUsage !== undefined &&
      workflowRun.storageUsage !== null;

    if (hasCostInfo || hasStorageInfo) {
      console.log(`\n📊 Usage Information:`);
      if (hasCostInfo) {
        console.log(
          `   Estimated Cost: $${workflowRun.estimatedCost.toFixed(4)}`
        );
      }
      if (hasStorageInfo) {
        const storageMB = (workflowRun.storageUsage / 1024).toFixed(2);
        const storageGB = (workflowRun.storageUsage / (1024 * 1024)).toFixed(2);
        if (parseFloat(storageGB) >= 1) {
          console.log(
            `   Storage Usage: ${storageGB} GB (${workflowRun.storageUsage} KB)`
          );
        } else {
          console.log(
            `   Storage Usage: ${storageMB} MB (${workflowRun.storageUsage} KB)`
          );
        }
      }
    }

    if (workflowRun.imageBuildStatuses) {
      console.log(`\nImage Build Status:`);
      console.log(
        `  ✅ Succeeded: ${workflowRun.imageBuildStatuses.succeeded}`
      );
      console.log(`  ❌ Failed: ${workflowRun.imageBuildStatuses.failed}`);
      console.log(`  🔄 Running: ${workflowRun.imageBuildStatuses.running}`);
      console.log(`  ⏳ Pending: ${workflowRun.imageBuildStatuses.pending}`);
    }

    console.log(`\nGitHub Repository ID: ${workflowRun.githubRepositoryId}`);
    console.log(`Entity ID: ${workflowRun.entityId}`);

    console.log("\n" + "=".repeat(80) + "\n");

    const { action } = await inquirer.prompt([
      {
        type: "list",
        name: "action",
        message: "What would you like to do?",
        choices: [
          { name: "Show Jobs", value: "show-jobs" },
          { name: "← Back to List", value: "back" },
        ],
      },
    ]);

    if (action === "back") {
      return true;
    } else if (action === "show-jobs") {
      const { detailType } = await inquirer.prompt([
        {
          type: "list",
          name: "detailType",
          message: "What would you like to view?",
          choices: [
            { name: "Job Runs", value: "job-runs" },
            { name: "Image Build Jobs", value: "image-builds" },
            { name: "← Back", value: "back" },
          ],
        },
      ]);

      if (detailType === "back") {
        return await showWorkflowRunDetails(apiUrl, entityId);
      } else if (detailType === "job-runs") {
        await listJobRuns(apiUrl, entityId, workflowRun.commitHash);
        return await showWorkflowRunDetails(apiUrl, entityId);
      } else if (detailType === "image-builds") {
        await listImageBuilds(apiUrl, entityId, workflowRun.commitHash);
        return await showWorkflowRunDetails(apiUrl, entityId);
      }
    }

    return true;
  } catch (error) {
    console.error("❌ Error:", error.message);
    return false;
  }
}

async function listJobRuns(apiUrl, workflowRunId, commitHash = null) {
  try {
    console.log(`\n📋 Fetching job runs for workflow...\n`);

    const url = `${apiUrl}/workflow-runs/${encodeURIComponent(
      workflowRunId
    )}/job-runs`;
    const response = await makeRequest(url);

    if (response.statusCode !== 200) {
      console.error("❌ Error fetching job runs:", response.data);
      return;
    }

    const { jobRuns } = response.data;

    if (jobRuns.length === 0) {
      console.log("No job runs found.");
      return;
    }

    displayJobDAG(jobRuns);

    while (true) {
      const { selectedJobIndex } = await inquirer.prompt([
        {
          type: "list",
          name: "selectedJobIndex",
          message: "Select a job to view details:",
          choices: [
            ...jobRuns.map((run, index) => ({
              name: `${formatJobStatus(run.status)} ${run.jobName}`,
              value: index,
            })),
            { name: "← Back", value: "back" },
          ],
          pageSize: 10,
        },
      ]);

      if (selectedJobIndex === "back") {
        return;
      }

      const selectedJob = jobRuns[selectedJobIndex];

      console.log("\n" + "=".repeat(80));
      console.log("📋 Detailed Job Information");
      console.log("=".repeat(80) + "\n");

      console.log(`Job Name: ${selectedJob.jobName}`);
      console.log(`Status: ${formatJobStatus(selectedJob.status)}`);

      const startDate = selectedJob.startedAt || selectedJob.startDate;
      const endDate = selectedJob.stoppedAt || selectedJob.endDate;
      if (selectedJob.status !== "PENDING" && startDate) {
        console.log(`Start Date: ${formatDate(startDate)}`);
      }
      if (endDate) {
        console.log(`End Date: ${formatDate(endDate)}`);
        if (startDate) {
          console.log(`Duration: ${formatDuration(startDate, endDate)}`);
        }
      }
      console.log(
        `Tasks: ${selectedJob.completedTasks}/${selectedJob.totalTasks} completed`
      );
      if (
        selectedJob.estimatedCost !== undefined &&
        selectedJob.estimatedCost !== null
      ) {
        console.log(`Estimated Cost: $${selectedJob.estimatedCost.toFixed(4)}`);
      }
      if (
        selectedJob.storageUsage !== undefined &&
        selectedJob.storageUsage !== null
      ) {
        const storageMB = (selectedJob.storageUsage / 1024).toFixed(2);
        console.log(
          `Storage Usage: ${storageMB} MB (${selectedJob.storageUsage} KB)`
        );
      }
      if (selectedJob.downloadable !== undefined) {
        console.log(`Downloadable: ${selectedJob.downloadable ? "Yes" : "No"}`);
        if (selectedJob.downloadable) {
          if (selectedJob.downloadableArtifactsReady) {
            console.log(`Downloadable Artifacts: ✅ Ready`);
          } else {
            console.log(`Downloadable Artifacts: ⏳ Processing...`);
          }
        }
      }
      if (selectedJob.dependsOn && selectedJob.dependsOn.length > 0) {
        console.log(`Dependencies: ${selectedJob.dependsOn.join(", ")}`);
      }
      console.log("\n" + "=".repeat(80) + "\n");

      const choices = [
        { name: "View Tasks", value: "tasks" },
        { name: "View Logs", value: "logs" },
        { name: "← Back to Job List", value: "back" },
      ];

      if (selectedJob.downloadableArtifactsReady) {
        choices.splice(0, 0, {
          name: "📥 Download Artifacts",
          value: "download",
        });
      }

      if (
        !selectedJob.downloadable ||
        !selectedJob.downloadableArtifactsReady
      ) {
        const insertIndex = selectedJob.downloadableArtifactsReady
          ? 1
          : choices.length - 1;
        choices.splice(insertIndex, 0, {
          name: selectedJob.downloadable
            ? "Check Downloadable Status"
            : "Trigger Downloadable Creation",
          value: "trigger-downloadable",
        });
      }

      const { nextAction } = await inquirer.prompt([
        {
          type: "list",
          name: "nextAction",
          message: "What would you like to do?",
          choices: choices,
        },
      ]);

      if (nextAction === "back") {
        continue;
      } else if (nextAction === "download") {
        try {
          console.log("\n📥 Generating download URL...\n");
          const url = `${apiUrl}/job-runs/${encodeURIComponent(
            selectedJob.id
          )}/download-url`;
          const response = await makeRequest(url);

          if (response.statusCode === 200) {
            const { downloadUrl, expiresIn, jobName, s3Location } =
              response.data;
            console.log("✅ Download URL generated successfully!");
            console.log(`\n📦 Job: ${jobName}`);
            console.log(`📍 S3 Location: ${s3Location}`);
            console.log(`⏰ URL expires in: ${expiresIn} seconds (1 hour)`);
            console.log(`\n🔗 Download URL:\n${downloadUrl}\n`);
            console.log(
              "💡 Tip: You can copy this URL and open it in your browser to download the artifacts.\n"
            );
          } else {
            console.error("❌ Error generating download URL:", response.data);
          }
        } catch (error) {
          console.error("❌ Error:", error.message);
        }
      } else if (nextAction === "trigger-downloadable") {
        try {
          console.log("\n🚀 Triggering downloadable creation...\n");
          const url = `${apiUrl}/job-runs/${encodeURIComponent(
            selectedJob.id
          )}/trigger-downloadable`;
          const response = await makeRequest(url, {
            method: "POST",
          });

          if (response.statusCode === 200) {
            console.log("✅ Downloadable creator task triggered successfully!");
            if (response.data.taskArn) {
              console.log(`   Task ARN: ${response.data.taskArn}`);
            }
            console.log(
              "\n⏳ The artifacts will be processed and uploaded to S3."
            );
            console.log(
              "   You can check the status by viewing this job again.\n"
            );
          } else {
            console.error(
              "❌ Error triggering downloadable creation:",
              response.data
            );
          }
        } catch (error) {
          console.error("❌ Error:", error.message);
        }
      } else if (nextAction === "tasks") {
        await listTasks(apiUrl, selectedJob.id, workflowRunId, commitHash);
      } else if (nextAction === "logs") {
        await listTasks(
          apiUrl,
          selectedJob.id,
          workflowRunId,
          commitHash,
          true
        );
      }
    }
  } catch (error) {
    console.error("❌ Error:", error.message);
  }
}

async function listImageBuilds(apiUrl, workflowRunId, commitHash = null) {
  try {
    console.log(`\n📋 Fetching image builds for workflow...\n`);

    const url = `${apiUrl}/workflow-runs/${encodeURIComponent(
      workflowRunId
    )}/image-builds`;
    const response = await makeRequest(url);

    if (response.statusCode !== 200) {
      console.error("❌ Error fetching image builds:", response.data);
      return;
    }

    const { imageBuilds } = response.data;

    if (imageBuilds.length === 0) {
      console.log("No image builds found.");
      return;
    }

    console.log("\n" + "=".repeat(80));
    console.log("📦 Image Build Information");
    console.log("=".repeat(80) + "\n");

    imageBuilds.forEach((build, index) => {
      const statusIcon = formatImageBuildStatus(build.status);
      console.log(
        `${index + 1}. ${statusIcon} ${build.jobName} (Container: ${
          build.containerName
        })`
      );
      console.log(`   Dockerfile: ${build.dockerfilePath || "N/A"}`);
      if (build.startedAt) {
        console.log(`   Started: ${formatDate(build.startedAt)}`);
      }
      if (build.stoppedAt) {
        console.log(`   Stopped: ${formatDate(build.stoppedAt)}`);
        if (build.startedAt) {
          console.log(
            `   Duration: ${formatDuration(build.startedAt, build.stoppedAt)}`
          );
        }
      }
      if (build.estimatedCost !== undefined && build.estimatedCost !== null) {
        console.log(`   Estimated Cost: $${build.estimatedCost.toFixed(4)}`);
      }
      if (build.exitCode !== undefined) {
        console.log(`   Exit Code: ${build.exitCode}`);
      }
      if (build.reason) {
        console.log(`   Reason: ${build.reason}`);
      }
      console.log();
    });

    while (true) {
      const { action } = await inquirer.prompt([
        {
          type: "list",
          name: "action",
          message: "What would you like to do?",
          choices: [
            { name: "View Logs", value: "logs" },
            { name: "← Back", value: "back" },
          ],
        },
      ]);

      if (action === "back") {
        return;
      } else if (action === "logs") {
        const { selectedBuildIndex } = await inquirer.prompt([
          {
            type: "list",
            name: "selectedBuildIndex",
            message: "Select an image build to view logs:",
            choices: [
              ...imageBuilds.map((build, index) => ({
                name: `${formatImageBuildStatus(build.status)} ${
                  build.jobName
                } (${build.containerName})`,
                value: index,
              })),
              { name: "← Back", value: "back" },
            ],
            pageSize: 10,
          },
        ]);

        if (selectedBuildIndex === "back") {
          continue;
        }

        const selectedBuild = imageBuilds[selectedBuildIndex];
        if (selectedBuild.taskArn) {
          const taskId = selectedBuild.taskArn.split("/").pop();
          const logStream = `${selectedBuild.commitHash}/${selectedBuild.workflowNameHash}/${selectedBuild.jobNameHash}/${selectedBuild.containerName}/${taskId}`;
          await showLogs(apiUrl, logStream);
        } else {
          console.log(
            "❌ No task ARN available for this image build. Logs may not be available yet."
          );
        }
      }
    }
  } catch (error) {
    console.error("❌ Error:", error.message);
  }
}

async function listTasks(
  apiUrl,
  jobRunId,
  workflowRunId,
  commitHash,
  showLogsPrompt = false
) {
  try {
    console.log(`\n📋 Fetching tasks for job run...\n`);
    const url = `${apiUrl}/job-runs/${encodeURIComponent(jobRunId)}/tasks`;
    const response = await makeRequest(url);

    if (response.statusCode !== 200) {
      console.error("❌ Error fetching tasks:", response.data);
      return;
    }

    const { tasks } = response.data;

    if (tasks.length === 0) {
      console.log("No tasks found for this job run.");
      return;
    }

    console.log("Tasks:\n");
    tasks.forEach((task, index) => {
      const statusIcon = formatJobStatus(task.status);
      console.log(
        `${index + 1}. ${statusIcon} Task: ${task.taskArn.split("/").pop()}`
      );
      if (task.pullStartedAt) {
        console.log(`   Started: ${formatDate(task.pullStartedAt)}`);
      }
      if (task.stoppedAt) {
        console.log(`   Stopped: ${formatDate(task.stoppedAt)}`);
        if (task.pullStartedAt) {
          console.log(
            `   Duration: ${formatDuration(task.pullStartedAt, task.stoppedAt)}`
          );
        }
      }
      if (task.estimatedCost !== undefined && task.estimatedCost !== null) {
        console.log(`   Estimated Cost: $${task.estimatedCost.toFixed(4)}`);
      }
      if (task.stoppedReason) {
        console.log(`   Reason: ${task.stoppedReason}`);
      }
      console.log();
    });

    if (showLogsPrompt) {
      const { selectedTaskIndex } = await inquirer.prompt([
        {
          type: "list",
          name: "selectedTaskIndex",
          message: "Select a task to view logs:",
          choices: [
            ...tasks.map((task, index) => ({
              name: `${formatJobStatus(task.status)} ${task.taskArn
                .split("/")
                .pop()}`,
              value: index,
            })),
            { name: "← Back", value: "back" },
          ],
          pageSize: 10,
        },
      ]);

      if (selectedTaskIndex === "back") {
        return;
      }

      const selectedTask = tasks[selectedTaskIndex];
      const parts = workflowRunId.split("#");
      const [, workflowNameHash, commitHashFromId] = parts;
      const jobNameHash = jobRunId.split("#")[1];
      const runId = jobRunId.split("#")[3];
      const taskId = selectedTask.taskArn.split("/").pop();
      const logStream = `${commitHashFromId}/${workflowNameHash}/${jobNameHash}/${runId}/${jobNameHash}/${taskId}`;
      await showLogs(apiUrl, logStream);
    }
  } catch (error) {
    console.error("❌ Error:", error.message);
  }
}

async function showLogs(apiUrl, logStream) {
  try {
    console.log(`\n📋 Fetching logs for: ${logStream}\n`);

    const url = `${apiUrl}/logs?logStream=${encodeURIComponent(logStream)}`;
    const response = await makeRequest(url);

    if (response.statusCode !== 200) {
      console.error("❌ Error fetching logs:", response.data);
      return;
    }

    const { logs } = response.data;

    if (!logs.events || logs.events.length === 0) {
      console.log("No log events found.");
      console.log(`Log stream: ${logStream}`);
      console.log(`Log group: ${logs.logGroup || "/hyperp"}`);
      return;
    }

    console.log("=".repeat(80));
    console.log("📋 Log Output");
    console.log("=".repeat(80) + "\n");

    logs.events.forEach((event) => {
      const timestamp = event.timestamp
        ? new Date(event.timestamp).toISOString()
        : "";
      console.log(`[${timestamp}] ${event.message || ""}`);
    });

    console.log("\n" + "=".repeat(80) + "\n");
  } catch (error) {
    console.error("❌ Error:", error.message);
  }
}

module.exports = { listRuns };

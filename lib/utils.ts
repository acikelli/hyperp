import * as crypto from 'crypto';

export class Utils {
  /**
   * Generate a hash from a string
   */
  static generateHash(input: string): string {
    return crypto.createHash('sha256').update(input).digest('hex').substring(0, 16);
  }

  /**
   * Extract branch name from ref (e.g., refs/heads/main -> main)
   */
  static extractBranchName(ref: string): string {
    return ref.replace('refs/heads/', '');
  }

  /**
   * Parse image-build task family name to extract metadata
   * Format: image-build-<COMMIT_HASH>-<WORKFLOW_NAME_HASH>-<JOB_NAME_HASH>-<CONTAINER_ARRAY_INDEX>
   */
  static parseImageBuildFamily(family: string): {
    commitHash: string;
    workflowNameHash: string;
    jobNameHash: string;
    containerIndex: number;
  } | null {
    const match = family.match(/^image-build-([^-]+)-([^-]+)-([^-]+)-(\d+)$/);
    if (!match) {
      return null;
    }
    return {
      commitHash: match[1],
      workflowNameHash: match[2],
      jobNameHash: match[3],
      containerIndex: parseInt(match[4], 10),
    };
  }

  /**
   * Parse job-run task family name to extract metadata
   * Format: jobRun-<COMMIT_HASH>-<WORKFLOW_NAME_HASH>-<JOB_NAME_HASH>-<CONTAINER_ARRAY_INDEX>
   */
  static parseJobRunFamily(family: string): {
    commitHash: string;
    workflowNameHash: string;
    jobNameHash: string;
    containerIndex: number;
  } | null {
    const match = family.match(/^jobRun-([^-]+)-([^-]+)-([^-]+)-(\d+)$/);
    if (!match) {
      return null;
    }
    return {
      commitHash: match[1],
      workflowNameHash: match[2],
      jobNameHash: match[3],
      containerIndex: parseInt(match[4], 10),
    };
  }

  /**
   * Check if any files in the list match the given paths
   */
  static hasMatchingFiles(files: string[], paths: string[]): boolean {
    return files.some(file => paths.some(path => file.includes(path)));
  }

  /**
   * Get current timestamp in ISO format
   */
  static getCurrentTimestamp(): string {
    return new Date().toISOString();
  }

  /**
   * Replace placeholders in a string with actual values
   */
  static replacePlaceholders(
    template: string,
    replacements: Record<string, string>
  ): string {
    let result = template;
    for (const [key, value] of Object.entries(replacements)) {
      result = result.replace(new RegExp(`<${key}>`, 'g'), value);
    }
    return result;
  }

  /**
   * Extract Dockerfile paths from task definition
   */
  static extractDockerfilePaths(taskDef: any): string[] {
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

  /**
   * Build image tag for image build tasks
   */
  static buildImageTag(
    commitHash: string,
    workflowNameHash: string,
    jobNameHash: string,
    containerIndex: number
  ): string {
    return `${commitHash}-${workflowNameHash}-${jobNameHash}-${containerIndex}`;
  }

  /**
   * Check if a branch matches any of the workflow branches
   */
  static branchMatches(branch: string, workflowBranches: string[]): boolean {
    return workflowBranches.some(wb => {
      // Support wildcards
      if (wb.includes('*')) {
        const regex = new RegExp('^' + wb.replace(/\*/g, '.*') + '$');
        return regex.test(branch);
      }
      return wb === branch;
    });
  }

  /**
   * Extract owner and repo from full_name
   */
  static parseRepoFullName(fullName: string): { owner: string; repo: string } {
    const [owner, repo] = fullName.split('/');
    return { owner, repo };
  }

  /**
   * Create workflow run ID
   */
  static createWorkflowRunId(
    githubRepositoryId: string,
    workflowNameHash: string,
    commitHash: string
  ): string {
    return `${githubRepositoryId}#${workflowNameHash}#${commitHash}`;
  }

  /**
   * Create job run ID
   */
  static createJobRunId(jobNameHash: string, commitHash: string): string {
    return `${jobNameHash}#${commitHash}`;
  }
}


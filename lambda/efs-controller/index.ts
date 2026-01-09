import * as fs from "fs";
import * as path from "path";

/**
 * EFS Controller Lambda
 * Purpose: Create directories on EFS for job outputs
 * This lambda is mounted to EFS and creates directories as needed
 */

interface EfsControllerEvent {
  action: "createDirectory";
  path: string;
}

export const handler = async (event: EfsControllerEvent): Promise<any> => {
  console.log(
    "EFS Controller invoked with event:",
    JSON.stringify(event, null, 2)
  );

  try {
    if (event.action === "createDirectory") {
      // The access point mounts at /hyperp-artifacts, so /mnt/efs maps to that
      // event.path should be like "commit/runId/workflow/job" (without hyperp-artifacts prefix)
      const dirPath = path.join("/mnt/efs", event.path);

      console.log(`Creating directory: ${dirPath}`);

      // Create directory recursively with permissive mode
      // The access point ensures we have write access to /mnt/efs (which maps to /hyperp-artifacts)
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true, mode: 0o777 });
        console.log(`Directory created successfully: ${dirPath}`);
      } else {
        console.log(`Directory already exists: ${dirPath}`);
      }

      return {
        statusCode: 200,
        body: JSON.stringify({
          message: "Directory created successfully",
          path: event.path,
        }),
      };
    } else {
      throw new Error(`Unknown action: ${event.action}`);
    }
  } catch (error) {
    console.error("Error in EFS Controller:", error);
    throw error;
  }
};

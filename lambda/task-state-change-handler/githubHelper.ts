import * as jwt from "jsonwebtoken";
import axios from "axios";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

export default class GithubHelper {
  static async streamToString(stream: any): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("error", reject);
      stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
  }

  static getRepositoryContent = async (
    token: string,
    owner: string,
    repo: string,
    path: string,
    ref: string
  ): Promise<any> => {
    try {
      const response = await axios.get(
        `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
        {
          headers: {
            Authorization: `token ${token}`,
            Accept: "application/vnd.github.v3+json",
          },
          params: {
            ref: ref,
          },
        }
      );

      return response.data;
    } catch (error) {
      console.error("Error fetching repository content:", error);
      return null;
    }
  };

  static generateJWT = async (): Promise<any> => {
    const appId = process.env.GITHUB_APP_ID;

    const s3Client = new S3Client({ region: "us-east-1" });
    const command = new GetObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: "githubappkey.pem",
    });

    // @ts-ignore
    const response = await s3Client.send(command);
    const privateKeyStream = response.Body;

    if (!privateKeyStream) {
      throw new Error("Failed to retrieve private key.");
    }

    // Convert the stream to a string
    const privateKey = await this.streamToString(privateKeyStream as any);
    // Current time in seconds since epoch
    const now = Math.floor(Date.now() / 1000);

    const payload = {
      iat: now,
      exp: now + 10 * 60, // 10 mins
      iss: appId,
    };

    const token = jwt.sign(payload, privateKey.replace(/\\n/g, "\n"), {
      algorithm: "RS256",
    });

    return token;
  };

  static async getInstallation(installationId: string): Promise<any> {
    try {
      const token = await this.generateJWT();
      const res = await axios.get(
        `https://api.github.com/app/installations/${installationId}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github.v3+json",
          },
        }
      );
      return res;
    } catch (e) {
      console.log("Error on GH API call:  ", e);
      throw e;
    }
  }

  static async getInstallationRepositories(token: string): Promise<any> {
    try {
      const { data } = await axios.get(
        `https://api.github.com/installation/repositories`,
        {
          headers: {
            Authorization: `token ${token}`,
          },
          params: {
            //visibility: "private",
          },
        }
      );
      return data;
    } catch (e) {
      console.log("Error on GH API call:  ", e);
      throw e;
    }
  }

  static async createInstallationAccessToken(
    installationId: string
  ): Promise<any> {
    try {
      const token = await this.generateJWT();

      const { data } = await axios.post(
        `https://api.github.com/app/installations/${installationId}/access_tokens`,
        {},
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github.v3+json",
          },
        }
      );
      return data;
    } catch (e) {
      console.log("Error on GH API call: ", e);
      throw e;
    }
  }
}

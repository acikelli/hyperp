# Setup steps:

## Prerequisites

Before deploying hyperp, ensure you have:

1. **AWS Account** with appropriate permissions
2. **AWS CLI** configured with credentials
3. **Node.js** (v18 or later) and npm installed
4. **Docker** Docker must be running in order to build and deploy lambda images
5. **GitHub App** created with the following:
   - Webhook URL (will be configured after deployment)
   - Repository permissions: Contents (Read), Metadata (Read)
   - Subscribe to events: Push
   - Private key generated and downloaded

## Creating the GitHub app.

- Create a GitHub App from [here](https://github.com/settings/apps/new). You can give any name to your app.
![Alt text](./images/create-gh-app.png)

In the webhook section, enter a temporary URL and a secret value. We’ll come back and update the webhook URL after deployment, and provide the entered secret value to our CLI tool.
![Alt text](./images/gh-webhook-config.png)

Set the `Contents` option to readonly in the Repository Permissions section.
![Alt text](./images/content-selection.png)

Check push in the subscribe to events section.
![Alt text](./images/subscribe-events.png)

- Once the app is created, generate a private key and save it for the next steps. We'll upload this private key to S3 bucket that created after the deployment.
![Alt text](./images/generate-private-key.png)

- Install the created app in your own GitHub account.
![Alt text](./images/install-gh-app.png)


## Install and deploy hyperp

```
npm i -g hyperp
```

```
hyperp deploy --github-app-id <your app id > --github-app-webhook-secret <your secret value>
```

![Alt text](./images/deployment-outputs.png)

- Once the deployment is done, the CLI tool outputs the GitHub webhook handler URL. Copy the URL and replace the temporary webhook URL you entered while creating the GitHub app with the actual webhook function URL created.

- Upload your GitHub App's private key to the created bucket with the instructed S3 cp command .

`aws s3 cp githubappkey.pem s3://<created bucket name>/githubappkey.pem`

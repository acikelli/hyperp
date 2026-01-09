#!/usr/bin/env python3
"""
Usage Calculator - Calculates estimated costs and storage usage for workflow runs
"""

import os
import json
import boto3
from botocore.exceptions import ClientError
from decimal import Decimal
import subprocess
from datetime import datetime

# Environment variables
DYNAMODB_TABLE_NAME = os.environ.get("DYNAMODB_TABLE_NAME")
AWS_REGION = os.environ.get("AWS_REGION", "us-east-1")
WORKFLOW_RUN_ID = os.environ.get("WORKFLOW_RUN_ID")  # Format: workflowRun#{repositoryId}#{workflowNameHash}#{commitHash}

# Initialize AWS clients
dynamodb_client = boto3.client("dynamodb", region_name=AWS_REGION)
dynamodb_resource = boto3.resource("dynamodb", region_name=AWS_REGION)
table = dynamodb_resource.Table(DYNAMODB_TABLE_NAME)


def get_directory_size_kb(directory_path):
    """Calculate directory size in KB using du command"""
    try:
        result = subprocess.run(
            ["du", "-sk", directory_path],
            capture_output=True,
            text=True,
            check=True,
        )
        size_kb = int(result.stdout.split()[0])
        return size_kb
    except (subprocess.CalledProcessError, ValueError, IndexError) as e:
        print(f"Error calculating directory size for {directory_path}: {e}")
        return 0


def get_tasks_for_job_run(job_run_sk):
    """Query all tasks for a job run using GSI1 (tasks' GSI1-PK = job run's PK)"""
    try:
        response = dynamodb_client.query(
            TableName=DYNAMODB_TABLE_NAME,
            IndexName="GSI1",
            KeyConditionExpression="#gsi1pk = :gsi1pk",
            ExpressionAttributeNames={"#gsi1pk": "GSI1-PK"},
            ExpressionAttributeValues={":gsi1pk": {"S": job_run_sk}},
        )
        tasks = []
        for item in response.get("Items", []):
            # Convert DynamoDB item to Python dict
            task = {}
            for key, value in item.items():
                if "S" in value:
                    task[key] = value["S"]
                elif "N" in value:
                    task[key] = float(value["N"]) if "." in value["N"] else int(value["N"])
                elif "BOOL" in value:
                    task[key] = value["BOOL"]
            if task.get("entityType") == "task":
                tasks.append(task)
        return tasks
    except ClientError as e:
        print(f"Error querying tasks for job run {job_run_pk}: {e}")
        return []


def get_job_runs_for_workflow_run(workflow_run_id):
    """Query all job runs for a workflow run using GSI1"""
    try:
        # Parse workflow run ID to get components
        parts = workflow_run_id.split("#")
        if len(parts) != 5:
            print(f"Invalid workflow run ID format: {workflow_run_id}")
            return []

        repository_id = parts[1]
        workflow_name_hash = parts[2]
        commit_hash = parts[3]
        run_id = parts[4]

        # Query job runs using GSI1
        gsi1_pk = f"workflowRun#{workflow_name_hash}#{commit_hash}#{run_id}"
        response = dynamodb_client.query(
            TableName=DYNAMODB_TABLE_NAME,
            IndexName="GSI1",
            KeyConditionExpression="#gsi1pk = :gsi1pk",
            ExpressionAttributeNames={"#gsi1pk": "GSI1-PK"},
            ExpressionAttributeValues={":gsi1pk": {"S": gsi1_pk}},
        )
        job_runs = []
        for item in response.get("Items", []):
            # Convert DynamoDB item to Python dict
            job_run = {}
            for key, value in item.items():
                if "S" in value:
                    job_run[key] = value["S"]
                elif "N" in value:
                    job_run[key] = float(value["N"]) if "." in value["N"] else int(value["N"])
                elif "BOOL" in value:
                    job_run[key] = value["BOOL"]
            if job_run.get("entityType") == "jobRun":
                job_runs.append(job_run)
        return job_runs
    except ClientError as e:
        print(f"Error querying job runs for workflow run {workflow_run_id}: {e}")
        return []


def update_job_run_cost_and_storage(job_run_pk, job_run_sk, estimated_cost, storage_usage_kb):
    """Update job run with cumulative estimated cost and storage usage"""
    try:
        update_expression = "SET updatedAt = :updatedAt"
        expression_attribute_values = {
            ":updatedAt": datetime.utcnow().isoformat() + "Z",
        }

        if estimated_cost is not None:
            update_expression += ", estimatedCost = :estimatedCost"
            expression_attribute_values[":estimatedCost"] = Decimal(str(estimated_cost))

        if storage_usage_kb is not None:
            update_expression += ", storageUsage = :storageUsage"
            expression_attribute_values[":storageUsage"] = Decimal(str(storage_usage_kb))

        table.update_item(
            Key={"PK": job_run_pk, "SK": job_run_sk},
            UpdateExpression=update_expression,
            ExpressionAttributeValues=expression_attribute_values,
        )
        print(f"Updated job run {job_run_pk} with cost: ${estimated_cost:.4f}, storage: {storage_usage_kb} KB")
    except ClientError as e:
        print(f"Error updating job run {job_run_pk}: {e}")


def update_workflow_run_cost_and_storage(workflow_run_pk, workflow_run_sk, total_estimated_cost, total_storage_usage_kb):
    """Update workflow run with total estimated cost and storage usage"""
    try:
        update_expression = "SET updatedAt = :updatedAt"
        expression_attribute_values = {
            ":updatedAt": datetime.utcnow().isoformat() + "Z",
        }

        if total_estimated_cost is not None:
            update_expression += ", estimatedCost = :estimatedCost"
            expression_attribute_values[":estimatedCost"] = Decimal(str(total_estimated_cost))

        if total_storage_usage_kb is not None:
            update_expression += ", storageUsage = :storageUsage"
            expression_attribute_values[":storageUsage"] = Decimal(str(total_storage_usage_kb))

        table.update_item(
            Key={"PK": workflow_run_pk, "SK": workflow_run_sk},
            UpdateExpression=update_expression,
            ExpressionAttributeValues=expression_attribute_values,
        )
        print(f"Updated workflow run {workflow_run_pk} with total cost: ${total_estimated_cost:.4f}, total storage: {total_storage_usage_kb} KB")
    except ClientError as e:
        print(f"Error updating workflow run {workflow_run_pk}: {e}")


def main():
    if not WORKFLOW_RUN_ID:
        print("Error: WORKFLOW_RUN_ID environment variable is required")
        exit(1)

    if not DYNAMODB_TABLE_NAME:
        print("Error: DYNAMODB_TABLE_NAME environment variable is required")
        exit(1)

    print(f"Starting usage calculation for workflow run: {WORKFLOW_RUN_ID}")

    # Parse workflow run ID
    parts = WORKFLOW_RUN_ID.split("#")
    if len(parts) != 5:
        print(f"Invalid workflow run ID format: {WORKFLOW_RUN_ID}")
        exit(1)

    repository_id = parts[1]
    workflow_name_hash = parts[2]
    commit_hash = parts[3]
    run_id = parts[4]

    workflow_run_pk = WORKFLOW_RUN_ID[:WORKFLOW_RUN_ID.rfind('#')]
    workflow_run_sk = WORKFLOW_RUN_ID

    # Get workflow run to access imageBuildJobs
    workflow_run_response = dynamodb_client.get_item(
        TableName=DYNAMODB_TABLE_NAME,
        Key={"PK": {"S": workflow_run_pk}, "SK": {"S": workflow_run_sk}},
    )

    workflow_run = {}
    if "Item" in workflow_run_response:
        for key, value in workflow_run_response["Item"].items():
            if "S" in value:
                workflow_run[key] = value["S"]
            elif "N" in value:
                workflow_run[key] = (
                    float(value["N"]) if "." in value["N"] else int(value["N"])
                )
            elif "BOOL" in value:
                workflow_run[key] = value["BOOL"]
            elif "M" in value:
                # Handle map type (for imageBuildJobs)
                workflow_run[key] = {}
                for sub_key, sub_value in value["M"].items():
                    if "M" in sub_value:
                        # Nested map for ImageBuildJobStatus
                        nested_dict = {}
                        for nested_key, nested_val in sub_value["M"].items():
                            if "S" in nested_val:
                                nested_dict[nested_key] = nested_val["S"]
                            elif "N" in nested_val:
                                nested_dict[nested_key] = (
                                    float(nested_val["N"])
                                    if "." in nested_val["N"]
                                    else int(nested_val["N"])
                                )
                            elif "BOOL" in nested_val:
                                nested_dict[nested_key] = nested_val["BOOL"]
                        workflow_run[key][sub_key] = nested_dict

    # Calculate image build jobs total cost
    image_build_jobs_total_cost = 0.0
    image_build_jobs = workflow_run.get("imageBuildJobs", {})
    if isinstance(image_build_jobs, dict):
        for job_name_hash, build_job in image_build_jobs.items():
            if isinstance(build_job, dict):
                build_cost = build_job.get("estimatedCost")
                if build_cost is not None:
                    image_build_jobs_total_cost += float(build_cost)
    print(
        f"Image build jobs total cost: ${image_build_jobs_total_cost:.4f}"
    )

    # Get all job runs for this workflow run
    job_runs = get_job_runs_for_workflow_run(WORKFLOW_RUN_ID)
    print(f"Found {len(job_runs)} job runs")

    total_estimated_cost = image_build_jobs_total_cost  # Start with image build costs
    total_storage_usage_kb = 0

    # Process each job run
    for job_run in job_runs:
        job_run_pk = job_run.get("PK")
        job_run_sk = job_run.get("SK")
        job_run_gsi1_pk = job_run.get("GSI1-PK")
        efs_output_location = job_run.get("efsOutputLocation")

        # Get all tasks for this job run (tasks' GSI1-PK = job run's SK)
        tasks = get_tasks_for_job_run(job_run_sk)
        print(f"Job run {job_run.get('jobName', 'unknown')}: Found {len(tasks)} tasks")
        
        # Sum estimated costs from all tasks
        job_run_estimated_cost = 0.0
        for task in tasks:
            task_cost = task.get("estimatedCost")
            if task_cost is not None:
                job_run_estimated_cost += float(task_cost)

        # Calculate storage usage
        job_run_storage_usage_kb = 0
        if efs_output_location:
            # EFS volumes are mounted at /output/{jobNameHash} based on the task definition
            # Parse entityId to get jobNameHash
            entity_id = job_run.get("entityId", "")
            entity_id_parts = entity_id.split("#")
            job_name_hash = entity_id_parts[1] 
            efs_path = f"/input/{job_name_hash}"
            if os.path.exists(efs_path):
                job_run_storage_usage_kb = get_directory_size_kb(efs_path)
                print(f"Job run {job_run.get('jobName', 'unknown')}: Storage usage: {job_run_storage_usage_kb} KB")
            else:
                print(f"Warning: EFS path does not exist: {efs_path}")

        # Update job run with cumulative cost and storage
        update_job_run_cost_and_storage(
            job_run_pk, job_run_sk, job_run_estimated_cost, job_run_storage_usage_kb
        )

        # Accumulate totals
        total_estimated_cost += job_run_estimated_cost
        total_storage_usage_kb += job_run_storage_usage_kb

    # Update workflow run with total cost and storage
    update_workflow_run_cost_and_storage(
        workflow_run_pk, workflow_run_sk, total_estimated_cost, total_storage_usage_kb
    )

    print(f"Usage calculation completed:")
    print(f"  Total estimated cost: ${total_estimated_cost:.4f}")
    print(f"  Total storage usage: {total_storage_usage_kb} KB")


if __name__ == "__main__":
    main()


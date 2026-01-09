#!/usr/bin/env python3
"""
Downloadable Artifacts Creator
Reads files from /input folder, zips them, and uploads to S3.
"""

import os
import zipfile
import boto3
import sys
from pathlib import Path

def zip_directory(input_dir: str, output_zip: str):
    """Create a zip file from a directory."""
    with zipfile.ZipFile(output_zip, 'w', zipfile.ZIP_DEFLATED) as zipf:
        for root, dirs, files in os.walk(input_dir):
            for file in files:
                file_path = os.path.join(root, file)
                # Get relative path from input_dir
                arcname = os.path.relpath(file_path, input_dir)
                zipf.write(file_path, arcname)
                print(f"Added to zip: {arcname}")

def upload_to_s3(local_file: str, s3_location: str):
    """Upload a file to S3."""
    s3_client = boto3.client('s3')
    
    # Parse S3 location: s3://bucket-name/path/to/file.zip
    if s3_location.startswith('s3://'):
        s3_location = s3_location[5:]
    
    parts = s3_location.split('/', 1)
    if len(parts) != 2:
        raise ValueError(f"Invalid S3 location format: {s3_location}")
    
    bucket_name = parts[0]
    s3_key = parts[1]
    
    print(f"Uploading {local_file} to s3://{bucket_name}/{s3_key}")
    s3_client.upload_file(local_file, bucket_name, s3_key)
    print(f"Successfully uploaded to s3://{bucket_name}/{s3_key}")

def main():
    """Main function."""
    # Get environment variables
    input_dir = os.environ.get('INPUT_DIR', '/input')
    s3_output_location = os.environ.get('S3_OUTPUT_LOCATION')
    
    if not s3_output_location:
        print("ERROR: S3_OUTPUT_LOCATION environment variable is required")
        sys.exit(1)
    
    # Check if input directory exists
    if not os.path.exists(input_dir):
        print(f"ERROR: Input directory does not exist: {input_dir}")
        sys.exit(1)
    
    # Check if input directory has any files
    files = list(Path(input_dir).rglob('*'))
    if not files or all(f.is_dir() for f in files):
        print(f"WARNING: Input directory has no files: {input_dir}")
        # Still create an empty zip file
    
    # Create zip file in /tmp
    zip_filename = '/tmp/artifacts.zip'
    
    try:
        print(f"Creating zip file from {input_dir}...")
        zip_directory(input_dir, zip_filename)
        print(f"Zip file created: {zip_filename}")
        
        # Upload to S3
        print(f"Uploading to S3: {s3_output_location}")
        upload_to_s3(zip_filename, s3_output_location)
        
        print("SUCCESS: Artifacts uploaded successfully")
        sys.exit(0)
    except Exception as e:
        print(f"ERROR: {str(e)}")
        sys.exit(1)

if __name__ == '__main__':
    main()


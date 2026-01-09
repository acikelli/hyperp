FROM python:3.11-slim

# Install boto3 for S3 operations
RUN pip install --no-cache-dir boto3

# Set working directory
WORKDIR /app

# Copy the Python script
COPY downloadable-artifacts-creator.py /app/downloadable-artifacts-creator.py

# Make the script executable
RUN chmod +x /app/downloadable-artifacts-creator.py

# Set the script as entrypoint
ENTRYPOINT ["python3", "/app/downloadable-artifacts-creator.py"]


FROM python:3.11-slim

RUN pip install --no-cache-dir boto3

# Set working directory
WORKDIR /app

# Copy the Python script
COPY usage-calculator.py /app/usage-calculator.py

# Make the script executable
RUN chmod +x /app/usage-calculator.py

# Set the script as entrypoint
ENTRYPOINT ["python3", "/app/usage-calculator.py"]


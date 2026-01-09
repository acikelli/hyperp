import random
import os

output_path = '/output/result.txt'
random_limit = int(os.environ.get("LIMIT", "100"))
task_index = int(os.environ.get("TASK_INDEX", "1"))
task_total_size = int(os.environ.get("TASK_TOTAL_SIZE", "1"))
print(f"Task size: {task_total_size}, task index: {task_index}")


def read_and_divide(file_path):
    # Read the result.txt file
    with open(file_path, 'r') as f:
        content = f.read().strip()
        try:
            # Try to convert to int first
            number = int(content)
        except ValueError:
            # If not int, try float
            number = float(content)
    
    # Generate a random divider between 1 and 10
    divider = random.randint(1, random_limit)
    
    # Divide the numbers
    result = number / divider
    
    print(f"Number from file: {number}")
    print(f"Random divider: {divider}")
    with open(output_path, 'w') as f:
        f.write(str(result))
    
    print(f"Division result: {result} written to {output_path}")
    return result

def main():
    read_and_divide("/input/Generate x/result.txt")
    
if __name__ == "__main__":
    main()
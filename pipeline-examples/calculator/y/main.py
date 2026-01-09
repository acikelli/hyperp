import random
import os

output_path = '/output/result.txt'
random_limit = int(os.environ.get("LIMIT", "10"))

def read_and_multiply(file_path):
    # read the result.txt file
    with open(file_path, 'r') as f:
        content = f.read().strip()
        try:
            # Try to convert to int first
            number = int(content)
        except ValueError:
            # If not int, try float
            number = float(content)
    
    # Generate a random multiplier between 1 and 10
    multiplier = random.randint(1, random_limit)
    
    # Multiply the numbers
    result = number * multiplier
    
    print(f"Number from file: {number}")
    print(f"Random multiplier: {multiplier}")
    with open(output_path, 'w') as f:
        f.write(str(result))
    
    print(f"Multiplication result: {result} written to {output_path}")
    
    return result

def main():
    read_and_multiply("/input/Generate x/result.txt")
if __name__ == "__main__":
    main()
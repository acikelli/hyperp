import random
import os

output_path = '/output/result.txt'
random_limit = int(os.environ.get("LIMIT", "10"))

def create_random_number(file_path):
    # Create directories if they don't exist
    os.makedirs(os.path.dirname(file_path), exist_ok=True)
    
    # Generate a random number between 1 and 10
    number = random.randint(1, random_limit)
    
    # Write the number to the file
    with open(file_path, 'w') as f:
        f.write(str(number))
    
    print(f"Random number {number} written to {file_path}")


def main():
    create_random_number(output_path)
    
if __name__ == "__main__":
    main()
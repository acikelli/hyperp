import os

output_path = '/output/result.txt'

def sum_all_results(base_path):
    total_sum = 0
    files_found = 0

    for root, dirs, files in os.walk(base_path):
        for file in files:
            if file == 'result.txt':
                file_path = os.path.join(root, file)
                try:
                    with open(file_path, 'r') as f:
                        content = f.read().strip()
                        try:
                            # Try to convert to int first
                            value = int(content)
                        except ValueError:
                            try:
                                # If not int, try float
                                value = float(content)
                            except ValueError:
                                print(f"Warning: {file_path} contains non-numeric value: {content}")
                                continue
                        
                        total_sum += value
                        files_found += 1
                        print(f"Found {file_path}: value = {value}")
                except Exception as e:
                    print(f"Error reading {file_path}: {str(e)}")

    print(f"\nTotal files found: {files_found}")
    
    # Write the sum to the file
    with open(output_path, 'w') as f:
        f.write(str(total_sum))
        
    print(f"Sum of all values: {total_sum} written to {output_path}")
    return total_sum

def main():
    sum_all_results("/input")
    
if __name__ == "__main__":
    main()
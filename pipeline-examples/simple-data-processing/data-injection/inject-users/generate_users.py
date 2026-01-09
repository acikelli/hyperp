import json
import random
import os
from datetime import datetime, timedelta

# Create output directory if it doesn't exist
os.makedirs('/output', exist_ok=True)

# Mock data for users
first_names = ['John', 'Jane', 'Michael', 'Emily', 'David', 'Sarah', 'Robert', 'Lisa', 'James', 'Emma']
last_names = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez', 'Martinez']
domains = ['gmail.com', 'yahoo.com', 'outlook.com', 'company.com', 'email.com']
cities = ['New York', 'Los Angeles', 'Chicago', 'Houston', 'Phoenix', 'Philadelphia', 'San Antonio', 'San Diego']

def generate_user(user_id):
    first = random.choice(first_names)
    last = random.choice(last_names)
    
    # Generate random registration date within the last 2 years
    days_ago = random.randint(0, 730)
    reg_date = datetime.now() - timedelta(days=days_ago)
    
    return {
        'user_id': user_id,
        'first_name': first,
        'last_name': last,
        'email': f"{first.lower()}.{last.lower()}{random.randint(1, 999)}@{random.choice(domains)}",
        'age': random.randint(18, 75),
        'city': random.choice(cities),
        'registration_date': reg_date.strftime('%Y-%m-%d'),
        'is_active': random.choice([True, True, True, False]),  # 75% active
        'account_balance': round(random.uniform(0, 10000), 2)
    }

# Generate 100 users
users = [generate_user(i+1) for i in range(100)]

# Write to JSON file
with open('/output/users.json', 'w') as f:
    json.dump(users, f, indent=2)

print(f"✓ Generated {len(users)} users and saved to /output/users.json")

# Also create a CSV version
import csv

with open('/output/users.csv', 'w', newline='') as f:
    if users:
        writer = csv.DictWriter(f, fieldnames=users[0].keys())
        writer.writeheader()
        writer.writerows(users)

print(f"✓ Also saved CSV version to /output/users.csv")
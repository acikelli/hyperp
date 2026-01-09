import json
import random
import os
from datetime import datetime, timedelta

# Create output directory if it doesn't exist
os.makedirs('/output', exist_ok=True)

# Mock data for sales transactions
products = [
    {'name': 'Laptop', 'category': 'Electronics', 'base_price': 999.99},
    {'name': 'Smartphone', 'category': 'Electronics', 'base_price': 699.99},
    {'name': 'Headphones', 'category': 'Electronics', 'base_price': 149.99},
    {'name': 'Desk Chair', 'category': 'Furniture', 'base_price': 299.99},
    {'name': 'Standing Desk', 'category': 'Furniture', 'base_price': 499.99},
    {'name': 'Coffee Maker', 'category': 'Appliances', 'base_price': 89.99},
    {'name': 'Blender', 'category': 'Appliances', 'base_price': 79.99},
    {'name': 'Monitor', 'category': 'Electronics', 'base_price': 349.99},
    {'name': 'Keyboard', 'category': 'Electronics', 'base_price': 129.99},
    {'name': 'Mouse', 'category': 'Electronics', 'base_price': 49.99}
]

payment_methods = ['Credit Card', 'Debit Card', 'PayPal', 'Bank Transfer']
statuses = ['Completed', 'Completed', 'Completed', 'Pending', 'Cancelled']

def generate_sale(sale_id):
    product = random.choice(products)
    quantity = random.randint(1, 5)
    
    # Add some price variation
    unit_price = round(product['base_price'] * random.uniform(0.9, 1.1), 2)
    total = round(unit_price * quantity, 2)
    
    # Generate random sale date within the last year
    days_ago = random.randint(0, 365)
    sale_date = datetime.now() - timedelta(days=days_ago)
    
    return {
        'sale_id': f'ORD-{sale_id:06d}',
        'transaction_date': sale_date.strftime('%Y-%m-%d %H:%M:%S'),
        'product_name': product['name'],
        'category': product['category'],
        'quantity': quantity,
        'unit_price': unit_price,
        'total_amount': total,
        'payment_method': random.choice(payment_methods),
        'status': random.choice(statuses),
        'customer_id': random.randint(1, 100)
    }

# Generate 500 sales transactions
sales = [generate_sale(i+1) for i in range(500)]

# Sort by date
sales.sort(key=lambda x: x['transaction_date'])

# Write to JSON file
with open('/output/sales.json', 'w') as f:
    json.dump(sales, f, indent=2)

print(f"✓ Generated {len(sales)} sales transactions and saved to /output/sales.json")

# Calculate some statistics
total_revenue = sum(s['total_amount'] for s in sales)
completed_sales = [s for s in sales if s['status'] == 'Completed']
completed_revenue = sum(s['total_amount'] for s in completed_sales)

stats = {
    'total_transactions': len(sales),
    'total_revenue': round(total_revenue, 2),
    'completed_transactions': len(completed_sales),
    'completed_revenue': round(completed_revenue, 2),
    'average_order_value': round(total_revenue / len(sales), 2)
}

with open('/output/sales_stats.json', 'w') as f:
    json.dump(stats, f, indent=2)

print(f"✓ Generated sales statistics and saved to /output/sales_stats.json")
print(f"\nStatistics:")
print(f"  Total Transactions: {stats['total_transactions']}")
print(f"  Total Revenue: ${stats['total_revenue']:,.2f}")
print(f"  Completed Revenue: ${stats['completed_revenue']:,.2f}")
import json
import os
from datetime import datetime
from collections import defaultdict

# Ensure output directory exists
os.makedirs('/output', exist_ok=True)

print("=" * 60)
print("PROCESSING MOCK DATA")
print("=" * 60)

# Load the data files
print("\n📂 Loading data files...")

try:
    with open('/input/inject-users/users.json', 'r') as f:
        users = json.load(f)
    print(f"✓ Loaded {len(users)} users")
except FileNotFoundError:
    print("✗ users.json not found!")
    users = []

try:
    with open('/input/inject-sales/sales.json', 'r') as f:
        sales = json.load(f)
    print(f"✓ Loaded {len(sales)} sales transactions")
except FileNotFoundError:
    print("✗ sales.json not found!")
    sales = []

if not users or not sales:
    print("\n⚠ Missing data files. Please run generate_users.py and generate_sales.py first.")
    exit(1)

print("\n🔄 Processing data...")

# 1. USER ANALYSIS
print("\n1️⃣  Analyzing users...")

active_users = [u for u in users if u['is_active']]
inactive_users = [u for u in users if not u['is_active']]

user_analysis = {
    'total_users': len(users),
    'active_users': len(active_users),
    'inactive_users': len(inactive_users),
    'average_age': round(sum(u['age'] for u in users) / len(users), 1),
    'total_balance': round(sum(u['account_balance'] for u in users), 2),
    'average_balance': round(sum(u['account_balance'] for u in users) / len(users), 2),
    'users_by_city': {}
}

# Count users by city
for user in users:
    city = user['city']
    user_analysis['users_by_city'][city] = user_analysis['users_by_city'].get(city, 0) + 1

# Sort cities by user count
user_analysis['users_by_city'] = dict(sorted(
    user_analysis['users_by_city'].items(), 
    key=lambda x: x[1], 
    reverse=True
))

with open('/output/user_analysis.json', 'w') as f:
    json.dump(user_analysis, f, indent=2)
print("✓ Created user_analysis.json")

# 2. SALES ANALYSIS
print("\n2️⃣  Analyzing sales...")

completed_sales = [s for s in sales if s['status'] == 'Completed']
pending_sales = [s for s in sales if s['status'] == 'Pending']
cancelled_sales = [s for s in sales if s['status'] == 'Cancelled']

sales_analysis = {
    'total_transactions': len(sales),
    'completed': len(completed_sales),
    'pending': len(pending_sales),
    'cancelled': len(cancelled_sales),
    'total_revenue': round(sum(s['total_amount'] for s in sales), 2),
    'completed_revenue': round(sum(s['total_amount'] for s in completed_sales), 2),
    'pending_revenue': round(sum(s['total_amount'] for s in pending_sales), 2),
    'cancelled_revenue': round(sum(s['total_amount'] for s in cancelled_sales), 2),
    'average_order_value': round(sum(s['total_amount'] for s in sales) / len(sales), 2),
    'sales_by_category': {},
    'sales_by_payment_method': {},
    'top_products': {}
}

# Analyze by category
for sale in sales:
    cat = sale['category']
    if cat not in sales_analysis['sales_by_category']:
        sales_analysis['sales_by_category'][cat] = {'count': 0, 'revenue': 0}
    sales_analysis['sales_by_category'][cat]['count'] += 1
    sales_analysis['sales_by_category'][cat]['revenue'] = round(
        sales_analysis['sales_by_category'][cat]['revenue'] + sale['total_amount'], 2
    )

# Analyze by payment method
for sale in sales:
    pm = sale['payment_method']
    if pm not in sales_analysis['sales_by_payment_method']:
        sales_analysis['sales_by_payment_method'][pm] = {'count': 0, 'revenue': 0}
    sales_analysis['sales_by_payment_method'][pm]['count'] += 1
    sales_analysis['sales_by_payment_method'][pm]['revenue'] = round(
        sales_analysis['sales_by_payment_method'][pm]['revenue'] + sale['total_amount'], 2
    )

# Top products
for sale in sales:
    prod = sale['product_name']
    if prod not in sales_analysis['top_products']:
        sales_analysis['top_products'][prod] = {'units_sold': 0, 'revenue': 0}
    sales_analysis['top_products'][prod]['units_sold'] += sale['quantity']
    sales_analysis['top_products'][prod]['revenue'] = round(
        sales_analysis['top_products'][prod]['revenue'] + sale['total_amount'], 2
    )

# Sort top products by revenue
sales_analysis['top_products'] = dict(sorted(
    sales_analysis['top_products'].items(),
    key=lambda x: x[1]['revenue'],
    reverse=True
))

with open('/output/sales_analysis.json', 'w') as f:
    json.dump(sales_analysis, f, indent=2)
print("✓ Created sales_analysis.json")

# 3. CUSTOMER PURCHASE BEHAVIOR
print("\n3️⃣  Analyzing customer behavior...")

customer_purchases = defaultdict(lambda: {
    'total_orders': 0,
    'total_spent': 0,
    'completed_orders': 0,
    'cancelled_orders': 0,
    'favorite_category': defaultdict(int)
})

for sale in sales:
    cid = sale['customer_id']
    customer_purchases[cid]['total_orders'] += 1
    customer_purchases[cid]['total_spent'] = round(
        customer_purchases[cid]['total_spent'] + sale['total_amount'], 2
    )
    
    if sale['status'] == 'Completed':
        customer_purchases[cid]['completed_orders'] += 1
    elif sale['status'] == 'Cancelled':
        customer_purchases[cid]['cancelled_orders'] += 1
    
    customer_purchases[cid]['favorite_category'][sale['category']] += 1

# Convert to list and enrich with user data
customer_behavior = []
for cid, data in customer_purchases.items():
    user = next((u for u in users if u['user_id'] == cid), None)
    
    # Find favorite category
    if data['favorite_category']:
        fav_cat = max(data['favorite_category'].items(), key=lambda x: x[1])
        favorite_category = fav_cat[0]
    else:
        favorite_category = None
    
    customer_behavior.append({
        'customer_id': cid,
        'customer_name': f"{user['first_name']} {user['last_name']}" if user else 'Unknown',
        'customer_email': user['email'] if user else 'Unknown',
        'total_orders': data['total_orders'],
        'completed_orders': data['completed_orders'],
        'cancelled_orders': data['cancelled_orders'],
        'total_spent': data['total_spent'],
        'average_order_value': round(data['total_spent'] / data['total_orders'], 2),
        'favorite_category': favorite_category,
        'is_active_user': user['is_active'] if user else False
    })

# Sort by total spent
customer_behavior.sort(key=lambda x: x['total_spent'], reverse=True)

# Identify top customers
top_customers = customer_behavior[:10]
vip_summary = {
    'top_10_customers': top_customers,
    'top_10_total_revenue': round(sum(c['total_spent'] for c in top_customers), 2),
    'top_10_percentage_of_revenue': round(
        (sum(c['total_spent'] for c in top_customers) / sales_analysis['total_revenue']) * 100, 1
    )
}

with open('/output/customer_behavior.json', 'w') as f:
    json.dump(customer_behavior, f, indent=2)
print("✓ Created customer_behavior.json")

with open('/output/vip_customers.json', 'w') as f:
    json.dump(vip_summary, f, indent=2)
print("✓ Created vip_customers.json")

# 4. EXECUTIVE SUMMARY REPORT
print("\n4️⃣  Creating executive summary...")

summary = {
    'report_generated': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
    'overview': {
        'total_users': len(users),
        'active_users': len(active_users),
        'total_sales': len(sales),
        'total_revenue': sales_analysis['total_revenue'],
        'completed_revenue': sales_analysis['completed_revenue']
    },
    'key_metrics': {
        'average_customer_value': round(sales_analysis['total_revenue'] / len(users), 2),
        'average_order_value': sales_analysis['average_order_value'],
        'completion_rate': round((len(completed_sales) / len(sales)) * 100, 1),
        'cancellation_rate': round((len(cancelled_sales) / len(sales)) * 100, 1)
    },
    'top_performing': {
        'city_with_most_users': max(user_analysis['users_by_city'].items(), key=lambda x: x[1])[0],
        'most_popular_category': max(
            sales_analysis['sales_by_category'].items(),
            key=lambda x: x[1]['count']
        )[0],
        'highest_revenue_category': max(
            sales_analysis['sales_by_category'].items(),
            key=lambda x: x[1]['revenue']
        )[0],
        'preferred_payment_method': max(
            sales_analysis['sales_by_payment_method'].items(),
            key=lambda x: x[1]['count']
        )[0]
    },
    'insights': [
        f"Top 10 customers generate {vip_summary['top_10_percentage_of_revenue']}% of total revenue",
        f"Average customer age is {user_analysis['average_age']} years",
        f"Active user retention rate is {round((len(active_users)/len(users))*100, 1)}%",
        f"{len(completed_sales)} transactions completed successfully"
    ]
}

with open('/output/executive_summary.json', 'w') as f:
    json.dump(summary, f, indent=2)
print("✓ Created executive_summary.json")

# Print summary to console
print("\n" + "=" * 60)
print("PROCESSING COMPLETE")
print("=" * 60)
print(f"\n📊 Executive Summary:")
print(f"   Total Users: {summary['overview']['total_users']}")
print(f"   Active Users: {summary['overview']['active_users']}")
print(f"   Total Sales: {summary['overview']['total_sales']}")
print(f"   Total Revenue: ${summary['overview']['total_revenue']:,.2f}")
print(f"   Avg Order Value: ${summary['key_metrics']['average_order_value']:,.2f}")
print(f"   Completion Rate: {summary['key_metrics']['completion_rate']}%")
print(f"\n💡 Key Insights:")
for insight in summary['insights']:
    print(f"   • {insight}")

print("\n📁 Generated files in /output/:")
print("   • user_analysis.json")
print("   • sales_analysis.json")
print("   • customer_behavior.json")
print("   • vip_customers.json")
print("   • executive_summary.json")
print("\n✨ Done!")
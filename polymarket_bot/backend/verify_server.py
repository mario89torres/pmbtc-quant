import urllib.request
import json
import sys

try:
    print("Testing connection to Polymarket Bot Server at http://127.0.0.1:8000...")
    
    # 1. Test Root
    req_root = urllib.request.Request("http://127.0.0.1:8000/")
    with urllib.request.urlopen(req_root) as response:
        html = response.read().decode('utf-8')
        print(f"Root endpoint: SUCCESS (HTML length: {len(html)})")

    # 2. Test Search endpoint
    req_search = urllib.request.Request("http://127.0.0.1:8000/api/search?query=btc")
    with urllib.request.urlopen(req_search) as response:
        data = json.loads(response.read().decode('utf-8'))
        print(f"Search endpoint: SUCCESS (Found {len(data)} active markets for 'btc')")
        if data:
            print(f"First market: {data[0]['title']}")
            print(f"Outcomes: {data[0]['outcomes']}")
            print(f"CLOB Token IDs count: {len(data[0]['clobTokenIds'])}")

    print("\nALL SYSTEM CHECKS PASSED. Server is active and responding correctly!")
    sys.exit(0)

except Exception as e:
    print(f"\nSYSTEM CHECK FAILED: {str(e)}")
    sys.exit(1)

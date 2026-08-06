import urllib.request
import json
import urllib.parse

def test_search():
    query = "btc"
    gamma_url = "https://gamma-api.polymarket.com/markets"
    
    # We will search with active=true and closed=false
    params = {
        "active": "true",
        "closed": "false",
        "limit": 50,
        "search": query
    }
    
    url = f"{gamma_url}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url)
    
    print(f"Querying Gamma API: {url}...")
    try:
        with urllib.request.urlopen(req) as response:
            markets = json.loads(response.read().decode('utf-8'))
            print(f"Total markets returned for 'btc': {len(markets)}")
            
            # Print matching slugs
            matches = []
            for m in markets:
                slug = m.get("slug", "")
                if "updown" in slug or "5m" in slug or "15m" in slug or "above" in slug:
                    matches.append(m)
                    
            print(f"Found {len(matches)} potential short-term price markets:")
            for m in matches[:10]:
                print(f"- Question: {m.get('question')}")
                print(f"  Slug: {m.get('slug')}")
                print(f"  Outcomes: {m.get('outcomes')}")
                print(f"  CLOB Token IDs: {m.get('clobTokenIds')}")
                print("-" * 40)
    except Exception as e:
        print("Error querying Gamma API:", e)

if __name__ == "__main__":
    test_search()

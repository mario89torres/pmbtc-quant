import os
import sys
import json
import asyncio
from datetime import datetime
from typing import List, Dict, Optional

# Asegura que polymarket_bot/ (el padre de este archivo) esté en sys.path,
# sin importar cómo se haya lanzado el proceso: `python backend/main.py`,
# `python -m backend.main` o `python -m uvicorn backend.main:app`.
# Sin esto, `from backend.bot import ...` y el `uvicorn.run("backend.main:app")`
# de más abajo fallan con "ModuleNotFoundError: No module named 'backend'"
# cuando se invoca por ruta de archivo en vez de como módulo.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Body
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import httpx
import uvicorn

from backend.bot import PolymarketBot

app = FastAPI(title="Polymarket Automated Trading Dashboard")

# Paths
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FRONTEND_DIR = os.path.join(BASE_DIR, "frontend")

# Serve Frontend static files if folder exists
if os.path.exists(FRONTEND_DIR):
    app.mount("/frontend", StaticFiles(directory=FRONTEND_DIR), name="frontend")

# Fallback to serve index.html at root
@app.get("/")
async def read_index():
    index_path = os.path.join(FRONTEND_DIR, "index.html")
    if os.path.exists(index_path):
        return FileResponse(index_path)
    return {"message": "Polymarket Trading Bot API Running. Frontend directory not found."}

@app.get("/styles.css")
async def get_styles():
    css_path = os.path.join(FRONTEND_DIR, "styles.css")
    if os.path.exists(css_path):
        return FileResponse(css_path, media_type="text/css")
    raise HTTPException(status_code=404, detail="styles.css not found")

@app.get("/app.js")
async def get_app_js():
    js_path = os.path.join(FRONTEND_DIR, "app.js")
    if os.path.exists(js_path):
        return FileResponse(js_path, media_type="application/javascript")
    raise HTTPException(status_code=404, detail="app.js not found")


# Shared state
active_bot: Optional[PolymarketBot] = None
connected_websockets: List[WebSocket] = []
logs_history: List[Dict] = []


def add_log(level: str, message: str):
    log_entry = {
        "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "level": level,
        "message": message
    }
    logs_history.append(log_entry)
    # Keep history to 100 entries
    if len(logs_history) > 100:
        logs_history.pop(0)
        
    # Broadcast to all connected websockets
    asyncio.run_coroutine_threadsafe(broadcast_log(log_entry), asyncio.get_event_loop())


async def broadcast_log(log_entry: Dict):
    if not connected_websockets:
        return
    
    payload = json.dumps({"type": "log", "data": log_entry})
    disconnected = []
    
    for websocket in connected_websockets:
        try:
            await websocket.send_text(payload)
        except Exception:
            disconnected.append(websocket)
            
    for ws in disconnected:
        if ws in connected_websockets:
            connected_websockets.remove(ws)


# WebSocket route for logs and live stats
@app.websocket("/ws/logs")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    connected_websockets.append(websocket)
    
    # Send historical logs first
    try:
        for log in logs_history:
            await websocket.send_text(json.dumps({"type": "log", "data": log}))
            
        # Start state pushing loop for this socket
        while True:
            # Push latest bot stats every second
            global active_bot
            if active_bot:
                status = active_bot.get_status()
                await websocket.send_text(json.dumps({"type": "status", "data": status}))
            else:
                await websocket.send_text(json.dumps({"type": "status", "data": {"is_running": False}}))
                
            await asyncio.sleep(1)
            
    except WebSocketDisconnect:
        if websocket in connected_websockets:
            connected_websockets.remove(websocket)
    except Exception:
        if websocket in connected_websockets:
            connected_websockets.remove(websocket)


# API Models
class BotStartRequest(BaseModel):
    token_id: str
    market_title: str = "Polymarket Market"
    outcome_name: str
    mode: str = "dry_run"
    strategy: str = "grid"
    order_size_usdc: float = 5.0
    spread_pct: float = 2.0


# REST Endpoints
@app.get("/api/search")
async def search_markets(query: str):
    """Queries Gamma API for markets matching the search terms."""
    gamma_url = "https://gamma-api.polymarket.com/markets"
    params = {
        "active": "true",
        "closed": "false",
        "limit": 10,
        "search": query
    }
    
    async with httpx.AsyncClient() as client:
        try:
            response = await client.get(gamma_url, params=params)
            if response.status_code != 200:
                raise HTTPException(status_code=response.status_code, detail="Gamma API error")
                
            markets = response.json()
            results = []
            
            for m in markets:
                # Ensure it has CLOB tokens
                clob_tokens_str = m.get("clobTokenIds")
                if not clob_tokens_str:
                    continue
                
                try:
                    # clobTokenIds is sometimes a stringified JSON list in the API response
                    clob_tokens = json.loads(clob_tokens_str) if isinstance(clob_tokens_str, str) else clob_tokens_str
                except Exception:
                    continue
                
                outcomes_str = m.get("outcomes")
                outcomes = json.loads(outcomes_str) if isinstance(outcomes_str, str) else outcomes_str
                
                if not clob_tokens or len(clob_tokens) < len(outcomes or []):
                    continue

                results.append({
                    "id": m.get("id"),
                    "title": m.get("title") or m.get("question") or "Polymarket Market",
                    "slug": m.get("slug"),
                    "question": m.get("question"),
                    "image": m.get("image"),
                    "outcomes": outcomes,
                    "clobTokenIds": clob_tokens
                })
                
            return results
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Search failed: {str(e)}")


@app.get("/api/orderbook")
async def get_orderbook(token_id: str):
    """Fetches the current order book for a specific outcome token from CLOB API."""
    clob_url = f"https://clob.polymarket.com/book?token_id={token_id}"
    
    async with httpx.AsyncClient() as client:
        try:
            response = await client.get(clob_url)
            if response.status_code != 200:
                raise HTTPException(status_code=response.status_code, detail="CLOB API error")
            return response.json()
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to fetch order book: {str(e)}")


@app.post("/api/bot/start")
async def start_bot(req: BotStartRequest):
    """Starts the trading bot on the specified market outcome."""
    global active_bot
    
    if active_bot and active_bot.is_running:
        raise HTTPException(status_code=400, detail="A bot is already running. Stop it first.")
        
    try:
        active_bot = PolymarketBot(
            token_id=req.token_id,
            market_title=req.market_title,
            outcome_name=req.outcome_name,
            mode=req.mode,
            strategy=req.strategy,
            order_size_usdc=req.order_size_usdc,
            spread_pct=req.spread_pct,
            log_callback=add_log
        )
        
        # Clear log history for the new session
        logs_history.clear()
        
        await active_bot.start()
        return {"status": "success", "message": f"Bot started on {req.market_title}"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to start bot: {str(e)}")


@app.post("/api/bot/stop")
async def stop_bot():
    """Stops the running trading bot."""
    global active_bot
    if not active_bot or not active_bot.is_running:
        return {"status": "success", "message": "Bot is not running."}
        
    try:
        await active_bot.stop()
        return {"status": "success", "message": "Bot stopped."}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to stop bot: {str(e)}")


@app.get("/api/bot/status")
async def get_bot_status():
    """Gets the status of the bot."""
    global active_bot
    if active_bot:
        return active_bot.get_status()
    return {"is_running": False}


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    uvicorn.run("backend.main:app", host="127.0.0.1", port=port, reload=True)

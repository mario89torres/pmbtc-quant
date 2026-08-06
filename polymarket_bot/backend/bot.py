import asyncio
import os
import json
import logging
from typing import Callable, Dict, List, Optional
import httpx
from dotenv import load_dotenv

# Try importing the official Polymarket CLOB client if installed
try:
    from py_clob_client.client import ClobClient
    from py_clob_client.clob_types import OrderArgs
    from py_clob_client.order_builder.constants import BUY, SELL
    PY_CLOB_AVAILABLE = True
except ImportError:
    PY_CLOB_AVAILABLE = False

load_dotenv()

class PolymarketBot:
    def __init__(
        self,
        token_id: str,
        market_title: str,
        outcome_name: str,
        mode: str = "dry_run",  # "dry_run" or "live"
        strategy: str = "grid",  # "grid" or "trend"
        order_size_usdc: float = 4.0,  # Compras de 3 a 5 USD (promedio $4)
        spread_pct: float = 2.0,
        log_callback: Optional[Callable[[str, str], None]] = None
    ):
        self.token_id = token_id
        self.market_title = market_title
        self.outcome_name = outcome_name
        self.mode = mode
        self.strategy = strategy
        self.order_size_usdc = order_size_usdc
        self.spread_pct = spread_pct
        self.log_callback = log_callback or (lambda lvl, msg: print(f"[{lvl.upper()}] {msg}"))
        
        self.is_running = False
        self._task: Optional[asyncio.Task] = None
        
        # Public CLOB endpoints
        self.clob_url = "https://clob.polymarket.com"
        
        # Dry Run (Simulation) State
        self.sim_balance_usdc = 25.0  # Banca inicial de $25 USD
        self.sim_position = 0.0  # units of outcome tokens held
        self.sim_avg_buy_price = 0.0
        self.sim_open_buy_order: Optional[Dict] = None
        self.sim_open_sell_order: Optional[Dict] = None
        self.total_sim_trades = 0
        self.realized_pnl = 0.0
        
        # Live Trading Client (Placeholder initialized if mode is live)
        self.clob_client = None
        self._init_live_client()

    def _init_live_client(self):
        if self.mode == "live":
            priv_key = os.getenv("POLYMARKET_PRIVATE_KEY")
            funder = os.getenv("POLYMARKET_FUNDER_ADDRESS")
            
            if not priv_key or priv_key == "your_polygon_private_key_here":
                self.log("error", "Private key not configured in .env! Reverting to Dry Run mode for safety.")
                self.mode = "dry_run"
                return

            if not PY_CLOB_AVAILABLE:
                self.log("error", "py-clob-client library not installed! Run `pip install py-clob-client`. Reverting to Dry Run.")
                self.mode = "dry_run"
                return
                
            try:
                self.log("info", f"Initializing Live Polymarket CLOB Client for wallet: {funder}...")
                self.clob_client = ClobClient(
                    host=self.clob_url,
                    key=priv_key,
                    chain_id=137,  # Polygon Mainnet
                    signature_type=1,  # EIP712
                    funder=funder
                )
                # Derive API credentials
                self.clob_client.set_api_creds(self.clob_client.create_or_derive_api_creds())
                self.log("info", "Live CLOB Client authenticated successfully!")
            except Exception as e:
                self.log("error", f"Failed to initialize live client: {str(e)}. Reverting to Dry Run.")
                self.mode = "dry_run"

    def log(self, level: str, message: str):
        if self.log_callback:
            self.log_callback(level, message)

    async def start(self):
        if self.is_running:
            return
        self.is_running = True
        self.log("info", f"Starting bot on: {self.market_title} ({self.outcome_name})")
        self.log("info", f"Mode: {self.mode.upper()} | Strategy: {self.strategy.upper()} | Order Size: {self.order_size_usdc} USDC | Spread: {self.spread_pct}%")
        self._task = asyncio.create_task(self._trading_loop())

    async def stop(self):
        if not self.is_running:
            return
        self.is_running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        self.log("info", "Bot stopped. All active simulated orders cancelled.")
        self.sim_open_buy_order = None
        self.sim_open_sell_order = None

    async def _trading_loop(self):
        async with httpx.AsyncClient() as client:
            while self.is_running:
                try:
                    # 1. Fetch real-time order book from Polymarket CLOB
                    url = f"{self.clob_url}/book?token_id={self.token_id}"
                    response = await client.get(url)
                    
                    if response.status_code != 200:
                        self.log("error", f"Failed to fetch order book: Code {response.status_code}")
                        await asyncio.sleep(5)
                        continue
                        
                    book = response.json()
                    bids = book.get("bids", [])
                    asks = book.get("asks", [])
                    
                    if not bids or not asks:
                        self.log("warning", "Empty order book. Waiting for liquidity...")
                        await asyncio.sleep(5)
                        continue
                        
                    best_bid = float(bids[0]["price"])
                    best_ask = float(asks[0]["price"])
                    mid_price = (best_bid + best_ask) / 2.0
                    
                    # 2. Run selected trading strategy
                    if self.mode == "dry_run":
                        await self._run_dry_run_strategy(best_bid, best_ask, mid_price)
                    else:
                        await self._run_live_strategy(best_bid, best_ask, mid_price)
                        
                except asyncio.CancelledError:
                    break
                except Exception as e:
                    self.log("error", f"Error in trading loop: {str(e)}")
                    
                # Trading frequency: poll every 5 seconds
                await asyncio.sleep(5)

    async def _run_dry_run_strategy(self, best_bid: float, best_ask: float, mid_price: float):
        spread_val = mid_price * (self.spread_pct / 100.0)
        
        # --- Check active simulated orders for fills ---
        # A simulated BUY is filled if the market's best ask falls to or below our buy price (someone sold to us)
        if self.sim_open_buy_order:
            buy_price = self.sim_open_buy_order["price"]
            if best_ask <= buy_price:
                fill_price = best_ask
                qty = self.sim_open_buy_order["quantity"]
                cost = qty * fill_price
                
                if self.sim_balance_usdc >= cost:
                    self.sim_balance_usdc -= cost
                    prev_pos = self.sim_position
                    prev_cost = prev_pos * self.sim_avg_buy_price
                    
                    self.sim_position += qty
                    self.sim_avg_buy_price = (prev_cost + cost) / self.sim_position
                    
                    self.total_sim_trades += 1
                    self.log("buy", f"Simulated BUY Filled: {qty:.2f} YES/NO @ ${fill_price:.2f} | Cost: {cost:.2f} USDC | Avg Cost: ${self.sim_avg_buy_price:.4f}")
                    self.sim_open_buy_order = None
                else:
                    self.log("warning", "Insufficient simulated USDC balance to fill buy order! Cancelling order.")
                    self.sim_open_buy_order = None

        # A simulated SELL is filled if the market's best bid rises to or above our sell price (someone bought from us)
        if self.sim_open_sell_order:
            sell_price = self.sim_open_sell_order["price"]
            if best_bid >= sell_price:
                fill_price = best_bid
                qty = self.sim_open_sell_order["quantity"]
                revenue = qty * fill_price
                
                # Calculate trade PnL
                cost_basis = qty * self.sim_avg_buy_price
                trade_pnl = revenue - cost_basis
                
                self.sim_balance_usdc += revenue
                self.sim_position -= qty
                self.realized_pnl += trade_pnl
                self.total_sim_trades += 1
                
                self.log("sell", f"Simulated SELL Filled: {qty:.2f} YES/NO @ ${fill_price:.2f} | Revenue: {revenue:.2f} USDC | PnL: +{trade_pnl:.2f} USDC")
                
                if self.sim_position < 0.01:
                    self.sim_position = 0.0
                    self.sim_avg_buy_price = 0.0
                self.sim_open_sell_order = None

        # --- Place new orders or re-grid if price moves ---
        # Strategy: Grid Market Making
        target_buy_price = round(mid_price - (spread_val / 2.0), 3)
        target_sell_price = round(mid_price + (spread_val / 2.0), 3)
        
        # Safety bounds (Polymarket prices must be between 0.01 and 0.99)
        target_buy_price = max(0.01, min(0.98, target_buy_price))
        target_sell_price = max(0.02, min(0.99, target_sell_price))
        
        # 1. Manage BUY Order
        # We buy if we have balance and position is not maxed out
        if not self.sim_open_buy_order and self.sim_position < (self.order_size_usdc * 3):
            # Calculate quantity to buy
            qty = self.order_size_usdc / target_buy_price
            self.sim_open_buy_order = {
                "price": target_buy_price,
                "quantity": qty
            }
            self.log("info", f"Placing Simulated Limit BUY: {qty:.2f} contracts @ ${target_buy_price:.2f}")
            
        elif self.sim_open_buy_order:
            # If price moved significantly (> 2% from target), cancel and replace
            existing_price = self.sim_open_buy_order["price"]
            if abs(existing_price - target_buy_price) / existing_price > 0.03:
                self.log("info", f"Cancelling buy order (${existing_price:.2f}) - Price moved. Re-centering grid.")
                self.sim_open_buy_order = None

        # 2. Manage SELL Order
        # In prediction markets, you can only sell if you hold the contract (cannot naked short)
        if self.sim_position >= 0.5:
            # Sell target must be higher than avg buy price to guarantee profit, or grid sell
            sell_price_threshold = max(target_sell_price, round(self.sim_avg_buy_price * 1.01, 3))
            
            if not self.sim_open_sell_order:
                # Sell the position
                qty = self.sim_position
                self.sim_open_sell_order = {
                    "price": sell_price_threshold,
                    "quantity": qty
                }
                self.log("info", f"Placing Simulated Limit SELL: {qty:.2f} contracts @ ${sell_price_threshold:.2f} (Avg Cost: ${self.sim_avg_buy_price:.2f})")
            elif self.sim_open_sell_order:
                # If market mid-price moves way above our sell order or falls low, re-adjust
                existing_price = self.sim_open_sell_order["price"]
                if abs(existing_price - sell_price_threshold) / existing_price > 0.03:
                    # Don't lower sell price below average buy price!
                    if sell_price_threshold >= self.sim_avg_buy_price:
                        self.log("info", f"Cancelling sell order (${existing_price:.2f}) - Adjusting to new target (${sell_price_threshold:.2f})")
                        self.sim_open_sell_order = None

    async def _run_live_strategy(self, best_bid: float, best_ask: float, mid_price: float):
        """
        Implementation framework for live trading.
        Demonstrates actual logic using Polymarket SDK.
        """
        # Calculate target prices
        spread_val = mid_price * (self.spread_pct / 100.0)
        buy_price = round(mid_price - (spread_val / 2.0), 2)
        sell_price = round(mid_price + (spread_val / 2.0), 2)
        
        # Clamp to Polymarket constraints
        buy_price = max(0.01, min(0.98, buy_price))
        sell_price = max(0.02, min(0.99, sell_price))

        self.log("info", f"[LIVE SKELETON] Mid price: ${mid_price:.2f}. Targets -> Buy: ${buy_price:.2f}, Sell: ${sell_price:.2f}")

        # The following block demonstrates how you interact with the CLOB client
        # to cancel and place orders. It requires the SDK installed.
        """
        # 1. Fetch current open orders from CLOB
        open_orders = self.clob_client.get_open_orders()
        
        # 2. Cancel orders if they are too far from target prices
        for order in open_orders:
            if order.token_id == self.token_id:
                order_price = float(order.price)
                if order.side == BUY and abs(order_price - buy_price) > 0.02:
                    self.log("info", f"Cancelling live BUY order ID {order.id}")
                    self.clob_client.cancel_order(order.id)
                elif order.side == SELL and abs(order_price - sell_price) > 0.02:
                    self.log("info", f"Cancelling live SELL order ID {order.id}")
                    self.clob_client.cancel_order(order.id)
                    
        # 3. Place new limit orders
        # Note: Must ensure you have token allowance approved for the exchange contract.
        
        # Place BUY order
        buy_qty = self.order_size_usdc / buy_price
        self.log("info", f"Placing Live Limit BUY: {buy_qty:.2f} contracts @ ${buy_price:.2f}")
        try:
            buy_order = self.clob_client.create_order(
                token_id=self.token_id,
                price=buy_price,
                side=BUY,
                amount=buy_qty,
                order_type="GTC"
            )
            self.log("buy", f"Live BUY order placed. ID: {buy_order.get('orderID')}")
        except Exception as e:
            self.log("error", f"Failed to place live BUY: {str(e)}")

        # Place SELL order (if we hold position tokens on-chain)
        # Fetching balance of self.token_id on ERC1155 contract:
        # token_balance = self.clob_client.get_token_balance(self.token_id)
        if token_balance > 0.1:
            self.log("info", f"Placing Live Limit SELL: {token_balance} contracts @ ${sell_price:.2f}")
            try:
                sell_order = self.clob_client.create_order(
                    token_id=self.token_id,
                    price=sell_price,
                    side=SELL,
                    amount=token_balance,
                    order_type="GTC"
                )
                self.log("sell", f"Live SELL order placed. ID: {sell_order.get('orderID')}")
            except Exception as e:
                self.log("error", f"Failed to place live SELL: {str(e)}")
        """
        
    def get_status(self) -> Dict:
        """Returns the current state of the bot for UI updates."""
        return {
            "is_running": self.is_running,
            "mode": self.mode,
            "strategy": self.strategy,
            "order_size": self.order_size_usdc,
            "spread": self.spread_pct,
            "token_id": self.token_id,
            "market_title": self.market_title,
            "outcome_name": self.outcome_name,
            # Balance/stats
            "usdc_balance": self.sim_balance_usdc,
            "position": self.sim_position,
            "avg_buy_price": self.sim_avg_buy_price,
            "realized_pnl": self.realized_pnl,
            "total_trades": self.total_sim_trades,
            # Open orders info
            "open_buy_order": self.sim_open_buy_order,
            "open_sell_order": self.sim_open_sell_order
        }

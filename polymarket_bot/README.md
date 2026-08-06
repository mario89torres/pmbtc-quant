# Polymarket Automated Trading Web Dashboard

A premium, fully interactive web-based dashboard and automated trading bot for Polymarket (Polygon Central Limit Order Book). It features a real-time market explorer, actual order book visualization, and an advanced **Dry Run (Paper Trading)** simulator for zero-risk strategy testing.

---

## Features
- **Modern Dark/Glassmorphic UI**: Beautiful dashboard with visual states, breathing pulse indicators, and detailed animations.
- **Market Search**: Queries the Polymarket Gamma API to find live events and tradeable outcomes (Yes/No).
- **Order Book Ladder**: Displays a live, real-time bid/ask order book for any selected market outcome.
- **Dry-Run (Paper Trading) Simulator**: Run strategies (e.g., Grid Trading / Market Making) without risk. It simulates order fills by matching real-time book prices against simulated positions.
- **Live Trading Structure**: A backend model showing how to configure credentials, sign EIP-712 messages, and send real limit orders using the Polymarket SDK.
- **WebSocket Logs**: Live, console-style logs streamed directly from the bot engine to the frontend.

---

## Getting Started

### 1. Prerequisites
You need **Python 3.8+** installed on your system.

### 2. Setup
1. Clone or open this project directory:
   ```bash
   cd polymarket-trading-bot
   ```
2. Create and activate a Python virtual environment:
   ```bash
   python -m venv venv
   # On Windows:
   .\venv\Scripts\activate
   # On macOS/Linux:
   source venv/bin/activate
   ```
3. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```
4. Copy the environment configuration:
   ```bash
   copy .env.example .env  # On Windows
   cp .env.example .env    # On macOS/Linux
   ```

### 3. Launching the App
Run the FastAPI application server:
```bash
python backend/main.py
```
Or use Uvicorn directly:
```bash
uvicorn backend.main:app --reload --port 8000
```
Open your browser and navigate to: **`http://localhost:8000`**

---

## How to Trade on Polymarket (Live)

Polymarket is built on Polygon and uses standard Ethereum-style wallets. To trade live with this bot, you will need to:

1. **Fund your Wallet**: Deposit POL (for gas fees) and USDC (Polygon PoS version) into your wallet address.
2. **Configure Keys**: Put your private key and wallet address in the `.env` file.
3. **Approve Allowances**: You must approve the Polymarket exchange contract address to spend your USDC. Without this, order placements will fail.
4. **Install the SDK**:
   ```bash
   pip install py-clob-client
   ```
5. **Switch to Live**: In the UI, toggle off "Dry Run" mode, input your strategy parameters, and start the engine. (Note: Make sure to review `backend/bot.py` to ensure it is configured with your specific risk tolerances).

---

## Security Best Practices
- **Private Key Storage**: Never commit your `.env` file to public repositories. The `.gitignore` file should always contain `.env` and `venv/`.
- **API Key Derivation**: The bot uses Polymarket's L2 API key derivation. Your private key signs a one-time message locally to derive trading credentials, ensuring your private key is never sent over the wire.
- **Minimal Sizing**: When first switching to live, use order sizes of 1.0 USDC (the minimum) to verify correct setup.

---

## Disclaimer
*This software is for educational purposes only. Do not risk capital you cannot afford to lose. Prediction markets are volatile, and automated bots can execute rapid trades that may result in financial loss.*

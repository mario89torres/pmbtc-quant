// ==========================================================================
// POLYMARKET BOT CLIENT-SIDE JAVASCRIPT
// ==========================================================================

// Global state variables
let socket = null;
let currentMarket = null;
let selectedTokenId = null;
let selectedOutcomeName = "";
let isBotRunning = false;
let executionMode = "dry_run"; // "dry_run" or "live"
let orderbookPollInterval = null;

// DOM Elements
const wsStatus = document.getElementById("ws-status");
const botStatusIndicator = document.getElementById("bot-status-indicator");
const walletAddressDisplay = document.getElementById("wallet-address-display");
const btnDryRun = document.getElementById("btn-dry-run");
const btnLive = document.getElementById("btn-live");
const searchInput = document.getElementById("market-search-input");
const btnSearch = document.getElementById("btn-search");
const searchResults = document.getElementById("search-results");
const selectStrategy = document.getElementById("select-strategy");
const selectedMarketInfo = document.getElementById("selected-market-info");
const bannerQuestion = document.getElementById("banner-question-text");
const bannerOutcomeGroup = document.getElementById("banner-outcome-group");
const inputOrderSize = document.getElementById("input-order-size");
const inputSpread = document.getElementById("input-spread");
const btnBotToggle = document.getElementById("btn-bot-toggle");
const activeTokenDisplay = document.getElementById("active-token-display");
const midPriceDisplay = document.getElementById("mid-price-display");
const spreadValueDisplay = document.getElementById("spread-value-display");
const bookAsks = document.getElementById("book-asks");
const bookBids = document.getElementById("book-bids");
const statBalance = document.getElementById("stat-balance");
const statPosition = document.getElementById("stat-position");
const statAvgPrice = document.getElementById("stat-avg-price");
const statPnl = document.getElementById("stat-pnl");
const terminalOutput = document.getElementById("terminal-output");
const btnClearLogs = document.getElementById("btn-clear-logs");
const activeOrdersTableBody = document.getElementById("active-orders-table-body");

// Initialize application
document.addEventListener("DOMContentLoaded", () => {
    connectWebSocket();
    setupEventListeners();
    performSearch(); // initial search on 'crypto'
});

// Setup WebSockets connection
function connectWebSocket() {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = window.location.host;
    socket = new WebSocket(`${protocol}//${host}/ws/logs`);

    socket.onopen = () => {
        setIndicatorState(wsStatus, "active-pulse-blue", "WS: Connected");
    };

    socket.onmessage = (event) => {
        const payload = JSON.parse(event.data);
        if (payload.type === "log") {
            appendLog(payload.data);
        } else if (payload.type === "status") {
            updateBotStatus(payload.data);
        }
    };

    socket.onclose = () => {
        setIndicatorState(wsStatus, "warning-pulse", "WS: Disconnected");
        // Try to reconnect in 5 seconds
        setTimeout(connectWebSocket, 5000);
    };

    socket.onerror = (err) => {
        console.error("WebSocket error:", err);
    };
}

// Setup Event Listeners
function setupEventListeners() {
    // Mode toggles
    btnDryRun.addEventListener("click", () => setExecutionMode("dry_run"));
    btnLive.addEventListener("click", () => setExecutionMode("live"));

    // Search trigger
    btnSearch.addEventListener("click", performSearch);
    searchInput.addEventListener("keypress", (e) => {
        if (e.key === "Enter") performSearch();
    });

    // Bot engine action button
    btnBotToggle.addEventListener("click", toggleBotEngine);

    // Clear logs button
    btnClearLogs.addEventListener("click", () => {
        terminalOutput.innerHTML = "";
    });
}

// Set UI Indicators
function setIndicatorState(element, pulseClass, labelText) {
    const dot = element.querySelector(".status-dot");
    const label = element.querySelector(".status-label");
    
    // Clear dynamic classes
    dot.className = "status-dot";
    dot.classList.add(pulseClass);
    label.textContent = labelText;
}

// Handle Mode Toggle
function setExecutionMode(mode) {
    executionMode = mode;
    if (mode === "dry_run") {
        btnDryRun.classList.add("active");
        btnLive.classList.remove("active");
        walletAddressDisplay.innerHTML = `<span class="info-label">Simulation Wallet:</span>
                                          <span class="info-value text-glow-blue">Simulated (Demo Mode)</span>`;
        appendSystemLog("Switched to Dry-Run Mode. Real-time data will be used, but trades will be simulated.");
    } else {
        btnDryRun.classList.remove("active");
        btnLive.classList.add("active");
        walletAddressDisplay.innerHTML = `<span class="info-label">Live Mainnet Account:</span>
                                          <span class="info-value text-glow-red">Configured in .env</span>`;
        appendSystemLog("Switched to Live Trading Mode. Actioning requires py-clob-client and private keys in backend `.env`.");
    }
}

// Query Gamma API via our proxy
async function performSearch() {
    const query = searchInput.value.trim();
    if (!query) return;

    searchResults.innerHTML = `<div class="loading-state"><i class="fa-solid fa-circle-notch fa-spin"></i> Fetching markets...</div>`;

    try {
        const response = await fetch(`/api/search?query=${encodeURIComponent(query)}`);
        if (!response.ok) throw new Error("Search request failed");
        
        const data = await response.json();
        renderSearchResults(data);
    } catch (err) {
        console.error(err);
        searchResults.innerHTML = `<div class="empty-state">Failed to query Polymarket. Make sure server is running.</div>`;
    }
}

// Render search results
function renderSearchResults(markets) {
    if (!markets || markets.length === 0) {
        searchResults.innerHTML = `<div class="empty-state">No active tradeable markets found.</div>`;
        return;
    }

    searchResults.innerHTML = "";
    markets.forEach((market) => {
        const item = document.createElement("div");
        item.className = "search-item";
        
        const img = market.image ? market.image : "https://polymarket.com/favicon.png";
        
        item.innerHTML = `
            <img class="search-item-img" src="${img}" onerror="this.src='https://polymarket.com/favicon.png'">
            <div class="search-item-info">
                <span class="search-item-title">${market.title}</span>
                <span class="search-item-slug">${market.slug}</span>
            </div>
        `;
        
        item.addEventListener("click", () => {
            // Remove previous selections
            document.querySelectorAll(".search-item").forEach(el => el.classList.remove("selected"));
            item.classList.add("selected");
            selectMarket(market);
        });
        
        searchResults.appendChild(item);
    });
}

// Select a market and construct outcomes
function selectMarket(market) {
    currentMarket = market;
    
    // Reset selections
    selectedTokenId = null;
    selectedOutcomeName = "";
    
    // UI displays
    selectedMarketInfo.classList.remove("hidden");
    bannerQuestion.textContent = market.question;
    
    // Clear outcomes group
    bannerOutcomeGroup.innerHTML = "";
    
    // Generate YES/NO buttons
    market.outcomes.forEach((outcome, idx) => {
        const btn = document.createElement("button");
        btn.className = `outcome-btn ${outcome.toLowerCase() === 'yes' ? 'yes-btn' : 'no-btn'}`;
        btn.textContent = outcome.toUpperCase();
        
        btn.addEventListener("click", () => {
            document.querySelectorAll(".outcome-btn").forEach(el => el.classList.remove("active"));
            btn.classList.add("active");
            
            selectedOutcomeName = outcome;
            selectedTokenId = market.clobTokenIds[idx];
            
            activeTokenDisplay.textContent = selectedTokenId.substring(0, 12) + "...";
            activeTokenDisplay.title = selectedTokenId;
            
            // Enable action button if not already running
            if (!isBotRunning) {
                btnBotToggle.disabled = false;
            }
            
            // Trigger order book loading
            fetchOrderbook();
            setupOrderbookPolling();
        });
        
        bannerOutcomeGroup.appendChild(btn);
    });

    // Reset order book display
    midPriceDisplay.textContent = "--";
    spreadValueDisplay.textContent = "--";
    resetOrderbookLadder();
}

// Poll order book details
function setupOrderbookPolling() {
    if (orderbookPollInterval) clearInterval(orderbookPollInterval);
    orderbookPollInterval = setInterval(fetchOrderbook, 3000);
}

// Fetch order book details
async function fetchOrderbook() {
    if (!selectedTokenId) return;

    try {
        const response = await fetch(`/api/orderbook?token_id=${selectedTokenId}`);
        if (!response.ok) throw new Error("Order book request failed");
        
        const book = await response.json();
        renderOrderbook(book);
    } catch (err) {
        console.error("Error fetching orderbook:", err);
    }
}

// Clear order book UI
function resetOrderbookLadder() {
    bookAsks.innerHTML = `
        <div class="ladder-row header">
            <span>Ask Price</span>
            <span>Quantity</span>
            <span>Depth</span>
        </div>
        <div class="empty-book-label">Select outcome to view asks</div>
    `;
    bookBids.innerHTML = `
        <div class="ladder-row header">
            <span>Bid Price</span>
            <span>Quantity</span>
            <span>Depth</span>
        </div>
        <div class="empty-book-label">Select outcome to view bids</div>
    `;
}

// Render the ladder
function renderOrderbook(book) {
    const bids = book.bids || [];
    const asks = book.asks || [];
    
    // Calculates mid price
    if (bids.length > 0 && asks.length > 0) {
        const bestBid = parseFloat(bids[0].price);
        const bestAsk = parseFloat(asks[0].price);
        const midPrice = (bestBid + bestAsk) / 2.0;
        midPriceDisplay.textContent = `$${midPrice.toFixed(2)}`;
        
        const spread = bestAsk - bestBid;
        spreadValueDisplay.textContent = `$${spread.toFixed(3)} (${((spread/midPrice)*100).toFixed(1)}%)`;
    } else {
        midPriceDisplay.textContent = "--";
        spreadValueDisplay.textContent = "--";
    }

    // Render Asks (Sell Orders - top of ladder, usually sorted low-to-high but we display them high-to-low for vertical orientation)
    bookAsks.innerHTML = `
        <div class="ladder-row header">
            <span>Ask Price</span>
            <span>Quantity</span>
            <span>Depth</span>
        </div>
    `;
    if (asks.length === 0) {
        bookAsks.innerHTML += `<div class="empty-book-label">No active asks</div>`;
    } else {
        // Take top 5 asks and sort high-to-low for rendering descending to mid
        const topAsks = asks.slice(0, 5).reverse();
        let cumulativeDepth = 0;
        const askRows = topAsks.map(ask => {
            const price = parseFloat(ask.price);
            const size = parseFloat(ask.size);
            cumulativeDepth += size;
            return { price, size, cumulativeDepth };
        });
        
        const maxDepth = cumulativeDepth || 1;
        
        askRows.forEach(row => {
            const pct = (row.cumulativeDepth / maxDepth) * 100;
            const rDiv = document.createElement("div");
            rDiv.className = "ladder-row";
            rDiv.innerHTML = `
                <div class="depth-bar" style="width: ${pct}%"></div>
                <span>$${row.price.toFixed(2)}</span>
                <span>${row.size.toLocaleString(undefined, {maximumFractionDigits: 0})}</span>
                <span>${row.cumulativeDepth.toLocaleString(undefined, {maximumFractionDigits: 0})}</span>
            `;
            bookAsks.appendChild(rDiv);
        });
    }

    // Render Bids (Buy Orders - bottom of ladder, sorted high-to-low)
    bookBids.innerHTML = `
        <div class="ladder-row header">
            <span>Bid Price</span>
            <span>Quantity</span>
            <span>Depth</span>
        </div>
    `;
    if (bids.length === 0) {
        bookBids.innerHTML += `<div class="empty-book-label">No active bids</div>`;
    } else {
        const topBids = bids.slice(0, 5);
        let cumulativeDepth = 0;
        const bidRows = topBids.map(bid => {
            const price = parseFloat(bid.price);
            const size = parseFloat(bid.size);
            cumulativeDepth += size;
            return { price, size, cumulativeDepth };
        });
        
        const maxDepth = cumulativeDepth || 1;
        
        bidRows.forEach(row => {
            const pct = (row.cumulativeDepth / maxDepth) * 100;
            const rDiv = document.createElement("div");
            rDiv.className = "ladder-row";
            rDiv.innerHTML = `
                <div class="depth-bar" style="width: ${pct}%"></div>
                <span>$${row.price.toFixed(2)}</span>
                <span>${row.size.toLocaleString(undefined, {maximumFractionDigits: 0})}</span>
                <span>${row.cumulativeDepth.toLocaleString(undefined, {maximumFractionDigits: 0})}</span>
            `;
            bookBids.appendChild(rDiv);
        });
    }
}

// Log actions
function appendLog(log) {
    const div = document.createElement("div");
    div.className = `log-line ${log.level.toLowerCase()}-line`;
    div.innerHTML = `<span class="font-mono text-muted">[${log.timestamp.split(" ")[1]}]</span> [${log.level.toUpperCase()}] ${log.message}`;
    
    terminalOutput.appendChild(div);
    // Auto-scroll
    terminalOutput.scrollTop = terminalOutput.scrollHeight;
}

function appendSystemLog(message) {
    appendLog({
        timestamp: new Date().toISOString().replace('T', ' ').substring(0, 19),
        level: "system",
        message: message
    });
}

// Start / Stop bot engine
async function toggleBotEngine() {
    if (isBotRunning) {
        // Stop engine
        try {
            const res = await fetch("/api/bot/stop", { method: "POST" });
            if (!res.ok) throw new Error("Failed to stop bot");
        } catch (err) {
            console.error(err);
            appendSystemLog("Error stopping bot: " + err.message);
        }
    } else {
        // Start engine
        if (!selectedTokenId) return;
        
        const orderSize = parseFloat(inputOrderSize.value);
        const spread = parseFloat(inputSpread.value);
        
        if (isNaN(orderSize) || orderSize < 1.0) {
            alert("Order size must be at least 1 USDC");
            return;
        }
        if (isNaN(spread) || spread < 0.1) {
            alert("Spread must be at least 0.1%");
            return;
        }

        const payload = {
            token_id: selectedTokenId,
            market_title: currentMarket.title,
            outcome_name: selectedOutcomeName,
            mode: executionMode,
            strategy: selectStrategy.value,
            order_size_usdc: orderSize,
            spread_pct: spread
        };

        try {
            const res = await fetch("/api/bot/start", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });
            
            if (!res.ok) {
                const errData = await res.json();
                let errorMsg = "Failed to start bot";
                if (errData && errData.detail) {
                    if (typeof errData.detail === "string") {
                        errorMsg = errData.detail;
                    } else if (Array.isArray(errData.detail)) {
                        errorMsg = errData.detail.map(err => {
                            const field = err.loc ? err.loc.join('.') : 'field';
                            return `${field}: ${err.msg}`;
                        }).join("; ");
                    }
                }
                throw new Error(errorMsg);
            }
        } catch (err) {
            console.error(err);
            appendSystemLog("Error starting bot: " + err.message);
            alert("Error: " + err.message);
        }
    }
}

// Sync Bot Status with UI
function updateBotStatus(data) {
    isBotRunning = data.is_running;

    if (isBotRunning) {
        // Update dashboard indicators
        if (data.mode === "dry_run") {
            setIndicatorState(botStatusIndicator, "active-pulse-blue", "Engine: Simulating");
        } else {
            setIndicatorState(botStatusIndicator, "active-pulse-green", "Engine: LIVE Active");
        }
        
        // Disable strategy adjustments while running
        inputOrderSize.disabled = true;
        inputSpread.disabled = true;
        selectStrategy.disabled = true;
        btnDryRun.disabled = true;
        btnLive.disabled = true;
        document.querySelectorAll(".outcome-btn").forEach(el => el.disabled = true);
        
        // Update toggle button state
        btnBotToggle.innerHTML = `<i class="fa-solid fa-square-full"></i> Stop Bot Engine`;
        btnBotToggle.className = "action-btn stop-btn";
        btnBotToggle.disabled = false;
        
        // Sync simulator values
        statBalance.textContent = `$${data.usdc_balance.toFixed(2)}`;
        statPosition.textContent = `${data.position.toFixed(2)}`;
        statAvgPrice.textContent = `$${data.avg_buy_price.toFixed(3)}`;
        
        const pnl = data.realized_pnl;
        statPnl.textContent = `${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`;
        statPnl.className = `stat-val font-mono ${pnl >= 0 ? 'text-glow-green' : 'text-glow-red'}`;
        
        // Render Active orders table
        renderActiveOrdersTable(data.open_buy_order, data.open_sell_order);

    } else {
        // Update indicators
        setIndicatorState(botStatusIndicator, "inactive-dot", "Engine: Inactive");
        
        // Re-enable settings
        inputOrderSize.disabled = false;
        inputSpread.disabled = false;
        selectStrategy.disabled = false;
        btnDryRun.disabled = false;
        btnLive.disabled = false;
        document.querySelectorAll(".outcome-btn").forEach(el => el.disabled = false);
        
        // Set toggle button back to start
        btnBotToggle.innerHTML = `<i class="fa-solid fa-play"></i> Start Bot Engine`;
        btnBotToggle.className = "action-btn start-btn";
        
        if (!selectedTokenId) {
            btnBotToggle.disabled = true;
        }

        // Clear active orders table
        activeOrdersTableBody.innerHTML = `
            <tr>
                <td colspan="4" class="no-orders">No active simulated orders resting on book</td>
            </tr>
        `;
    }
}

// Render active orders in the table
function renderActiveOrdersTable(buyOrder, sellOrder) {
    if (!buyOrder && !sellOrder) {
        activeOrdersTableBody.innerHTML = `
            <tr>
                <td colspan="4" class="no-orders">No active simulated orders resting on book</td>
            </tr>
        `;
        return;
    }

    activeOrdersTableBody.innerHTML = "";
    
    if (buyOrder) {
        const row = document.createElement("tr");
        row.innerHTML = `
            <td><span class="order-badge badge-buy">BUY</span></td>
            <td><span class="order-price">$${buyOrder.price.toFixed(2)}</span></td>
            <td><span class="order-qty">${buyOrder.quantity.toFixed(2)}</span></td>
            <td><span class="order-status">Resting</span></td>
        `;
        activeOrdersTableBody.appendChild(row);
    }
    
    if (sellOrder) {
        const row = document.createElement("tr");
        row.innerHTML = `
            <td><span class="order-badge badge-sell">SELL</span></td>
            <td><span class="order-price">$${sellOrder.price.toFixed(2)}</span></td>
            <td><span class="order-qty">${sellOrder.quantity.toFixed(2)}</span></td>
            <td><span class="order-status">Resting</span></td>
        `;
        activeOrdersTableBody.appendChild(row);
    }
}

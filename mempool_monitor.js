const { ethers } = require('ethers');

class MempoolMonitor {
  constructor(wsUrl, factoryAddress, logger) {
    this.wsUrl = wsUrl;
    this.factoryAddress = factoryAddress ? factoryAddress.toLowerCase() : null;
    this.logger = logger;
    this.provider = null;
    this.callbacks = [];
    this.isRunning = false;
    this.reconnectTimeout = null;
  }

  onLaunchDetected(callback) {
    this.callbacks.push(callback);
  }

  async start() {
    if (!this.wsUrl || this.wsUrl.includes('REPLACE')) {
      this.logger.warn('[MEMPOOL] No valid WS URL configured. Skipping mempool monitor.');
      return;
    }
    if (this.isRunning) return;

    try {
      this.logger.info(`[MEMPOOL] Connecting to WS: ${this.wsUrl}...`);
      this.provider = new ethers.WebSocketProvider(this.wsUrl);
      this.isRunning = true;
      this.lastMessageTime = Date.now();

      // Handle pending txs
      this.provider.on('pending', async (txHash) => {
        if (!this.isRunning) return;
        this.lastMessageTime = Date.now(); // update watchdog timestamp
        try {
          const tx = await Promise.race([
            this.provider.getTransaction(txHash),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000))
          ]);
          
          if (!tx) return;

          // Detect direct factory creation calls
          if (tx.to && this.factoryAddress && tx.to.toLowerCase() === this.factoryAddress) {
            this.logger.info(`[MEMPOOL DETECTED] Pending launch transaction: ${txHash}`);
            this.triggerCallbacks({
              type: 'factory_call',
              hash: txHash,
              from: tx.from,
              data: tx.data
            });
          }

          // Optional: match common launch method signatures (e.g. 0xef8c68c1 for createToken) in inputs
          if (tx.data && tx.data.startsWith('0xef8c68c1')) {
            this.logger.info(`[MEMPOOL DETECTED] Pending method call 0xef8c68c1: ${txHash}`);
            this.triggerCallbacks({
              type: 'method_call',
              hash: txHash,
              to: tx.to,
              data: tx.data
            });
          }
        } catch (e) {
          // ignore timeouts/null txs
        }
      });

      // WebSocket connection error/close handlers
      if (this.provider.websocket) {
        this.provider.websocket.on('close', () => {
          this.logger.debug('[MEMPOOL] WS Connection closed. Retrying in 15s...');
          this.cleanup();
          this.reconnectTimeout = setTimeout(() => this.start(), 15000);
        });

        this.provider.websocket.on('error', (err) => {
          this.logger.debug('[MEMPOOL] WS socket error: ' + err.message);
        });
      }

      // Ping Interval: Send ping every 25s, verify connection responds
      this.pingInterval = setInterval(() => {
        if (!this.isRunning || !this.provider) return;
        this.logger.debug('[MEMPOOL] Sending WS ping heartbeat...');
        let ponged = false;
        const pingTimeout = setTimeout(() => {
          if (!ponged && this.isRunning) {
            this.logger.warn('[MEMPOOL] WS ping timeout - restarting connection');
            this.cleanup();
            this.start();
          }
        }, 5000);

        this.provider.send('eth_blockNumber', []).then(() => {
          ponged = true;
          clearTimeout(pingTimeout);
          this.lastMessageTime = Date.now();
        }).catch(() => {
          // ignore / let timeout handle it
        });
      }, 25000);

      // Watchdog watchdogInterval: check if no mempool logs seen for 90 seconds
      this.watchdogInterval = setInterval(() => {
        if (Date.now() - this.lastMessageTime > 90000 && this.isRunning) {
          this.logger.warn('[MEMPOOL] No WS mempool activity for 90s (Watchdog) - reconnecting');
          this.cleanup();
          this.start();
        }
      }, 10000);

      this.logger.info('[MEMPOOL] WS Mempool Monitor active.');
    } catch (e) {
      this.logger.warn(`[MEMPOOL] Failed to start WS monitor: ${e.message}`);
      this.cleanup();
      this.reconnectTimeout = setTimeout(() => this.start(), 20000);
    }
  }

  triggerCallbacks(event) {
    for (const cb of this.callbacks) {
      try {
        cb(event);
      } catch (e) {
        this.logger.error('[MEMPOOL] Callback handler error: ' + e.message);
      }
    }
  }

  cleanup() {
    this.isRunning = false;
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.watchdogInterval) {
      clearInterval(this.watchdogInterval);
      this.watchdogInterval = null;
    }
    if (this.provider) {
      try {
        this.provider.destroy();
      } catch {}
      this.provider = null;
    }
  }

  stop() {
    this.cleanup();
    this.logger.info('[MEMPOOL] WS Mempool Monitor stopped.');
  }
}

module.exports = MempoolMonitor;

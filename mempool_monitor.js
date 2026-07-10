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

      // Handle pending txs
      this.provider.on('pending', async (txHash) => {
        if (!this.isRunning) return;
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

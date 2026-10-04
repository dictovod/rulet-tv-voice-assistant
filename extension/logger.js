/**
 * Universal Diagnostic Logger for Studio Assistant Plugin
 * Handles structured logging, memory caching, chrome.storage persistence, and log export.
 */

const LOG_STORAGE_KEY = 'studio_plugin_debug_logs';
const MAX_LOGS = 500;

class PluginLogger {
  constructor(context = 'general') {
    this.context = context;
    this.logs = [];
    this.subscribers = new Set();
    this.init();
  }

  async init() {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        const data = await chrome.storage.local.get([LOG_STORAGE_KEY]);
        if (data && Array.isArray(data[LOG_STORAGE_KEY])) {
          this.logs = data[LOG_STORAGE_KEY];
        }
      }
    } catch (err) {
      console.warn('[Logger] Unable to load cached logs from storage:', err);
    }

    if (typeof window !== 'undefined') {
      window.addEventListener('error', (event) => {
        this.error(`Uncaught Error: ${event.message}`, {
          filename: event.filename,
          lineno: event.lineno,
          colno: event.colno,
          stack: event.error ? event.error.stack : null,
        });
      });

      window.addEventListener('unhandledrejection', (event) => {
        this.error(`Unhandled Promise Rejection: ${event.reason}`, {
          reason: String(event.reason),
          stack: event.reason && event.reason.stack ? event.reason.stack : null,
        });
      });
    }

    this.info(`Logger initialized for context: [${this.context}]`);
  }

  _record(level, message, metadata = null) {
    const entry = {
      id: `${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      timestamp: new Date().toISOString(),
      level: level.toUpperCase(),
      context: this.context,
      message: typeof message === 'object' ? JSON.stringify(message) : String(message),
      metadata: metadata,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'service_worker',
    };

    const prefix = `[StudioPlugin:${this.context}][${entry.level}]`;
    if (level === 'error') {
      console.error(prefix, message, metadata || '');
    } else if (level === 'warn') {
      console.warn(prefix, message, metadata || '');
    } else {
      console.log(prefix, message, metadata || '');
    }

    this.logs.unshift(entry);
    if (this.logs.length > MAX_LOGS) {
      this.logs = this.logs.slice(0, MAX_LOGS);
    }

    this._saveToStorage();
    this.subscribers.forEach((fn) => fn(entry));

    return entry;
  }

  async _saveToStorage() {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        await chrome.storage.local.set({ [LOG_STORAGE_KEY]: this.logs });
      }
    } catch (e) {
      // Ignore quota errors
    }
  }

  info(msg, meta = null) { return this._record('info', msg, meta); }
  warn(msg, meta = null) { return this._record('warn', msg, meta); }
  error(msg, meta = null) { return this._record('error', msg, meta); }
  debug(msg, meta = null) { return this._record('debug', msg, meta); }

  getLogs() { return [...this.logs]; }

  subscribe(callback) {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  async clearLogs() {
    this.logs = [];
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      await chrome.storage.local.remove([LOG_STORAGE_KEY]);
    }
    this.info('Debug logs cleared by user.');
    return true;
  }

  exportAsJSON() {
    return JSON.stringify({
      exportedAt: new Date().toISOString(),
      pluginVersion: '1.0.0',
      logs: this.logs,
    }, null, 2);
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { PluginLogger };
}
if (typeof window !== 'undefined') {
  window.PluginLogger = PluginLogger;
  window.pluginLogger = new PluginLogger('global');
}
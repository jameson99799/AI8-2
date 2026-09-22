"use strict";

const fs = require("fs");
const path = require("path");

class RuntimeLogger {
    constructor(options = {}) {
        this.maxEntries = Number.isFinite(Number(options.maxEntries)) ? Number(options.maxEntries) : 500;
        this.maxFileBytes = Number.isFinite(Number(options.maxFileBytes)) ? Number(options.maxFileBytes) : 10 * 1024 * 1024;
        this.maxTailBytes = Number.isFinite(Number(options.maxTailBytes)) ? Number(options.maxTailBytes) : 2 * 1024 * 1024;
        this.entries = [];
        this.originalConsole = {
            debug: console.debug.bind(console),
            error: console.error.bind(console),
            info: console.info.bind(console),
            log: console.log.bind(console),
            warn: console.warn.bind(console),
        };
        this.setLogPath(options.logPath || path.resolve(process.cwd(), "logs", "ai8-adapter.log"));
    }

    setLogPath(logPath) {
        const resolvedPath = path.resolve(logPath);
        if (this.logPath === resolvedPath && this.stream) {
            return;
        }

        this.logPath = resolvedPath;
        fs.mkdirSync(path.dirname(this.logPath), { recursive: true });

        if (this.stream) {
            this.stream.end();
        }

        this.stream = fs.createWriteStream(this.logPath, {
            flags: "a",
        });
        this._attachStreamErrorHandler(this.stream);
    }

    _attachStreamErrorHandler(stream) {
        // Without an error listener a write failure (disk full, deleted
        // directory, permissions) becomes an uncaught exception.
        stream.on("error", error => {
            if (this.stream === stream) {
                this.stream = null;
            }
            this.originalConsole.error(`[ai8-logger] Failed to write ${this.logPath}: ${error?.message || error}`);
        });
    }

    debug(message, meta) {
        this.log("debug", message, meta);
    }

    info(message, meta) {
        this.log("info", message, meta);
    }

    warn(message, meta) {
        this.log("warn", message, meta);
    }

    error(message, meta) {
        this.log("error", message, meta);
    }

    log(level, message, meta) {
        const entry = {
            level,
            message: String(message || ""),
            meta: meta === undefined ? null : meta,
            timestamp: new Date().toISOString(),
        };

        this.entries.push(entry);
        if (this.entries.length > this.maxEntries) {
            this.entries.shift();
        }

        const line = formatLogLine(entry);
        this._rotateIfNeeded();
        this._writeLine(`${line}\n`);
        this._writeToConsole(level, line);
    }

    _writeLine(line) {
        if (!this.stream) {
            this._reopenStream();
        }

        if (this.stream && !this.stream.destroyed) {
            this.stream.write(line);
        }
    }

    _reopenStream(force = false) {
        const now = Date.now();
        if (!force && this._lastReopenAt && now - this._lastReopenAt < 30000) {
            return;
        }
        this._lastReopenAt = now;

        try {
            fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
            this.stream = fs.createWriteStream(this.logPath, { flags: "a" });
            this._attachStreamErrorHandler(this.stream);
        } catch (error) {
            this.originalConsole.error(`[ai8-logger] Failed to reopen ${this.logPath}: ${error?.message || error}`);
            this.stream = null;
        }
    }

    _rotateIfNeeded() {
        const stream = this.stream;
        if (!stream || stream.destroyed || stream.bytesWritten < this.maxFileBytes) {
            return;
        }

        const backupPath = `${this.logPath}.1`;
        this.stream = null;
        stream.end();
        stream.once("close", () => {
            try {
                fs.renameSync(this.logPath, backupPath);
            } catch (error) {
                this.originalConsole.error(`[ai8-logger] Failed to rotate ${this.logPath}: ${error?.message || error}`);
            }
            this._reopenStream(true);
        });
    }

    getEntries(limit = 200) {
        const normalizedLimit = Number.isFinite(Number(limit)) ? Math.max(1, Number(limit)) : 200;
        return this.entries.slice(-normalizedLimit);
    }

    getLogPath() {
        return this.logPath;
    }

    readFileTail(limit = 200) {
        const normalizedLimit = Number.isFinite(Number(limit)) ? Math.max(1, Number(limit)) : 200;
        if (!this.logPath || !fs.existsSync(this.logPath)) {
            return [];
        }

        let fd = null;
        try {
            // Read only the tail of the file: reading the whole log on every
            // admin request gets slower as the file grows.
            const stats = fs.statSync(this.logPath);
            const start = Math.max(0, stats.size - this.maxTailBytes);
            const length = stats.size - start;
            if (length <= 0) {
                return [];
            }

            fd = fs.openSync(this.logPath, "r");
            const buffer = Buffer.alloc(length);
            fs.readSync(fd, buffer, 0, length, start);
            const lines = buffer
                .toString("utf8")
                .split(/\r?\n/)
                .map(line => line.trimEnd())
                .filter(Boolean);

            if (start > 0 && lines.length > 0) {
                // The first line may be cut in half by the byte offset.
                lines.shift();
            }

            return lines.slice(-normalizedLimit);
        } catch (error) {
            return [];
        } finally {
            if (fd !== null) {
                try {
                    fs.closeSync(fd);
                } catch (closeError) {
                    // Ignore close failures.
                }
            }
        }
    }

    _writeToConsole(level, line) {
        switch (level) {
            case "debug":
                this.originalConsole.debug(line);
                break;
            case "error":
                this.originalConsole.error(line);
                break;
            case "warn":
                this.originalConsole.warn(line);
                break;
            case "info":
                this.originalConsole.info(line);
                break;
            default:
                this.originalConsole.log(line);
                break;
        }
    }
}

function formatLogLine(entry) {
    const prefix = `[${entry.timestamp}] [${String(entry.level || "info").toUpperCase()}]`;
    const message = entry.message || "";

    if (entry.meta === null || entry.meta === undefined) {
        return `${prefix} ${message}`.trim();
    }

    let serializedMeta = "";
    try {
        serializedMeta = JSON.stringify(entry.meta);
    } catch (error) {
        serializedMeta = String(entry.meta);
    }

    return `${prefix} ${message} ${serializedMeta}`.trim();
}

module.exports = RuntimeLogger;

"use strict";

const fs = require("fs");
const path = require("path");

class RuntimeLogger {
    constructor(options = {}) {
        this.maxEntries = Number.isFinite(Number(options.maxEntries)) ? Number(options.maxEntries) : 500;
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
        this.stream.write(`${line}\n`);
        this._writeToConsole(level, line);
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

        const content = fs.readFileSync(this.logPath, "utf8");
        return content
            .split(/\r?\n/)
            .map(line => line.trimEnd())
            .filter(Boolean)
            .slice(-normalizedLimit);
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

export class RingLogger {
  constructor({ limit = 100, onEntry = () => {} } = {}) {
    this.limit = limit;
    this.onEntry = onEntry;
    this.entries = [];
  }

  push(level, message) {
    const entry = {
      level,
      message: String(message),
      at: new Date().toISOString(),
    };
    this.entries.push(entry);
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
    this.onEntry(entry, [...this.entries]);
    return entry;
  }

  info(message) { return this.push("info", message); }
  warn(message) { return this.push("warn", message); }
  error(message) { return this.push("error", message); }
}

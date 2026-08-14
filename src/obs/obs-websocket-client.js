import { normalizeLocalObsHost, normalizePort } from "../shared/contracts.js";
import { ObsConnectionError, ObsRequestError } from "../shared/errors.js";

function bytesToBase64(bytes) {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function sha256Base64(value, cryptoImpl) {
  const bytes = new TextEncoder().encode(value);
  const digest = await cryptoImpl.subtle.digest("SHA-256", bytes);
  return bytesToBase64(new Uint8Array(digest));
}

export async function createObsAuthentication(password, salt, challenge, cryptoImpl = globalThis.crypto) {
  if (!cryptoImpl?.subtle) throw new Error("Web Crypto API is unavailable");
  const secret = await sha256Base64(`${password}${salt}`, cryptoImpl);
  return sha256Base64(`${secret}${challenge}`, cryptoImpl);
}

export function buildObsWebSocketUrl({ host = "127.0.0.1", port = 4455 } = {}) {
  return `ws://${normalizeLocalObsHost(host)}:${normalizePort(port)}`;
}

function createRequestId(cryptoImpl = globalThis.crypto) {
  if (typeof cryptoImpl?.randomUUID === "function") return cryptoImpl.randomUUID();
  return `request-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export class ObsWebSocketClient {
  constructor({
    url,
    password = "",
    WebSocketImpl = globalThis.WebSocket,
    cryptoImpl = globalThis.crypto,
    requestTimeoutMs = 5000,
    connectTimeoutMs = 8000,
    onState = () => {},
    onEvent = () => {},
  } = {}) {
    if (!url) throw new TypeError("OBS WebSocket URL is required");
    if (!WebSocketImpl) throw new Error("WebSocket API is unavailable");
    this.url = url;
    this.password = String(password ?? "");
    this.WebSocketImpl = WebSocketImpl;
    this.cryptoImpl = cryptoImpl;
    this.requestTimeoutMs = requestTimeoutMs;
    this.connectTimeoutMs = connectTimeoutMs;
    this.onState = onState;
    this.onEvent = onEvent;
    this.socket = null;
    this.pending = new Map();
    this.connectPromise = null;
    this.connectResolve = null;
    this.connectReject = null;
    this.connectTimer = null;
    this.negotiatedRpcVersion = null;
  }

  get connected() {
    return Boolean(this.socket && this.socket.readyState === this.WebSocketImpl.OPEN && this.negotiatedRpcVersion != null);
  }

  async connect() {
    if (this.connected) return;
    if (this.connectPromise) return this.connectPromise;

    this.onState({ state: "connecting" });
    let socket;
    try {
      socket = new this.WebSocketImpl(this.url);
    } catch (error) {
      const wrapped = new ObsConnectionError(`Unable to open OBS WebSocket: ${error?.message ?? error}`, { cause: error });
      this.onState({ state: "error", error: wrapped });
      throw wrapped;
    }

    this.connectPromise = new Promise((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;
    });
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      void this.#handleMessage(event.data).catch((error) => this.#failConnect(error));
    });
    socket.addEventListener("error", () => {
      this.#failConnect(new ObsConnectionError("OBS WebSocket connection failed"));
    });
    socket.addEventListener("close", (event) => {
      const error = new ObsConnectionError(`OBS WebSocket closed (${event.code || 0}${event.reason ? `: ${event.reason}` : ""})`);
      this.#rejectAllPending(error);
      this.negotiatedRpcVersion = null;
      this.onState({ state: "disconnected", code: event.code, reason: event.reason });
      if (this.connectReject) this.#failConnect(error);
    });

    this.connectTimer = setTimeout(() => {
      this.#failConnect(new ObsConnectionError("OBS WebSocket connection timed out"));
      try { socket.close(); } catch {}
    }, this.connectTimeoutMs);

    return this.connectPromise;
  }

  async request(requestType, requestData = {}) {
    if (!this.connected) throw new ObsConnectionError("OBS WebSocket is not connected");
    const requestId = createRequestId(this.cryptoImpl);
    const payload = {
      op: 6,
      d: {
        requestType,
        requestId,
        ...(Object.keys(requestData).length ? { requestData } : {}),
      },
    };

    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new ObsConnectionError(`${requestType} request timed out`));
      }, this.requestTimeoutMs);
      this.pending.set(requestId, { requestType, resolve, reject, timer });
    });

    this.socket.send(JSON.stringify(payload));
    return response;
  }

  disconnect() {
    clearTimeout(this.connectTimer);
    this.connectTimer = null;
    this.connectResolve = null;
    this.connectReject = null;
    this.connectPromise = null;
    this.negotiatedRpcVersion = null;
    const error = new ObsConnectionError("OBS WebSocket disconnected by user");
    this.#rejectAllPending(error);
    try { this.socket?.close(1000, "client disconnect"); } catch {}
    this.socket = null;
    this.onState({ state: "disconnected" });
  }

  async #handleMessage(raw) {
    const message = JSON.parse(String(raw));
    switch (message.op) {
      case 0:
        await this.#handleHello(message.d ?? {});
        break;
      case 2:
        this.negotiatedRpcVersion = message.d?.negotiatedRpcVersion ?? 1;
        clearTimeout(this.connectTimer);
        this.connectTimer = null;
        this.onState({ state: "connected", rpcVersion: this.negotiatedRpcVersion });
        this.connectResolve?.();
        this.connectResolve = null;
        this.connectReject = null;
        this.connectPromise = null;
        break;
      case 5:
        this.onEvent(message.d ?? {});
        break;
      case 7:
        this.#handleResponse(message.d ?? {});
        break;
      default:
        break;
    }
  }

  async #handleHello(data) {
    const identify = { rpcVersion: Math.min(Number(data.rpcVersion || 1), 1), eventSubscriptions: 0 };
    if (data.authentication) {
      if (!this.password) throw new ObsConnectionError("OBS requires a WebSocket password");
      identify.authentication = await createObsAuthentication(
        this.password,
        data.authentication.salt,
        data.authentication.challenge,
        this.cryptoImpl,
      );
    }
    this.socket.send(JSON.stringify({ op: 1, d: identify }));
  }

  #handleResponse(data) {
    const pending = this.pending.get(data.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(data.requestId);
    const status = data.requestStatus ?? {};
    if (!status.result) {
      pending.reject(new ObsRequestError(pending.requestType, status.code ?? 0, status.comment));
      return;
    }
    pending.resolve(data.responseData ?? {});
  }

  #failConnect(error) {
    clearTimeout(this.connectTimer);
    this.connectTimer = null;
    this.onState({ state: "error", error });
    this.connectReject?.(error);
    this.connectResolve = null;
    this.connectReject = null;
    this.connectPromise = null;
    this.negotiatedRpcVersion = null;
    if (this.socket && this.socket.readyState < this.WebSocketImpl.CLOSING) {
      try { this.socket.close(4000, "connection failed"); } catch {}
    }
  }

  #rejectAllPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export class EnglishCcError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "EnglishCcError";
    this.code = code;
  }
}

export class ObsConnectionError extends EnglishCcError {
  constructor(message, options = {}) {
    super("OBS_CONNECTION_FAILED", message, options);
    this.name = "ObsConnectionError";
  }
}

export class ObsRequestError extends EnglishCcError {
  constructor(requestType, code, message) {
    super("OBS_REQUEST_FAILED", `${requestType} failed (${code}): ${message || "unknown error"}`);
    this.name = "ObsRequestError";
    this.requestType = requestType;
    this.requestCode = code;
  }
}

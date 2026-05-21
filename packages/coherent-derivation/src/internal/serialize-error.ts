import type { SerializedError } from "./worker-protocol.js";

export function serializeError(value: unknown): SerializedError {
  if (value instanceof Error) {
    const result: SerializedError = {
      name: value.name,
      message: value.message,
      ...(value.stack !== undefined ? { stack: value.stack } : {}),
    };
    return result;
  }
  return {
    name: "NonErrorThrown",
    message: typeof value === "string" ? value : JSON.stringify(value),
  };
}

/**
 * Reverse of `serializeError`. The reconstructed `Error` carries the
 * original `name`, `message`, and `stack` — enough for adopters to log,
 * branch, or rethrow. The original prototype is unrecoverable (custom
 * subclasses become base `Error`); adopters branching on `error.name`
 * still get the original constructor name.
 */
export function deserializeError(value: SerializedError): Error {
  const error = new Error(value.message);
  error.name = value.name;
  if (value.stack !== undefined) {
    error.stack = value.stack;
  }
  return error;
}

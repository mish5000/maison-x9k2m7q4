/**
 * Error taxonomy. Every error crossing the API boundary is mapped to one of
 * these codes; raw messages and stack traces never reach the client.
 */
export const ERROR_CODES = [
  'invalid_request',
  'unsupported_query',
  'not_found',
  'forbidden',
  'unauthenticated',
  'rate_limited',
  'provider_unavailable',
  'unsafe_url',
  'verification_failed',
  'download_not_permitted',
  'connector_not_configured',
  'connector_auth_expired',
  'payload_too_large',
  'cancelled',
  'timeout',
  'internal_error',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  invalid_request: 400,
  unsupported_query: 400,
  not_found: 404,
  forbidden: 403,
  unauthenticated: 401,
  rate_limited: 429,
  provider_unavailable: 503,
  unsafe_url: 400,
  verification_failed: 422,
  download_not_permitted: 403,
  connector_not_configured: 409,
  connector_auth_expired: 401,
  payload_too_large: 413,
  cancelled: 499,
  timeout: 504,
  internal_error: 500,
};

export class AuralisError extends Error {
  readonly code: ErrorCode;
  /** Message safe to show a user. */
  readonly publicMessage: string;
  /** Structured, non-sensitive details for the client. */
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: ErrorCode,
    publicMessage: string,
    options?: { cause?: unknown; details?: Record<string, unknown> },
  ) {
    super(`${code}: ${publicMessage}`, options?.cause ? { cause: options.cause } : undefined);
    this.name = 'AuralisError';
    this.code = code;
    this.publicMessage = publicMessage;
    this.details = Object.freeze({ ...(options?.details ?? {}) });
  }

  get httpStatus(): number {
    return STATUS_BY_CODE[this.code];
  }

  toPublicJSON(correlationId: string): {
    error: {
      code: ErrorCode;
      message: string;
      details: Record<string, unknown>;
      correlationId: string;
    };
  } {
    return {
      error: {
        code: this.code,
        message: this.publicMessage,
        details: { ...this.details },
        correlationId,
      },
    };
  }
}

export function httpStatusForCode(code: ErrorCode): number {
  return STATUS_BY_CODE[code];
}

export function isAuralisError(value: unknown): value is AuralisError {
  return value instanceof AuralisError;
}

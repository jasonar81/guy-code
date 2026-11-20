/**
 * Protocol errors, shaped for the HTTP+JSON binding.
 *
 * v1.0 maps A2A errors onto google.rpc.Status with an ErrorInfo detail whose
 * `reason` carries the A2A error name. Peers (including the Claude Code
 * daemon) key off `reason`, so keep those strings stable.
 */
import type { A2AErrorBody } from './types';

const STATUS_NAME: Record<number, string> = {
  400: 'INVALID_ARGUMENT',
  401: 'UNAUTHENTICATED',
  403: 'PERMISSION_DENIED',
  404: 'NOT_FOUND',
  409: 'FAILED_PRECONDITION',
  413: 'RESOURCE_EXHAUSTED',
  415: 'INVALID_ARGUMENT',
  429: 'RESOURCE_EXHAUSTED',
  500: 'INTERNAL',
  501: 'UNIMPLEMENTED',
};

export class A2AProtocolError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly reason: string,
    message: string
  ) {
    super(message);
    this.name = 'A2AProtocolError';
  }

  toBody(): A2AErrorBody {
    return {
      error: {
        code: this.httpStatus,
        status: STATUS_NAME[this.httpStatus] ?? 'UNKNOWN',
        message: this.message,
        details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: this.reason, domain: 'a2a-protocol.org' }],
      },
    };
  }
}

export const errors = {
  badRequest: (msg: string) => new A2AProtocolError(400, 'INVALID_REQUEST', msg),
  unauthenticated: () => new A2AProtocolError(401, 'UNAUTHENTICATED', 'Missing or unknown peer token. Pair with this agent first.'),
  blocked: () => new A2AProtocolError(403, 'PERMISSION_DENIED', 'This peer is blocked.'),
  notAllowed: () => new A2AProtocolError(403, 'PERMISSION_DENIED', 'Source address is not in the allow-list.'),
  notFound: (msg = 'Not found.') => new A2AProtocolError(404, 'NOT_FOUND', msg),
  taskNotFound: (id: string) => new A2AProtocolError(404, 'TASK_NOT_FOUND', `Task ${id} not found.`),
  taskNotCancelable: (id: string) => new A2AProtocolError(409, 'TASK_NOT_CANCELABLE', `Task ${id} is already in a terminal state.`),
  unsupportedOperation: (msg: string) => new A2AProtocolError(400, 'UNSUPPORTED_OPERATION', msg),
  contentType: () => new A2AProtocolError(415, 'CONTENT_TYPE_NOT_SUPPORTED', 'Use application/a2a+json or application/json.'),
  tooLarge: (max: number) => new A2AProtocolError(413, 'PAYLOAD_TOO_LARGE', `Request body exceeds ${max} bytes.`),
  rateLimited: () => new A2AProtocolError(429, 'RATE_LIMITED', 'Too many requests from this peer; slow down.'),
  version: (got: string) =>
    new A2AProtocolError(
      400,
      'VERSION_NOT_SUPPORTED',
      got
        ? `A2A-Version ${got} is not supported; this agent speaks 1.0 only.`
        : 'Missing A2A-Version header, which means 0.3 per the spec; this agent speaks 1.0 only. Send "A2A-Version: 1.0".'
    ),
  unimplemented: (msg: string) => new A2AProtocolError(501, 'UNIMPLEMENTED', msg),
};

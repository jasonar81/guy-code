/**
 * A2A v1.0 wire types, hand-written from `a2aproject/A2A` `specification/a2a.proto`.
 *
 * Only what Guy Code uses. The proto is snake_case but the spec requires every
 * JSON serialisation to be camelCase, so field names here are the converted
 * form (`task_push_notification_config` -> `taskPushNotificationConfig`). See
 * docs/a2a/DESIGN.md section 12a, which overrides the older spelling in
 * sections 5-7 (for example there is no `pushNotificationConfig` and the card
 * uses `securityRequirements`, not `security`).
 *
 * Nothing in this file imports Electron or the DB, so the shared protocol code
 * can later be vendored into the Claude Code daemon (design Q6).
 */

/** The protocol version we speak and send in the `A2A-Version` header. */
export const A2A_PROTOCOL_VERSION = '1.0';

/** Media type for request and response bodies in the HTTP+JSON binding. */
export const A2A_CONTENT_TYPE = 'application/a2a+json';

/** Extension URIs we declare in the card (design 5.1, 5.4, 5.5). */
export const EXT_ROUTING = 'https://ocient.dev/a2a/ext/routing/v1';
export const EXT_PAIRING = 'https://ocient.dev/a2a/ext/pairing/v1';
/**
 * Notify-on-condition (design 5.5): the receiving agent can install a check
 * command its own runtime polls at no model cost (`electron/a2a/watch.ts`).
 */
export const EXT_WATCH = 'https://ocient.dev/a2a/ext/watch/v1';

/** Metadata key for the routing extension payload (design 5.4). */
export const ROUTING_METADATA_KEY = 'ocient.routing';

/**
 * Metadata key for the watch extension payload (design 5.5). The requester
 * may put `{ suggestion: "<text>" }` here. It is TEXT for the receiving
 * model and user to read; no field of it is ever executed.
 */
export const WATCH_METADATA_KEY = 'ocient.watch';

export type Role = 'ROLE_UNSPECIFIED' | 'ROLE_USER' | 'ROLE_AGENT';

export type TaskState =
  | 'TASK_STATE_UNSPECIFIED'
  | 'TASK_STATE_SUBMITTED'
  | 'TASK_STATE_WORKING'
  | 'TASK_STATE_INPUT_REQUIRED'
  | 'TASK_STATE_AUTH_REQUIRED'
  | 'TASK_STATE_COMPLETED'
  | 'TASK_STATE_FAILED'
  | 'TASK_STATE_CANCELED'
  | 'TASK_STATE_REJECTED';

export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set<TaskState>([
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_REJECTED',
]);

/**
 * A v1.0 Part is a flat oneof: exactly one of `text`, `raw`, `url`, `data`,
 * plus optional `mediaType` / `filename` / `metadata`. We accept only `text`
 * and `data` (design 4.2.6: file parts are rejected in v1), but the other
 * fields are typed so the server can recognise and refuse them.
 */
export interface Part {
  text?: string;
  data?: unknown;
  /** base64 bytes. Rejected inbound. */
  raw?: string;
  /** File by reference. Rejected inbound. */
  url?: string;
  /** Pre-1.0 FilePart shape. Rejected inbound so an older client gets a clear error. */
  file?: unknown;
  filename?: string;
  mediaType?: string;
  metadata?: Record<string, unknown>;
}

export interface Message {
  messageId: string;
  contextId?: string;
  taskId?: string;
  role: Role;
  parts: Part[];
  metadata?: Record<string, unknown>;
  extensions?: string[];
  referenceTaskIds?: string[];
}

/** proto `AuthenticationInfo`. */
export interface AuthenticationInfo {
  scheme: string;
  credentials?: string;
}

/**
 * proto `TaskPushNotificationConfig`. FLAT in v1.0 (design 12a item 2): the
 * url / token / authentication live directly on it, not on a nested
 * `pushNotificationConfig`. `tenant` stays unset (we are single-tenant).
 *
 * The requester sends it inline in SendMessageConfiguration. We leave
 * uthentication.credentials unset: see push.ts for why the receiver uses
 * the peer bearer token it already holds instead.
 */
export interface TaskPushNotificationConfig {
  tenant?: string;
  id?: string;
  taskId?: string;
  url: string;
  token?: string;
  authentication?: AuthenticationInfo;
}

export interface SendMessageConfiguration {
  acceptedOutputModes?: string[];
  historyLength?: number;
  /** We always send true: agents take minutes to hours, blocking HTTP is wrong. */
  returnImmediately?: boolean;
  taskPushNotificationConfig?: TaskPushNotificationConfig;
}

export interface SendMessageRequest {
  tenant?: string;
  message: Message;
  configuration?: SendMessageConfiguration;
  metadata?: Record<string, unknown>;
}

export interface TaskStatus {
  state: TaskState;
  message?: Message;
  /** ISO 8601. */
  timestamp?: string;
}

export interface Artifact {
  artifactId: string;
  name?: string;
  description?: string;
  parts: Part[];
  metadata?: Record<string, unknown>;
}

export interface Task {
  id: string;
  contextId: string;
  status: TaskStatus;
  artifacts?: Artifact[];
  history?: Message[];
  metadata?: Record<string, unknown>;
}

/**
 * proto `StreamResponse`: the body of a push notification. Exactly one field
 * is set. We send `task` (a full snapshot) for state changes and `message`
 * for a new agent message on a task; we accept all four.
 */
export interface StreamResponse {
  task?: Task;
  message?: Message;
  statusUpdate?: { taskId: string; contextId?: string; status: TaskStatus; metadata?: Record<string, unknown> };
  artifactUpdate?: { taskId: string; contextId?: string; artifact: Artifact; append?: boolean; lastChunk?: boolean };
}

/** proto `ListTasksResponse` (GET /tasks). */
export interface ListTasksResponse {
  tasks: Task[];
  nextPageToken: string;
  pageSize: number;
  totalSize: number;
}

/** Header carrying the per-task push token (A2A push notification spec). */
export const PUSH_TOKEN_HEADER = 'X-A2A-Notification-Token';

/** proto `SendMessageResponse`: a oneof of task or message. We always return a task. */
export interface SendMessageResponse {
  task?: Task;
  message?: Message;
}

// ---- Agent card --------------------------------------------------------

export interface AgentInterface {
  url: string;
  protocolBinding: 'HTTP+JSON' | 'JSONRPC' | 'GRPC' | string;
  protocolVersion: string;
  /** Left unset: single-tenant. Must match push-config tenant when set. */
  tenant?: string;
}

export interface AgentExtension {
  uri: string;
  description?: string;
  required?: boolean;
  params?: Record<string, unknown>;
}

export interface AgentCapabilities {
  streaming?: boolean;
  pushNotifications?: boolean;
  extensions?: AgentExtension[];
  extendedAgentCard?: boolean;
}

export interface SecurityScheme {
  httpAuthSecurityScheme?: { scheme: string; bearerFormat?: string; description?: string };
}

/** proto `SecurityRequirement { map<string, StringList> schemes }`. */
export interface SecurityRequirement {
  schemes: Record<string, { list: string[] }>;
}

export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples?: string[];
}

export interface AgentCard {
  name: string;
  description: string;
  supportedInterfaces: AgentInterface[];
  provider?: { organization: string; url: string };
  version: string;
  capabilities: AgentCapabilities;
  securitySchemes?: Record<string, SecurityScheme>;
  securityRequirements?: SecurityRequirement[];
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: AgentSkill[];
}

// ---- Our extensions ------------------------------------------------------

/** `message.metadata["ocient.routing"]` (design 5.4). Every field is optional and untrusted. */
export interface RoutingInfo {
  fromUser?: string;
  fromAgent?: string;
  fromSessionLabel?: string;
  fromProject?: string;
  toSession?: string;
  toProject?: string;
  replyContextId?: string;
}

/** `message.metadata["ocient.watch"]` (design 5.5). Untrusted; `suggestion` is display text only. */
export interface WatchSuggestionInfo {
  suggestion?: string;
}

/** `metadata.kind` (design 5.2). Drives gating: request / notify from an inform peer wait for approval. */
export type MessageKind = 'inform' | 'request' | 'notify';

/** Trust levels, strictly ordered blocked < inform < collaborate < full (design 4.2.3). */
export type TrustLevel = 'blocked' | 'inform' | 'collaborate' | 'full';
export const TRUST_ORDER: readonly TrustLevel[] = ['blocked', 'inform', 'collaborate', 'full'];
export function trustAtLeast(have: TrustLevel, need: TrustLevel): boolean {
  return TRUST_ORDER.indexOf(have) >= TRUST_ORDER.indexOf(need);
}
export function isTrustLevel(v: unknown): v is TrustLevel {
  return typeof v === 'string' && (TRUST_ORDER as readonly string[]).includes(v);
}

export type AgentKind = 'guycode' | 'claude-code' | 'other';

/** Body of `POST /a2a-pair` (design 4.3 step 3). */
export interface PairRequest {
  inviteId: string;
  inviteSecret: string;
  myCardUrl: string;
  myCertSha256: string;
  myDisplayName: string;
  myAgentKind?: AgentKind;
  tokenForYouToCallMe: string;
  /**
   * Our certificate PEM (relay, design 11a). Must hash to myCertSha256.
   * Optional so peers on an older build can still pair (they just cannot use
   * the relay until both sides send it).
   */
  myCertPem?: string;
}

export interface PairResponse {
  tokenForMeToCallYou: string;
  displayName: string;
  agentKind: AgentKind;
  /** The inviter's certificate PEM (relay, design 11a). Must hash to the code's certSha256. */
  certPem?: string;
}

/** Decoded `a2a1:` pairing code (design 4.3 step 1). */
export interface PairingCodePayload {
  cardUrl: string;
  certSha256: string;
  inviteId: string;
  inviteSecret: string;
  /** epoch ms */
  expires: number;
  displayName: string;
  /**
   * Relay (design 11a): the relay the inviter is connected to, and the
   * inviter's certificate public key (base64url SPKI DER). With these a
   * redeemer that cannot reach `cardUrl` - or whose cardUrl is
   * relay://<fingerprint> because the inviter does not listen at all - can
   * seal the pairing request to the inviter through the relay. Absent in
   * codes from builds without relay support.
   */
  relayUrl?: string;
  relayKey?: string;
}

/**
 * HTTP+JSON error body. v1.0 maps errors onto google.rpc.Status with an
 * ErrorInfo detail whose `reason` names the A2A error (TASK_NOT_FOUND, ...).
 */
export interface A2AErrorBody {
  error: {
    code: number;
    status: string;
    message: string;
    details?: Array<{ '@type': string; reason: string; domain: string; metadata?: Record<string, string> }>;
  };
}

# A2A relay

An **untrusted**, dial-out relay for A2A agents on networks where peers cannot
reach each other (docs/a2a/DESIGN.md §11a). On a Fortinet SSL VPN every laptop
gets a /32 and the gateway forwards only connections the laptop opened, so two
laptops can never connect directly. Both instead hold one outbound connection
to this relay.

Standalone Node >= 20 service. **Zero runtime dependencies**, no Electron,
nothing imported from `electron/`.

## What it can and cannot see

Payloads are end-to-end encrypted by the agents (`electron/a2a/relayCrypto.ts`:
ECDH between the paired certificates -> HKDF -> AES-256-GCM). The relay accepts
exactly `{to, from, msgId, iv, ct, tag}` and rejects any other field. It never
decodes, parses or logs `ct`, `iv` or `tag`.

What it **can** observe, unavoidably (state this plainly to users):

- which certificate fingerprints are connected, from which source IP, and when;
- who sends to whom, when, how often, and the ciphertext size (≈ plaintext size);
- `msgId` values (chosen by the sender - clients should make them random);
- reply timing (roughly how long a peer took to answer);
- each agent's certificate (presented at login), including its subject CN.

Logs record only events, 12-char fingerprint prefixes, the first 16 chars of a
msgId, byte counts and source IPs. journald owns retention (see below).

Known limitations (v1):

- **Not forward secret** (the agents' crypto, §11a). A stolen cert key exposes past traffic.
- **In-memory queue.** A relay restart loses queued mail without telling senders;
  the agents' own 24h outbox retry covers it. Not persisting also means the
  relay's disk never holds ciphertext.
- Delivery of envelopes is at-least-once (redelivered if a stream dies before
  the reply); recipients dedupe by `msgId`.

## Protocol (v1)

All connections are opened by the agent.

| route | auth | purpose |
|---|---|---|
| `GET /relay/v1/health` | none | `{ok, version, uptimeS, streams, agents, queued, inflight}` - counts only |
| `GET /relay/v1/stream` | none (then proof) | Server-Sent Events, relay -> agent |
| `POST /relay/v1/auth` | proof | `{streamId, fingerprint, certPem, signature}` -> `{session}` |
| `POST /relay/v1/send` | `Bearer <session>` | envelope; response is the peer's reply |
| `POST /relay/v1/reply` | `Bearer <session>` | the reply envelope for a received `msgId` |

1. Open the stream. First event: `challenge {streamId, nonce}`.
2. Sign `"a2a-relay-auth-v1\n" + nonce` (ECDSA-SHA256, the cert's P-256 key,
   DER signature, base64) and POST `/relay/v1/auth` within 10s. The relay checks
   `sha256(cert DER) == fingerprint` and the signature against the key in that
   cert. Failure closes the stream (one guess per nonce). Success: `{session}`,
   then event `ready`, then any queued mail. A newer authenticated stream for the
   same identity replaces the old one (event `replaced`).
3. `POST /relay/v1/send` `{to, from, msgId, iv, ct, tag}` (`from` must equal
   the proven fingerprint):
   - `200 {status:'delivered', reply}` - recipient answered within 25s;
   - `202 {status:'awaiting_reply'}` - delivered; reply arrives later as event `reply`;
   - `202 {status:'queued'}` - recipient offline; delivered when it reconnects.
4. Recipient gets event `envelope` and must POST `/relay/v1/reply` with the same `msgId`.
5. Anything dropped (24h TTL, or a delivered message never answered within 24h)
   is logged and reported to the sender as event `dropped {msgId, to, reason}`
   (held for the sender if it is offline).

Errors are `{error: {code, message}}`:

| status | code | when |
|---|---|---|
| 400 | `bad_envelope` / `bad_json` | malformed, or any field beyond the six |
| 401 | `unauthenticated` / `auth_failed` | no/stale session; bad proof |
| 403 | `wrong_sender` | `from` is not your proven identity |
| 409 | `duplicate_msg_id` | same `msgId` from you already pending |
| 413 | `too_large` | body > 512 KiB |
| 429 | `rate_limited` | > 300 sends/min per agent, or > 30 connects/min per IP |
| 503 | `too_many_streams` | > 500 concurrent streams |
| 507 | `queue_full` / `relay_full` | > 200 pending for that recipient, or 20 000 total |

Limits are constructor options (`RelayLimits` in `src/server.ts`).

## Configuration (environment)

| var | default | |
|---|---|---|
| `RELAY_HOST` | `0.0.0.0` | bind address |
| `RELAY_PORT` | `7429` | (7427 = Guy Code, 7428 = Claude Code plugin) |
| `RELAY_TLS_CERT` / `RELAY_TLS_KEY` | unset | PEM paths; set both to serve HTTPS |

Payloads are safe over plain HTTP, but session tokens and all metadata are
not - use TLS (or a TLS-terminating proxy that does not buffer
`text/event-stream`) for anything beyond a trial.

## Deploy on net1

```bash
# 1. Node >= 20 on the box
node -v

# 2. Service user and code (from a checkout of guy-code)
sudo useradd --system --home /opt/a2a-relay --shell /usr/sbin/nologin a2a-relay
sudo mkdir -p /opt/a2a-relay /etc/a2a-relay
sudo cp -r relay/package.json relay/tsconfig.json relay/src /opt/a2a-relay/
cd /opt/a2a-relay
sudo npm install --no-audit --no-fund      # dev deps only: typescript + @types/node
sudo npm run build                         # -> /opt/a2a-relay/dist/main.js
sudo chown -R root:root /opt/a2a-relay

# 3. Optional TLS (self-signed is fine: agents will pin the relay like a peer in step 3)
sudo openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 825 \
  -subj "/CN=net1-a2a-relay" -keyout /etc/a2a-relay/key.pem -out /etc/a2a-relay/cert.pem
sudo chown root:a2a-relay /etc/a2a-relay/*.pem && sudo chmod 640 /etc/a2a-relay/*.pem

# 4. Install the unit below, then
sudo systemctl daemon-reload
sudo systemctl enable --now a2a-relay
curl -sk https://localhost:7429/relay/v1/health     # http:// if no TLS
journalctl -u a2a-relay -f

# 5. Open the port to the VPN range only (example: firewalld)
sudo firewall-cmd --permanent --add-rich-rule='rule family=ipv4 source address=10.0.0.0/8 port port=7429 protocol=tcp accept'
sudo firewall-cmd --reload
```

`/etc/systemd/system/a2a-relay.service`:

```ini
[Unit]
Description=A2A relay (untrusted dial-out relay for A2A agents)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=a2a-relay
Group=a2a-relay
WorkingDirectory=/opt/a2a-relay
Environment=NODE_ENV=production
Environment=RELAY_HOST=0.0.0.0
Environment=RELAY_PORT=7429
Environment=RELAY_TLS_CERT=/etc/a2a-relay/cert.pem
Environment=RELAY_TLS_KEY=/etc/a2a-relay/key.pem
ExecStart=/usr/bin/env node /opt/a2a-relay/dist/main.js
Restart=on-failure
RestartSec=2
KillSignal=SIGTERM
TimeoutStopSec=10
LimitNOFILE=4096
# Hardening: no disk writes needed (in-memory queue, logs to journald)
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6
RestrictNamespaces=true
LockPersonality=true
MemoryDenyWriteExecute=false
SystemCallArchitectures=native
CapabilityBoundingSet=

[Install]
WantedBy=multi-user.target
```

(`MemoryDenyWriteExecute` must stay off: V8's JIT needs W+X pages. If `node`
is not on systemd's PATH, replace `/usr/bin/env node` with its absolute path.)

Log retention: logs go to journald. To keep metadata short-lived, cap it, e.g.
in `/etc/systemd/journald.conf`: `MaxRetentionSec=7day`, or run the unit with
`LogNamespace=a2a-relay` and a per-namespace retention.

Upgrade: copy the new `src/`, `npm run build`, `sudo systemctl restart a2a-relay`
(queued mail is lost on restart - see limitations).

## Development

Tests live in the repo root: `npx vitest run tests/relay` (in-process, ephemeral
ports). Typecheck: `cd relay && npx tsc --noEmit -p tsconfig.json` (uses the
root `node_modules` when run inside the repo).

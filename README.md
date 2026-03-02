
<img width="100" height="32" alt="meza-repo" src="https://github.com/user-attachments/assets/07b3182c-e2a8-4662-8e49-f5b9b1990e3a" />

End-to-end encrypted, real-time chat platform. Self-hostable with Docker Compose.

[![CI](https://github.com/mezalabs/meza/actions/workflows/ci.yml/badge.svg)](https://github.com/mezalabs/meza/actions/workflows/ci.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)
[![Go](https://img.shields.io/badge/Go-1.24-00ADD8.svg)](https://go.dev/)
[![Node](https://img.shields.io/badge/Node.js-22-339933.svg)](https://nodejs.org/)

## Features

- **End-to-end encryption by design** — all channels (public, private, DMs) are encrypted. No plaintext mode.
- **Real-time messaging** — WebSocket gateway with sharded connections (~5k per shard)
- **Voice and video** — LiveKit WebRTC integration
- **File sharing** — S3-compatible storage with thumbnails and image processing
- **Metadata search** — Channel-scoped message filtering by author, date, attachments, and mentions
- **Federation** — Cross-instance communication via signed JWT assertions
- **Tiling window manager UI** — i3/sway-inspired pane layout, no traditional page routing
- **Self-hostable** — Docker Compose for development, production-ready with standard infrastructure

## Architecture

Eight Go microservices communicating via NATS, with a TypeScript/React frontend connected through ConnectRPC (Protobuf-generated clients for both Go and TypeScript).

| Service | Port | Responsibility |
|---------|------|----------------|
| Gateway | 8080 | WebSocket connections, NATS routing, sharding |
| Auth | 8081 | Registration, login, JWT, Argon2id passwords, devices |
| Chat | 8082 | Messages, channels, servers, roles, invites, DMs, reactions, pins |
| Presence | 8083 | Online/offline/idle/DND status, typing indicators |
| Media | 8084 | File upload/download, S3 storage, thumbnails |
| Voice | 8085 | LiveKit room management, WebRTC tokens |
| Notification | 8086 | Web Push (VAPID), notification preferences |
| Keys | 8088 | E2EE public keys, channel key envelopes |

**Data stores:** PostgreSQL (relational), ScyllaDB (messages), Redis (presence, sessions, rate limits)

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full system design.

## Quick Start

### Prerequisites

- [Go](https://go.dev/) 1.24+
- [Node.js](https://nodejs.org/) 22+ (see `.nvmrc`)
- [pnpm](https://pnpm.io/) 9+
- [Docker](https://www.docker.com/) and Docker Compose
- [Task](https://taskfile.dev/) (task runner)
- [buf](https://buf.build/) CLI (for protobuf code generation)

### Setup

```bash
git clone https://github.com/meza-chat/meza.git
cd meza
cp .env.example .env
task start
```

This starts all infrastructure (Postgres, ScyllaDB, Redis, NATS, MinIO, LiveKit), runs migrations, and launches all services + the Vite dev server. The app is available at `http://localhost:4080`.

On first run, initialize the database:

```bash
task migrate --force
```

### Commands

| Command | Description |
|---------|-------------|
| `task start` | Start infrastructure + all services + Vite dev server |
| `task up` | Start infrastructure only (Docker) |
| `task migrate` | Run all database migrations |
| `task test` | Run all tests (Go + TypeScript) |
| `task test:e2e:smoke` | Quick E2E smoke test |
| `task teardown` | Stop everything |
| `task status` | Show running services and ports |

## Development

### Running Tests

```bash
task test                # All tests
task test:server         # Go backend
task test:client         # TypeScript frontend
task test:quick          # Fast unit tests only
task test:e2e:smoke      # E2E smoke test (requires running services)
task test:e2e            # Full E2E suite (5 journey tests)
```

Run a single Go test:

```bash
cd server && go test -v -run TestFunctionName ./cmd/auth/...
```

### Code Generation

After editing `.proto` files:

```bash
cd proto && buf generate
```

This regenerates `server/gen/` and `client/gen/`. Never edit generated code directly.

### Project Structure

```
meza/
├── proto/            # Protobuf API definitions (source of truth)
├── server/           # Go backend services
│   ├── cmd/          # Service entry points (8 services)
│   ├── internal/     # Shared packages (auth, config, db, store, models)
│   └── gen/          # Generated ConnectRPC Go code
├── client/           # TypeScript frontend (pnpm workspace)
│   ├── packages/
│   │   ├── core/     # Platform-agnostic: API clients, Zustand stores, gateway
│   │   ├── ui/       # React components
│   │   └── web/      # Browser SPA entry point (Vite)
│   └── gen/          # Generated ConnectRPC TypeScript code
├── deploy/           # Docker Compose for development
├── docs/             # Architecture and API documentation
└── scripts/          # Development and release scripts
```

### Git Worktrees

The Taskfile is worktree-aware. Each worktree gets isolated Docker infrastructure, so you can work on multiple branches simultaneously without conflicts.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup instructions, code style, and PR guidelines.

## Security

For security vulnerabilities, see [SECURITY.md](SECURITY.md). Do not open public issues for security reports.

## License

[AGPL-3.0](LICENSE)

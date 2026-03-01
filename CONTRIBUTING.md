# Contributing to Meza

Thank you for your interest in contributing to Meza. This guide covers how to set up the project, run tests, and submit changes.

## Prerequisites

- [Go](https://go.dev/) 1.24+
- [Node.js](https://nodejs.org/) 22+ (see `.nvmrc`)
- [pnpm](https://pnpm.io/) 9+
- [Docker](https://www.docker.com/) and Docker Compose
- [Task](https://taskfile.dev/) (task runner)
- [buf](https://buf.build/) CLI (for protobuf code generation)

## Getting Started

```bash
git clone https://github.com/meza-chat/meza.git
cd meza
cp .env.example .env
task start
```

This starts all infrastructure (Postgres, ScyllaDB, Redis, NATS, MinIO, LiveKit), runs migrations, and launches all Go services + the Vite dev server. The app will be available at `http://localhost:4080`.

## Running Tests

```bash
# All tests
task test

# Go backend only
task test:server

# TypeScript frontend only
task test:client

# Quick unit tests (no integration)
task test:quick

# E2E smoke test (requires running services)
task test:e2e:smoke

# Full E2E suite
task test:e2e
```

To run a single Go test:

```bash
cd server && go test -v -run TestFunctionName ./cmd/auth/...
```

## Code Style

- **Go**: `gofmt` (standard formatting), structured `slog` logging, ConnectRPC error codes
- **TypeScript**: [Biome](https://biomejs.dev/) — 2-space indent, single quotes, trailing commas
- **Protobuf**: `buf lint`

Run linting before submitting:

```bash
cd client && pnpm lint        # Biome check
cd client && pnpm check       # TypeScript type checking
cd proto && buf lint           # Protobuf linting
```

## Making Changes

1. Fork the repository and create a branch from `main`
2. Make your changes, following existing patterns in the codebase
3. Add or update tests for your changes
4. Run `task test:e2e:smoke` before pushing
5. Open a pull request against `main`

## Pull Request Guidelines

- Keep PRs focused — one feature or fix per PR
- Include a clear description of what changed and why
- Ensure all CI checks pass
- Add tests for new functionality
- Update documentation if your change affects public APIs or architecture

## Code Generation

If you modify `.proto` files in `proto/meza/v1/`:

```bash
cd proto && buf generate
```

This regenerates `server/gen/` and `client/gen/`. Never edit generated code directly.

## Architecture

See `docs/ARCHITECTURE.md` for a detailed overview of the system design, service responsibilities, and data flow.

## Reporting Issues

- Use [GitHub Issues](https://github.com/meza-chat/meza/issues) for bug reports and feature requests
- For security vulnerabilities, see [SECURITY.md](SECURITY.md)

package migrations

import "embed"

// PostgresFS embeds all .sql files (both .up.sql and .down.sql).
// The migration runner filters by suffix at runtime, executing only .up.sql files.
//
//go:embed *.sql
var PostgresFS embed.FS

// ScyllaFS embeds all .cql files from the scylla/ subdirectory.
//
//go:embed scylla/*.cql
var ScyllaFS embed.FS

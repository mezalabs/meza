package main

import (
	"testing"
	"testing/fstest"

	"github.com/gocql/gocql"
)

func TestParseMigrationFile(t *testing.T) {
	tests := []struct {
		filename string
		suffix   string
		version  uint64
		name     string
		wantErr  bool
	}{
		{"0_initial_schema.up.sql", ".up.sql", 0, "initial_schema", false},
		{"1740000000_add_feature.up.sql", ".up.sql", 1740000000, "add_feature", false},
		{"1740000000_add_feature.down.sql", ".down.sql", 1740000000, "add_feature", false},
		{"0_initial_schema.cql", ".cql", 0, "initial_schema", false},
		{"42_simple.up.sql", ".up.sql", 42, "simple", false},

		// Error cases.
		{"no_underscore.up.sql", ".up.sql", 0, "", true},    // Version is not numeric.
		{"abc_name.up.sql", ".up.sql", 0, "", true},          // Non-numeric version.
		{"123_.up.sql", ".up.sql", 0, "", true},               // Empty name.
	}

	for _, tt := range tests {
		t.Run(tt.filename, func(t *testing.T) {
			version, name, err := parseMigrationFile(tt.filename, tt.suffix)
			if tt.wantErr {
				if err == nil {
					t.Errorf("expected error for %q, got version=%d name=%q", tt.filename, version, name)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error for %q: %v", tt.filename, err)
			}
			if version != tt.version {
				t.Errorf("version = %d, want %d", version, tt.version)
			}
			if name != tt.name {
				t.Errorf("name = %q, want %q", name, tt.name)
			}
		})
	}
}

func TestSplitCQL(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  int // number of statements
	}{
		{
			name:  "single statement",
			input: "CREATE TABLE IF NOT EXISTS foo (id TEXT PRIMARY KEY);",
			want:  1,
		},
		{
			name:  "multiple statements",
			input: "CREATE KEYSPACE IF NOT EXISTS ks;\nCREATE TABLE IF NOT EXISTS ks.t (id TEXT PRIMARY KEY);",
			want:  2,
		},
		{
			name:  "with dash-dash comments",
			input: "-- This is a comment\nCREATE TABLE IF NOT EXISTS foo (id TEXT PRIMARY KEY);",
			want:  1,
		},
		{
			name:  "with slash-slash comments",
			input: "// This is a comment\nCREATE TABLE IF NOT EXISTS foo (id TEXT PRIMARY KEY);",
			want:  1,
		},
		{
			name:  "empty input",
			input: "",
			want:  0,
		},
		{
			name:  "only comments",
			input: "-- comment 1\n// comment 2\n",
			want:  0,
		},
		{
			name:  "trailing semicolons",
			input: "SELECT 1;\n;\n",
			want:  1,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := splitCQL(tt.input)
			if len(got) != tt.want {
				t.Errorf("splitCQL() returned %d statements, want %d; got: %v", len(got), tt.want, got)
			}
		})
	}
}

func TestIsIdempotentSchemaErr(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want bool
	}{
		{"nil error", nil, false},
		{"typed gocql AlreadyExists", &gocql.RequestErrAlreadyExists{}, true},
		{"already exists", errStr("Column already exists"), true},
		{"conflicts with existing", errStr("conflicts with an existing column"), true},
		{"unrelated error", errStr("connection refused"), false},
		{"already exist lowercase", errStr("keyspace already exist"), true},
		{"column not found in table", errStr("was not found in table"), true},
		{"column not found in column", errStr("was not found in column"), true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := isIdempotentSchemaErr(tt.err); got != tt.want {
				t.Errorf("isIdempotentSchemaErr(%v) = %v, want %v", tt.err, got, tt.want)
			}
		})
	}
}

// errStr is a simple error type for testing.
type errStr string

func (e errStr) Error() string { return string(e) }

func TestReadUpMigrationsFiltering(t *testing.T) {
	// Create an in-memory FS with both .up.sql and .down.sql files.
	fsys := fstest.MapFS{
		"0_initial.up.sql":            {Data: []byte("CREATE TABLE IF NOT EXISTS t (id TEXT PRIMARY KEY);")},
		"0_initial.down.sql":          {Data: []byte("DROP TABLE IF EXISTS t;")},
		"1740000000_feature.up.sql":   {Data: []byte("ALTER TABLE t ADD COLUMN IF NOT EXISTS x TEXT;")},
		"1740000000_feature.down.sql": {Data: []byte("ALTER TABLE t DROP COLUMN IF EXISTS x;")},
		"README.md":                   {Data: []byte("not a migration")},
	}

	files, err := readUpMigrations(fsys, ".")
	if err != nil {
		t.Fatalf("readUpMigrations() error: %v", err)
	}

	if len(files) != 2 {
		t.Fatalf("got %d files, want 2; files: %+v", len(files), files)
	}

	// Verify sort order: version 0 before 1740000000.
	if files[0].version != 0 {
		t.Errorf("first file version = %d, want 0", files[0].version)
	}
	if files[1].version != 1740000000 {
		t.Errorf("second file version = %d, want 1740000000", files[1].version)
	}

	// Verify no .down.sql content leaked in.
	for _, f := range files {
		if f.name == "" {
			t.Error("file has empty name")
		}
		if len(f.content) == 0 {
			t.Errorf("file %s has empty content", f.name)
		}
	}
}

func TestReadUpMigrationsNumericSort(t *testing.T) {
	// Verify that numeric sorting works correctly (not lexicographic).
	// Lexicographic: "10_" < "2_" — wrong. Numeric: 2 < 10 — correct.
	fsys := fstest.MapFS{
		"2_second.up.sql":  {Data: []byte("SELECT 2;")},
		"10_tenth.up.sql":  {Data: []byte("SELECT 10;")},
		"1_first.up.sql":   {Data: []byte("SELECT 1;")},
	}

	files, err := readUpMigrations(fsys, ".")
	if err != nil {
		t.Fatalf("readUpMigrations() error: %v", err)
	}

	if len(files) != 3 {
		t.Fatalf("got %d files, want 3", len(files))
	}

	expected := []uint64{1, 2, 10}
	for i, want := range expected {
		if files[i].version != want {
			t.Errorf("files[%d].version = %d, want %d", i, files[i].version, want)
		}
	}
}

func TestCheckDuplicateVersions(t *testing.T) {
	t.Run("no duplicates", func(t *testing.T) {
		files := []migrationFile{
			{version: 0, name: "initial"},
			{version: 1, name: "second"},
			{version: 2, name: "third"},
		}
		if err := checkDuplicateVersions(files); err != nil {
			t.Errorf("unexpected error: %v", err)
		}
	})

	t.Run("with duplicates", func(t *testing.T) {
		files := []migrationFile{
			{version: 0, name: "initial"},
			{version: 1, name: "first"},
			{version: 1, name: "also_first"},
		}
		err := checkDuplicateVersions(files)
		if err == nil {
			t.Fatal("expected error for duplicate versions")
		}
		if got := err.Error(); got != "duplicate migration version 1: first and also_first" {
			t.Errorf("unexpected error message: %s", got)
		}
	})

	t.Run("empty list", func(t *testing.T) {
		if err := checkDuplicateVersions(nil); err != nil {
			t.Errorf("unexpected error for empty list: %v", err)
		}
	})

	t.Run("single file", func(t *testing.T) {
		files := []migrationFile{{version: 0, name: "initial"}}
		if err := checkDuplicateVersions(files); err != nil {
			t.Errorf("unexpected error for single file: %v", err)
		}
	})
}

func TestReadUpMigrationsDuplicateVersionDetection(t *testing.T) {
	fsys := fstest.MapFS{
		"1740000000_feature_a.up.sql": {Data: []byte("SELECT 1;")},
		"1740000000_feature_b.up.sql": {Data: []byte("SELECT 2;")},
	}

	_, err := readUpMigrations(fsys, ".")
	if err == nil {
		t.Fatal("expected error for duplicate versions")
	}
}

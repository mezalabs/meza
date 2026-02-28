-- Drop vestigial ratchet_header column (never populated by clients).
ALTER TABLE meza.messages DROP ratchet_header;

BEGIN;

-- Rollback: create_reports_tables
-- Drop child table first because of report_resolutions.report_id FK.

DROP TABLE IF EXISTS report_resolutions;
DROP TABLE IF EXISTS reports;

COMMIT;

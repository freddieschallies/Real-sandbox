-- Daily timesheets, made by the app from what it recorded (jobs, travel, work, pauses, and the time
-- not accounted for). The technician submits the previous day's; what he submitted is kept as it was.
ALTER TABLE timesheets ADD COLUMN sheet jsonb;
ALTER TABLE timesheets ADD COLUMN note text;
ALTER TABLE timesheets ADD COLUMN unaccounted_min integer;
CREATE TRIGGER timesheets_immutable BEFORE UPDATE OR DELETE ON timesheets FOR EACH ROW EXECUTE FUNCTION forbid_change();

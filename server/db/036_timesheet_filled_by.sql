-- A timesheet the technician did not submit can be filled in by the CEO, as the app made it. Who
-- filled it in is kept, so it never passes for one the technician submitted himself.
ALTER TABLE timesheets ADD COLUMN filled_by uuid REFERENCES users(id);

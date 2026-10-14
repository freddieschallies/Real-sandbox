-- Timesheets: office time the technician adds himself (meetings, getting ready, ...), trips the office
-- has allowed, the working hours (for after-hours trips), and per technician: whether his performance
-- shows on his monthly timesheet, and what an hour of him costs (blank: the company's labour rate).

CREATE TABLE timesheet_extra_time (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL DEFAULT current_company() REFERENCES companies(id),
  technician_id uuid NOT NULL REFERENCES users(id),
  work_date     date NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('meeting', 'getting_ready', 'office_work', 'training', 'driving_back', 'other')),
  started_at    timestamptz NOT NULL,
  minutes       integer NOT NULL CHECK (minutes BETWEEN 5 AND 600),
  note          text,
  added_by      uuid NOT NULL REFERENCES users(id),
  added_at      timestamptz NOT NULL DEFAULT now(),
  removed_at    timestamptz,
  removed_by    uuid REFERENCES users(id),
  removed_reason text,
  CHECK (kind <> 'other' OR length(coalesce(note, '')) >= 3)
);
CREATE INDEX timesheet_extra_time_day ON timesheet_extra_time (technician_id, work_date);
ALTER TABLE timesheet_extra_time ENABLE ROW LEVEL SECURITY;
ALTER TABLE timesheet_extra_time FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON timesheet_extra_time USING (company_id = current_company()) WITH CHECK (company_id = current_company());

CREATE TABLE trip_allowed (
  trip_id     uuid PRIMARY KEY REFERENCES trips(id),
  company_id  uuid NOT NULL DEFAULT current_company() REFERENCES companies(id),
  note        text NOT NULL CHECK (length(note) >= 3),
  allowed_by  uuid NOT NULL REFERENCES users(id),
  allowed_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE trip_allowed ENABLE ROW LEVEL SECURITY;
ALTER TABLE trip_allowed FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON trip_allowed USING (company_id = current_company()) WITH CHECK (company_id = current_company());

ALTER TABLE timesheet_settings
  ADD COLUMN work_start_min integer NOT NULL DEFAULT 420 CHECK (work_start_min BETWEEN 0 AND 1439),
  ADD COLUMN work_end_min   integer NOT NULL DEFAULT 1020 CHECK (work_end_min BETWEEN 1 AND 1440);

ALTER TABLE technician_settings
  ADD COLUMN show_performance    boolean NOT NULL DEFAULT false,
  ADD COLUMN cost_per_hour_cents integer CHECK (cost_per_hour_cents IS NULL OR cost_per_hour_cents >= 0);

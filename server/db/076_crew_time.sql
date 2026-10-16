-- Assistants and casual labour (no app): time not on a job (the yard, the workshop, loading), and the
-- office checking each person's week before it is paid.
CREATE TABLE crew_time (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL DEFAULT current_company() REFERENCES companies(id),
  member_id   uuid NOT NULL REFERENCES crew_members(id),
  work_date   date NOT NULL,
  minutes     integer NOT NULL CHECK (minutes BETWEEN 1 AND 1440),
  what        text NOT NULL CHECK (length(what) BETWEEN 2 AND 200),
  added_by    uuid NOT NULL REFERENCES users(id),
  added_at    timestamptz NOT NULL DEFAULT now(),
  removed_at  timestamptz,
  removed_by  uuid REFERENCES users(id)
);
CREATE INDEX crew_time_member_day ON crew_time (member_id, work_date) WHERE removed_at IS NULL;
ALTER TABLE crew_time ENABLE ROW LEVEL SECURITY;
ALTER TABLE crew_time FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON crew_time USING (company_id = current_company()) WITH CHECK (company_id = current_company());

CREATE TABLE crew_weeks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL DEFAULT current_company() REFERENCES companies(id),
  member_id   uuid NOT NULL REFERENCES crew_members(id),
  week_start  date NOT NULL,
  minutes     integer NOT NULL,
  checked_by  uuid NOT NULL REFERENCES users(id),
  checked_at  timestamptz NOT NULL DEFAULT now(),
  note        text
);
CREATE INDEX crew_weeks_member ON crew_weeks (member_id, week_start);
ALTER TABLE crew_weeks ENABLE ROW LEVEL SECURITY;
ALTER TABLE crew_weeks FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON crew_weeks USING (company_id = current_company()) WITH CHECK (company_id = current_company());

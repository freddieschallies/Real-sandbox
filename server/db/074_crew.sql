-- Assistants and casual labour: people who work with the technicians but have no login and no job
-- cards of their own. Who was on which job, which day; casual workers' pay.
CREATE TABLE crew_members (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL DEFAULT current_company() REFERENCES companies(id),
  full_name       text NOT NULL CHECK (length(full_name) BETWEEN 2 AND 120),
  phone           text,
  kind            text NOT NULL CHECK (kind IN ('assistant', 'casual')),
  day_rate_cents  integer CHECK (day_rate_cents IS NULL OR day_rate_cents >= 0),
  hour_rate_cents integer CHECK (hour_rate_cents IS NULL OR hour_rate_cents >= 0),
  note            text,
  active          boolean NOT NULL DEFAULT true,
  added_by        uuid NOT NULL REFERENCES users(id),
  added_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX crew_members_active ON crew_members (company_id, active);
ALTER TABLE crew_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE crew_members FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON crew_members USING (company_id = current_company()) WITH CHECK (company_id = current_company());

CREATE TABLE job_crew (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL DEFAULT current_company() REFERENCES companies(id),
  job_id          uuid NOT NULL REFERENCES jobs(id),
  member_id       uuid NOT NULL REFERENCES crew_members(id),
  visit_id        uuid REFERENCES job_visits(id),
  work_date       date NOT NULL,
  minutes         integer CHECK (minutes IS NULL OR minutes BETWEEN 0 AND 1440),   -- null: the technician's visit time
  source          text NOT NULL CHECK (source IN ('site', 'office')),
  note            text,
  added_by        uuid NOT NULL REFERENCES users(id),
  added_at        timestamptz NOT NULL DEFAULT now(),
  removed_at      timestamptz,
  removed_by      uuid REFERENCES users(id)
);
CREATE INDEX job_crew_job ON job_crew (job_id) WHERE removed_at IS NULL;
CREATE INDEX job_crew_member_day ON job_crew (member_id, work_date) WHERE removed_at IS NULL;
CREATE UNIQUE INDEX job_crew_once ON job_crew (job_id, member_id, work_date) WHERE removed_at IS NULL;
ALTER TABLE job_crew ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_crew FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON job_crew USING (company_id = current_company()) WITH CHECK (company_id = current_company());

CREATE TABLE crew_payments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL DEFAULT current_company() REFERENCES companies(id),
  member_id       uuid NOT NULL REFERENCES crew_members(id),
  period_from     date NOT NULL,
  period_to       date NOT NULL,
  days            integer NOT NULL,
  amount_cents    integer NOT NULL,
  paid_by         uuid NOT NULL REFERENCES users(id),
  paid_at         timestamptz NOT NULL DEFAULT now(),
  note            text
);
ALTER TABLE crew_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE crew_payments FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON crew_payments USING (company_id = current_company()) WITH CHECK (company_id = current_company());

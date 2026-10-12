-- The company's normal hours, for overtime: a weekday's normal hours, and Saturday's (0 = all
-- overtime). Sundays and public holidays are double time.
CREATE TABLE timesheet_settings (
  company_id          uuid PRIMARY KEY DEFAULT current_company() REFERENCES companies(id),
  weekday_normal_min  integer NOT NULL DEFAULT 480 CHECK (weekday_normal_min BETWEEN 60 AND 720),
  saturday_normal_min integer NOT NULL DEFAULT 0 CHECK (saturday_normal_min BETWEEN 0 AND 720),
  updated_by          uuid REFERENCES users(id),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE timesheet_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE timesheet_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON timesheet_settings USING (company_id = current_company()) WITH CHECK (company_id = current_company());

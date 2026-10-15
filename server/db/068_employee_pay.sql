-- What each employee is paid: seen and set only by Accounts and the CEO (and whoever the CEO switches it on for).
CREATE TABLE employee_pay (
  user_id           uuid PRIMARY KEY REFERENCES users(id),
  company_id        uuid NOT NULL DEFAULT current_company() REFERENCES companies(id),
  wage_per_hour_cents integer CHECK (wage_per_hour_cents IS NULL OR wage_per_hour_cents >= 0),
  salary_cents      integer CHECK (salary_cents IS NULL OR salary_cents >= 0),     -- a monthly salary instead of an hourly wage
  overtime_x        numeric(4,2) NOT NULL DEFAULT 1.5 CHECK (overtime_x BETWEEN 1 AND 5),
  double_x          numeric(4,2) NOT NULL DEFAULT 2.0 CHECK (double_x BETWEEN 1 AND 5),   -- Sundays and public holidays
  note              text,
  updated_by        uuid NOT NULL REFERENCES users(id),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE employee_pay ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_pay FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON employee_pay USING (company_id = current_company()) WITH CHECK (company_id = current_company());

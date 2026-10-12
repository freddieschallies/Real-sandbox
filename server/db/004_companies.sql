-- Separate companies. Every company's data carries its company_id, and PostgreSQL row-level
-- security only ever shows the rows of the company set for the current connection
-- (app.company_id). The app connects as a role without bypass rights, so even a bug in a
-- query cannot reach another company's data.
BEGIN;

CREATE TABLE companies (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL UNIQUE,
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  suspended_at    timestamptz,
  suspended_reason text
);

-- Platform owner logins (the business that sells the app). They manage companies, never company data.
CREATE TABLE platform_admins (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name       text NOT NULL,
  email           text NOT NULL UNIQUE,
  password_hash   text NOT NULL,
  login_enabled   boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Global login directory: one email = one person = one company. No company data here.
CREATE TABLE logins (
  email           text PRIMARY KEY,
  user_id         uuid NOT NULL UNIQUE,
  company_id      uuid NOT NULL REFERENCES companies(id)
);

-- Per-company running numbers (job, quote, invoice), so each company counts from its own start.
CREATE TABLE company_counters (
  company_id      uuid NOT NULL REFERENCES companies(id),
  kind            text NOT NULL,
  next_value      integer NOT NULL,
  PRIMARY KEY (company_id, kind)
);

CREATE FUNCTION current_company() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.company_id', true), '')::uuid
$$;

CREATE FUNCTION next_company_number(k text, start integer) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  INSERT INTO company_counters (company_id, kind, next_value) VALUES (current_company(), k, start + 1)
  ON CONFLICT (company_id, kind) DO UPDATE SET next_value = company_counters.next_value + 1
  RETURNING next_value - 1 INTO n;
  RETURN n;
END $$;

-- If this database already has data (a development copy), it all belongs to one first company.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM users) THEN
    INSERT INTO companies (name) VALUES ('Company 1');
  END IF;
END $$;

-- Add company_id to every company table, fill it, default it from the connection, lock it down.
DO $$
DECLARE
  t text;
  first_company uuid := (SELECT id FROM companies ORDER BY created_at LIMIT 1);
  tenant_tables text[] := ARRAY[
    'access_changes','access_overrides','audit_log','bought_out_items','clients','departments','departures',
    'document_lines','employee_log_entries','equipment','estimates','flags','fuel_logs','invoices','job_helpers',
    'job_visits','jobs','log_views','notifications','photos','planned_maintenance_checks','policy_acknowledgements',
    'policy_versions','price_changes','quotes','rates','route_baselines','stock_items','stock_movements',
    'stocktake_lines','stocktakes','store_managers','stores','suppliers','supply_runs','sync_requests',
    'technician_settings','timesheet_lines','timesheets','tool_assignments','tools','tracker_driver_outbox',
    'tracker_positions','trips','users','vehicle_scans','vehicles','visit_pauses','work_items'];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN company_id uuid REFERENCES companies(id)', t);
    IF first_company IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I DISABLE TRIGGER USER', t);
      EXECUTE format('UPDATE %I SET company_id = %L', t, first_company);
      EXECUTE format('ALTER TABLE %I ENABLE TRIGGER USER', t);
    END IF;
    EXECUTE format('ALTER TABLE %I ALTER COLUMN company_id SET DEFAULT current_company()', t);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN company_id SET NOT NULL', t);
    EXECUTE format('CREATE INDEX %I ON %I (company_id)', t || '_company_idx', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY company_isolation ON %I USING (company_id = current_company()) WITH CHECK (company_id = current_company())', t);
  END LOOP;
END $$;

-- Existing users go into the login directory.
INSERT INTO logins (email, user_id, company_id)
SELECT lower(email), id, company_id FROM users WHERE email IS NOT NULL;

-- Uniqueness is per company now.
ALTER TABLE clients DROP CONSTRAINT clients_name_key, ADD UNIQUE (company_id, name);
ALTER TABLE departments DROP CONSTRAINT departments_name_key, ADD UNIQUE (company_id, name);
ALTER TABLE stock_items DROP CONSTRAINT stock_items_code_key, ADD UNIQUE (company_id, code);
ALTER TABLE policy_versions DROP CONSTRAINT policy_versions_version_key, ADD UNIQUE (company_id, version);
ALTER TABLE vehicles DROP CONSTRAINT vehicles_registration_key, ADD UNIQUE (company_id, registration);
ALTER TABLE vehicles DROP CONSTRAINT vehicles_barcode_key, ADD UNIQUE (company_id, barcode);
ALTER TABLE vehicles DROP CONSTRAINT vehicles_tracker_unit_id_key, ADD UNIQUE (company_id, tracker_unit_id);
ALTER TABLE rates DROP CONSTRAINT rates_pkey, ADD PRIMARY KEY (company_id, key);
ALTER TABLE route_baselines DROP CONSTRAINT route_baselines_pkey, ADD PRIMARY KEY (company_id, origin_cell, store_id, hour_band);
DROP INDEX access_overrides_level;
CREATE UNIQUE INDEX access_overrides_level ON access_overrides (company_id, level, action) WHERE level IS NOT NULL;

-- Each company numbers its own jobs, quotes and invoices.
ALTER TABLE jobs DROP CONSTRAINT jobs_job_number_key, ADD UNIQUE (company_id, job_number);
ALTER TABLE jobs ALTER COLUMN job_number SET DEFAULT next_company_number('job', 10001);
ALTER TABLE quotes DROP CONSTRAINT quotes_quote_number_key, ADD UNIQUE (company_id, quote_number);
ALTER TABLE quotes ALTER COLUMN quote_number SET DEFAULT next_company_number('quote', 5001);
ALTER TABLE invoices DROP CONSTRAINT invoices_invoice_number_key, ADD UNIQUE (company_id, invoice_number);
ALTER TABLE invoices ALTER COLUMN invoice_number SET DEFAULT next_company_number('invoice', 7001);
DROP SEQUENCE job_number_seq, quote_number_seq, invoice_number_seq;
-- Carry on from existing numbers in a development copy.
INSERT INTO company_counters (company_id, kind, next_value)
SELECT company_id, 'job', max(job_number) + 1 FROM jobs GROUP BY company_id;

-- Views must apply the reader's row-level security, not the view owner's.
ALTER VIEW technician_stock SET (security_invoker = true);
ALTER VIEW stockroom_stock SET (security_invoker = true);

-- company_counters is written through next_company_number(); it is per company too.
ALTER TABLE company_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_counters FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON company_counters USING (company_id = current_company()) WITH CHECK (company_id = current_company());

COMMIT;

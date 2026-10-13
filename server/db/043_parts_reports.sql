-- When a technician cannot finish because parts are needed and another quote is needed, departments
-- with the parts report switched on (Foodservice to start) make him write a short report before he
-- leaves site: the machine or site, the serial tag (typed too if unclear), the part, any more photos.
-- It becomes a draft quote for the office, and goes to the client on the company's letterhead.
ALTER TABLE departments ADD COLUMN parts_report boolean NOT NULL DEFAULT false;
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT id FROM companies LOOP
    PERFORM set_config('app.company_id', c.id::text, true);
    UPDATE departments SET parts_report = true WHERE company_id = c.id AND lower(name) = 'foodservice';
  END LOOP;
  PERFORM set_config('app.company_id', '', true);
END $$;

CREATE TABLE job_reports (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL DEFAULT current_company() REFERENCES companies(id),
  report_number    integer NOT NULL DEFAULT next_company_number('report', 1001),
  job_id           uuid NOT NULL REFERENCES jobs(id),
  visit_id         uuid REFERENCES job_visits(id),
  created_by       uuid NOT NULL REFERENCES users(id),
  created_at       timestamptz NOT NULL,
  machine_photo_id uuid NOT NULL REFERENCES photos(id),
  serial_photo_id  uuid NOT NULL REFERENCES photos(id),
  serial_text      text,
  part_photo_id    uuid NOT NULL REFERENCES photos(id),
  part_description text NOT NULL CHECK (length(trim(part_description)) >= 2),
  part_qty         numeric(10,2) NOT NULL DEFAULT 1 CHECK (part_qty > 0),
  extra_photo_ids  uuid[] NOT NULL DEFAULT '{}',
  notes            text,
  quote_id         uuid REFERENCES quotes(id),
  UNIQUE (company_id, report_number)
);
ALTER TABLE job_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_reports FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON job_reports USING (company_id = current_company()) WITH CHECK (company_id = current_company());
CREATE TRIGGER job_reports_immutable BEFORE UPDATE OR DELETE ON job_reports FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Every time a report is emailed: to whom, by whom, and whether it went.
CREATE TABLE report_emails (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL DEFAULT current_company() REFERENCES companies(id),
  report_id   uuid NOT NULL REFERENCES job_reports(id),
  sent_to     text[] NOT NULL,
  sent_by     uuid NOT NULL REFERENCES users(id),
  sent_at     timestamptz NOT NULL DEFAULT now(),
  ok          boolean NOT NULL,
  error       text
);
ALTER TABLE report_emails ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_emails FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON report_emails USING (company_id = current_company()) WITH CHECK (company_id = current_company());

-- The company's letterhead, given by the CEO: a picture for the top of every page and one for the
-- bottom. Used on everything the app prints or emails. A new company starts without one.
CREATE TABLE company_letterhead (
  company_id      uuid PRIMARY KEY DEFAULT current_company() REFERENCES companies(id),
  header_photo_id uuid REFERENCES photos(id),
  footer_photo_id uuid REFERENCES photos(id),
  updated_by      uuid REFERENCES users(id),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE company_letterhead ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_letterhead FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON company_letterhead USING (company_id = current_company()) WITH CHECK (company_id = current_company());

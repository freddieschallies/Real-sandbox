-- Workshop repairs. A machine is uplifted from the client's site to our workshop (photo, store
-- manager's signature), repaired there (visits in the workshop, checked against its location), and
-- delivered back; a loan machine can stand in meanwhile. The job card stays open until the machine
-- is back and the loan machine collected.

-- Where a visit happened.
ALTER TABLE job_visits ADD COLUMN place text NOT NULL DEFAULT 'site' CHECK (place IN ('site', 'workshop'));

-- The company's workshop (one per company), set by the office.
CREATE TABLE company_workshop (
  company_id  uuid PRIMARY KEY DEFAULT current_company() REFERENCES companies(id),
  name        text NOT NULL DEFAULT 'Workshop',
  address     text,
  lat         double precision NOT NULL,
  lng         double precision NOT NULL,
  geofence_m  integer NOT NULL DEFAULT 150 CHECK (geofence_m BETWEEN 30 AND 2000),
  updated_by  uuid REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE company_workshop ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_workshop FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON company_workshop USING (company_id = current_company()) WITH CHECK (company_id = current_company());

-- The company's loan machines.
CREATE TABLE loan_machines (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL DEFAULT current_company() REFERENCES companies(id),
  name          text NOT NULL CHECK (length(trim(name)) >= 2),
  serial        text,
  asset_number  text,
  notes         text,
  active        boolean NOT NULL DEFAULT true,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE loan_machines ENABLE ROW LEVEL SECURITY;
ALTER TABLE loan_machines FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON loan_machines USING (company_id = current_company()) WITH CHECK (company_id = current_company());

-- Every move of a machine on a job: uplifted to the workshop, delivered back, loan machine left, loan machine collected.
CREATE TABLE machine_moves (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid NOT NULL DEFAULT current_company() REFERENCES companies(id),
  job_id             uuid NOT NULL REFERENCES jobs(id),
  visit_id           uuid REFERENCES job_visits(id),
  kind               text NOT NULL CHECK (kind IN ('uplifted', 'delivered', 'loan_out', 'loan_back')),
  place              text NOT NULL DEFAULT 'site' CHECK (place IN ('site', 'workshop')),
  loan_machine_id    uuid REFERENCES loan_machines(id),
  equipment_id       uuid REFERENCES equipment(id),
  note               text,
  person_name        text,
  signature_photo_id uuid REFERENCES photos(id),
  photo_ids          uuid[] NOT NULL DEFAULT '{}',
  at                 timestamptz NOT NULL,
  by_user            uuid NOT NULL REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind IN ('loan_out', 'loan_back')) = (loan_machine_id IS NOT NULL))
);
CREATE INDEX machine_moves_job ON machine_moves (job_id, at);
CREATE INDEX machine_moves_loan ON machine_moves (loan_machine_id, at);
ALTER TABLE machine_moves ENABLE ROW LEVEL SECURITY;
ALTER TABLE machine_moves FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON machine_moves USING (company_id = current_company()) WITH CHECK (company_id = current_company());
CREATE TRIGGER machine_moves_immutable BEFORE UPDATE OR DELETE ON machine_moves FOR EACH ROW EXECUTE FUNCTION forbid_change();

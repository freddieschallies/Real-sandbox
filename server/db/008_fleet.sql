-- Fleet: the mechanic's side. Everything is linked to a vehicle: its details, km readings,
-- faults, and the mechanic's job cards (no store jobs here).

ALTER TYPE login_level ADD VALUE 'mechanic';
ALTER TYPE photo_kind ADD VALUE 'fleet_before';
ALTER TYPE photo_kind ADD VALUE 'fleet_after';
ALTER TYPE photo_kind ADD VALUE 'fleet_fault';
ALTER TYPE photo_kind ADD VALUE 'fleet_slip';

CREATE TYPE vehicle_status AS ENUM ('in_service', 'workshop', 'off_road');

ALTER TABLE vehicles
  ADD COLUMN make text,
  ADD COLUMN model text,
  ADD COLUMN year integer CHECK (year BETWEEN 1950 AND 2100),
  ADD COLUMN vin text,
  ADD COLUMN engine_no text,
  ADD COLUMN licence_expiry date,
  ADD COLUMN status vehicle_status NOT NULL DEFAULT 'in_service',
  ADD COLUMN status_note text,
  ADD COLUMN status_changed_at timestamptz,
  ADD COLUMN service_interval_km integer NOT NULL DEFAULT 15000 CHECK (service_interval_km > 0),
  ADD COLUMN service_interval_months integer NOT NULL DEFAULT 12 CHECK (service_interval_months > 0),
  ADD COLUMN next_service_km integer,
  ADD COLUMN next_service_at date;

-- Every km reading, wherever it came from. The odometer may never go backwards.
CREATE TABLE odometer_readings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL DEFAULT current_company() REFERENCES companies(id),
  vehicle_id    uuid NOT NULL REFERENCES vehicles(id),
  km            integer NOT NULL CHECK (km >= 0),
  read_at       timestamptz NOT NULL,
  source        text NOT NULL CHECK (source IN ('handover', 'fleet_job', 'mechanic')),
  source_id     uuid,
  recorded_by   uuid NOT NULL REFERENCES users(id)
);
CREATE INDEX odometer_vehicle ON odometer_readings (vehicle_id, km DESC);

CREATE TYPE fault_severity AS ENUM ('safety', 'urgent', 'normal');
CREATE TYPE fault_status AS ENUM ('open', 'in_progress', 'fixed', 'deferred');

CREATE TABLE vehicle_faults (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL DEFAULT current_company() REFERENCES companies(id),
  vehicle_id    uuid NOT NULL REFERENCES vehicles(id),
  description   text NOT NULL,
  severity      fault_severity NOT NULL DEFAULT 'normal',
  source        text NOT NULL CHECK (source IN ('driver', 'handover', 'mechanic')),
  source_id     uuid,
  reported_by   uuid NOT NULL REFERENCES users(id),
  reported_at   timestamptz NOT NULL,
  photo_ids     uuid[] NOT NULL DEFAULT '{}',
  status        fault_status NOT NULL DEFAULT 'open',
  fleet_job_id  uuid,
  closed_at     timestamptz,
  closed_note   text,
  CHECK (status <> 'deferred' OR closed_note IS NOT NULL)
);
CREATE INDEX vehicle_faults_open ON vehicle_faults (vehicle_id) WHERE status IN ('open', 'in_progress');

CREATE TYPE fleet_job_type AS ENUM ('service', 'repair', 'tyres', 'brakes', 'electrical', 'roadworthy', 'breakdown', 'other');
CREATE TYPE fleet_job_status AS ENUM ('open', 'completed');

CREATE TABLE fleet_jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL DEFAULT current_company() REFERENCES companies(id),
  number          integer NOT NULL DEFAULT next_company_number('fleet_job', 3001),
  vehicle_id      uuid NOT NULL REFERENCES vehicles(id),
  job_type        fleet_job_type NOT NULL,
  status          fleet_job_status NOT NULL DEFAULT 'open',
  reason          text NOT NULL,
  opened_by       uuid NOT NULL REFERENCES users(id),
  opened_at       timestamptz NOT NULL,
  odometer_in     integer NOT NULL CHECK (odometer_in >= 0),
  found_text      text,
  did_text        text,
  labour_hours    numeric(6,2) CHECK (labour_hours >= 0),
  before_photo_ids uuid[] NOT NULL DEFAULT '{}',
  after_photo_ids uuid[] NOT NULL DEFAULT '{}',
  odometer_out    integer CHECK (odometer_out >= odometer_in),
  next_service_km integer,
  next_service_at date,
  completed_by    uuid REFERENCES users(id),
  completed_at    timestamptz,
  UNIQUE (company_id, number),
  CHECK (status <> 'completed' OR (completed_at IS NOT NULL AND odometer_out IS NOT NULL AND found_text IS NOT NULL AND did_text IS NOT NULL))
);
CREATE UNIQUE INDEX fleet_one_open_job ON fleet_jobs (vehicle_id) WHERE status = 'open';
ALTER TABLE vehicle_faults ADD CONSTRAINT faults_fleet_job_fk FOREIGN KEY (fleet_job_id) REFERENCES fleet_jobs(id);

CREATE TABLE fleet_job_parts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL DEFAULT current_company() REFERENCES companies(id),
  job_id          uuid NOT NULL REFERENCES fleet_jobs(id),
  description     text NOT NULL,
  qty             numeric(10,2) NOT NULL CHECK (qty > 0),
  unit_cost_cents integer CHECK (unit_cost_cents >= 0),
  source          text NOT NULL CHECK (source IN ('stockroom', 'bought', 'other')),
  slip_photo_id   uuid REFERENCES photos(id),
  added_by        uuid NOT NULL REFERENCES users(id),
  added_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (source <> 'bought' OR slip_photo_id IS NOT NULL)
);

-- A completed mechanic job card is the vehicle's history: it can't be changed or removed.
CREATE FUNCTION lock_completed_fleet_job() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'mechanic job cards cannot be deleted'; END IF;
  IF OLD.status = 'completed' THEN RAISE EXCEPTION 'mechanic job card % is completed and locked', OLD.number; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_jobs_locked BEFORE UPDATE OR DELETE ON fleet_jobs FOR EACH ROW EXECUTE FUNCTION lock_completed_fleet_job();

CREATE FUNCTION lock_parts_of_completed_job() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st fleet_job_status;
BEGIN
  SELECT status INTO st FROM fleet_jobs WHERE id = COALESCE(NEW.job_id, OLD.job_id);
  IF TG_OP <> 'INSERT' OR st = 'completed' THEN RAISE EXCEPTION 'parts on a mechanic job card cannot be changed once added or after completion'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_parts_locked BEFORE INSERT OR UPDATE OR DELETE ON fleet_job_parts FOR EACH ROW EXECUTE FUNCTION lock_parts_of_completed_job();

CREATE TRIGGER odometer_immutable BEFORE UPDATE OR DELETE ON odometer_readings FOR EACH ROW EXECUTE FUNCTION forbid_change();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['odometer_readings', 'vehicle_faults', 'fleet_jobs', 'fleet_job_parts'] LOOP
    EXECUTE format('CREATE INDEX %I ON %I (company_id)', t || '_company_idx', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY company_isolation ON %I USING (company_id = current_company()) WITH CHECK (company_id = current_company())', t);
  END LOOP;
END $$;


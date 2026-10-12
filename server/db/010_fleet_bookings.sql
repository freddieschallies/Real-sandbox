-- The mechanic books vehicles in for a service or repair, and can put technicians in a vehicle
-- himself when a technician's phone is off or broken.

CREATE TYPE booking_status AS ENUM ('booked', 'started', 'cancelled');

CREATE TABLE fleet_bookings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL DEFAULT current_company() REFERENCES companies(id),
  vehicle_id    uuid NOT NULL REFERENCES vehicles(id),
  job_type      fleet_job_type NOT NULL,
  booked_for    date NOT NULL,
  time_slot     text NOT NULL DEFAULT 'morning' CHECK (time_slot IN ('morning', 'afternoon', 'all_day')),
  place         text NOT NULL DEFAULT 'Own workshop',
  reason        text NOT NULL,
  status        booking_status NOT NULL DEFAULT 'booked',
  booked_by     uuid NOT NULL REFERENCES users(id),
  booked_at     timestamptz NOT NULL,
  fleet_job_id  uuid REFERENCES fleet_jobs(id),
  cancelled_note text,
  CHECK (status <> 'cancelled' OR cancelled_note IS NOT NULL),
  CHECK (status <> 'started' OR fleet_job_id IS NOT NULL)
);
CREATE INDEX fleet_bookings_date ON fleet_bookings (booked_for) WHERE status = 'booked';
CREATE INDEX fleet_bookings_company_idx ON fleet_bookings (company_id);
ALTER TABLE fleet_bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE fleet_bookings FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON fleet_bookings USING (company_id = current_company()) WITH CHECK (company_id = current_company());

-- A scan put in by someone else (the mechanic), and why.
ALTER TABLE vehicle_scans ADD COLUMN assigned_by uuid REFERENCES users(id);
ALTER TABLE vehicle_scans ADD COLUMN assign_reason text;
ALTER TABLE vehicle_scans ADD CONSTRAINT scans_assigned_reason CHECK (assigned_by IS NULL OR assign_reason IS NOT NULL);

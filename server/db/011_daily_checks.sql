-- The mechanic checks every vehicle in service each day: odometer, oil, water and tyres.
-- Oil added is always recorded in litres, so an engine using oil shows up.

CREATE TABLE daily_checks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL DEFAULT current_company() REFERENCES companies(id),
  vehicle_id    uuid NOT NULL REFERENCES vehicles(id),
  check_date    date NOT NULL,
  checked_at    timestamptz NOT NULL,
  checked_by    uuid NOT NULL REFERENCES users(id),
  odometer_km   integer NOT NULL CHECK (odometer_km >= 0),
  oil           text NOT NULL CHECK (oil IN ('ok', 'topped_up', 'problem')),
  oil_litres    numeric(5,2) CHECK (oil_litres > 0 AND oil_litres <= 20),
  water         text NOT NULL CHECK (water IN ('ok', 'topped_up', 'problem')),
  water_litres  numeric(5,2) CHECK (water_litres > 0 AND water_litres <= 30),
  tyres         text NOT NULL CHECK (tyres IN ('ok', 'pressure_adjusted', 'problem')),
  notes         text,
  photo_ids     uuid[] NOT NULL DEFAULT '{}',
  synced_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vehicle_id, check_date),
  CHECK ((oil = 'topped_up') = (oil_litres IS NOT NULL)),
  CHECK (NOT (oil = 'problem' OR water = 'problem' OR tyres = 'problem') OR length(trim(coalesce(notes, ''))) >= 10)
);
CREATE INDEX daily_checks_date ON daily_checks (check_date);
CREATE INDEX daily_checks_company_idx ON daily_checks (company_id);
ALTER TABLE daily_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_checks FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON daily_checks USING (company_id = current_company()) WITH CHECK (company_id = current_company());

-- A check is evidence: once saved it cannot be changed or removed.
CREATE FUNCTION daily_check_locked() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'daily checks are locked once saved'; END $$;
CREATE TRIGGER daily_checks_locked BEFORE UPDATE OR DELETE ON daily_checks FOR EACH ROW EXECUTE FUNCTION daily_check_locked();

ALTER TABLE odometer_readings DROP CONSTRAINT odometer_readings_source_check;
ALTER TABLE odometer_readings ADD CONSTRAINT odometer_readings_source_check CHECK (source IN ('handover', 'fleet_job', 'mechanic', 'release', 'daily_check'));

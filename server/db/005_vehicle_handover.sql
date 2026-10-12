-- Vehicle handover inspections: the new driver inspects, photographs and signs for the vehicle;
-- the previous driver or a supervisor signs the handover, or a supervisor approves it remotely.

ALTER TYPE photo_kind ADD VALUE 'vehicle_front';
ALTER TYPE photo_kind ADD VALUE 'vehicle_back';
ALTER TYPE photo_kind ADD VALUE 'vehicle_left';
ALTER TYPE photo_kind ADD VALUE 'vehicle_right';
ALTER TYPE photo_kind ADD VALUE 'vehicle_dashboard';
ALTER TYPE photo_kind ADD VALUE 'vehicle_damage';
ALTER TYPE photo_kind ADD VALUE 'handover_signature';

ALTER TYPE flag_type ADD VALUE 'vehicle_new_damage';
ALTER TYPE flag_type ADD VALUE 'handover_not_signed';

CREATE TYPE handover_by AS ENUM ('previous_driver', 'supervisor', 'remote_approval');
CREATE TYPE handover_status AS ENUM ('signed', 'awaiting_approval', 'approved', 'rejected');

CREATE TABLE vehicle_inspections (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL DEFAULT current_company() REFERENCES companies(id),
  vehicle_id            uuid NOT NULL REFERENCES vehicles(id),
  driver_id             uuid NOT NULL REFERENCES users(id),        -- who accepts the vehicle
  previous_driver_id    uuid REFERENCES users(id),                 -- who drove it last, per scans
  inspected_at          timestamptz NOT NULL,                      -- phone time
  odometer_km           integer NOT NULL CHECK (odometer_km >= 0),
  fuel_level            text NOT NULL CHECK (fuel_level IN ('empty', 'quarter', 'half', 'three_quarters', 'full')),
  checks                jsonb NOT NULL,
  problems              text[] NOT NULL DEFAULT '{}',
  new_problems          text[] NOT NULL DEFAULT '{}',
  photo_ids             uuid[] NOT NULL,                           -- sides, dashboard and damage
  driver_signature_id   uuid NOT NULL REFERENCES photos(id),
  acceptance_text       text NOT NULL,                             -- exactly what he agreed to
  handover_by           handover_by NOT NULL,
  handed_over_by_name   text,
  handover_signature_id uuid REFERENCES photos(id),
  remote_reason         text,
  status                handover_status NOT NULL,
  decided_by            uuid REFERENCES users(id),
  decided_at            timestamptz,
  decision_note         text,
  synced_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (handover_by = 'remote_approval' OR (handover_signature_id IS NOT NULL AND handed_over_by_name IS NOT NULL)),
  CHECK (handover_by <> 'remote_approval' OR remote_reason IS NOT NULL),
  CHECK ((status IN ('approved', 'rejected')) = (decided_by IS NOT NULL AND decided_at IS NOT NULL))
);
CREATE INDEX vehicle_inspections_vehicle ON vehicle_inspections (vehicle_id, inspected_at DESC);
CREATE INDEX vehicle_inspections_company_idx ON vehicle_inspections (company_id);
ALTER TABLE vehicle_inspections ENABLE ROW LEVEL SECURITY;
ALTER TABLE vehicle_inspections FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON vehicle_inspections USING (company_id = current_company()) WITH CHECK (company_id = current_company());

-- A signed inspection is evidence: only the supervisor's decision on a remote handover may be added later.
CREATE FUNCTION inspection_locked() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'vehicle inspections cannot be deleted';
  END IF;
  IF OLD.status <> 'awaiting_approval'
     OR (to_jsonb(NEW) - ARRAY['status', 'decided_by', 'decided_at', 'decision_note'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'decided_by', 'decided_at', 'decision_note']) THEN
    RAISE EXCEPTION 'vehicle inspections cannot be edited; only a pending remote handover can be approved or rejected';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER vehicle_inspections_locked BEFORE UPDATE OR DELETE ON vehicle_inspections
  FOR EACH ROW EXECUTE FUNCTION inspection_locked();

ALTER TABLE vehicle_scans ADD COLUMN inspection_id uuid REFERENCES vehicle_inspections(id);

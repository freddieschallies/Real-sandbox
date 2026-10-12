-- Real Sandbox: initial schema (PostgreSQL 16)
-- Every *_at timestamp written from a phone is the phone's own time (works offline);
-- synced_at records when the server received it.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- People, logins, departments
-- ---------------------------------------------------------------------------

CREATE TYPE login_level AS ENUM ('technician', 'admin', 'stockroom', 'management', 'director', 'creator');
CREATE TYPE employment_status AS ENUM ('active', 'leaving', 'left');

CREATE TABLE departments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL UNIQUE,
  manager_id      uuid,                       -- FK added after users exists
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name       text NOT NULL,
  email           text UNIQUE,
  phone           text,
  login_level     login_level NOT NULL,
  department_id   uuid REFERENCES departments(id),
  password_hash   text NOT NULL,
  status          employment_status NOT NULL DEFAULT 'active',
  login_enabled   boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE departments
  ADD CONSTRAINT departments_manager_fk FOREIGN KEY (manager_id) REFERENCES users(id);

-- Extra grants on top of the login level (e.g. pricing access given by a Director)
CREATE TYPE extra_permission AS ENUM ('pricing');
CREATE TABLE user_permissions (
  user_id         uuid NOT NULL REFERENCES users(id),
  permission      extra_permission NOT NULL,
  granted_by      uuid NOT NULL REFERENCES users(id),
  granted_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, permission)
);

-- ---------------------------------------------------------------------------
-- Clients, stores, equipment
-- ---------------------------------------------------------------------------

CREATE TABLE clients (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL UNIQUE
);

CREATE TABLE stores (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       uuid NOT NULL REFERENCES clients(id),
  name            text NOT NULL,
  branch_code     text,
  address         text,
  lat             double precision NOT NULL,
  lng             double precision NOT NULL,
  geofence_m      integer NOT NULL DEFAULT 150,
  email           text,
  UNIQUE (client_id, name)
);

CREATE TABLE store_managers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id        uuid NOT NULL REFERENCES stores(id),
  full_name       text NOT NULL,
  phone           text,
  UNIQUE (store_id, full_name)
);

CREATE TABLE equipment (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id        uuid NOT NULL REFERENCES stores(id),
  brand           text,
  model           text,
  serial          text,
  description     text NOT NULL
);

-- ---------------------------------------------------------------------------
-- Vehicles and who is in them (the scan record is the master record)
-- ---------------------------------------------------------------------------

CREATE TABLE vehicles (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  registration    text NOT NULL UNIQUE,
  description     text,
  tank_litres     numeric(6,1) NOT NULL CHECK (tank_litres > 0),
  barcode         text NOT NULL UNIQUE,
  tracker_unit_id text UNIQUE,                -- id of the unit in the Tracking Africa portal
  active          boolean NOT NULL DEFAULT true
);

CREATE TABLE technician_settings (
  user_id                 uuid PRIMARY KEY REFERENCES users(id),
  may_take_vehicle_home   boolean NOT NULL DEFAULT false,
  home_address            text,
  home_lat                double precision,
  home_lng                double precision,
  usual_vehicle_id        uuid REFERENCES vehicles(id),
  may_approve_own_topups  boolean NOT NULL DEFAULT false,
  updated_by              uuid REFERENCES users(id),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT may_take_vehicle_home OR (home_lat IS NOT NULL AND home_lng IS NOT NULL))
);

CREATE TYPE ride_mode AS ENUM ('driving', 'riding_along');
CREATE TYPE swap_reason AS ENUM ('usual', 'breakdown', 'service', 'swapped_with_colleague', 'other');

CREATE TABLE vehicle_scans (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id              uuid NOT NULL REFERENCES vehicles(id),
  user_id                 uuid NOT NULL REFERENCES users(id),
  mode                    ride_mode NOT NULL,
  reason                  swap_reason NOT NULL DEFAULT 'usual',
  reason_note             text,
  scanned_at              timestamptz NOT NULL,       -- phone time
  ignition_confirmed_at   timestamptz,                -- from tracker; must be within 10 min
  released_at             timestamptz,                -- next scan elsewhere, or end of day
  dropped_off_at          timestamptz,                -- passenger left at a site
  synced_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vehicle_scans_open ON vehicle_scans (vehicle_id) WHERE released_at IS NULL;
CREATE INDEX vehicle_scans_user ON vehicle_scans (user_id, scanned_at DESC);

-- ---------------------------------------------------------------------------
-- Jobs, visits, work items
-- ---------------------------------------------------------------------------

CREATE TYPE job_type AS ENUM ('breakdown', 'planned_maintenance', 'installation', 'quote_visit', 'follow_up');
CREATE TYPE job_priority AS ENUM ('urgent', 'normal', 'scheduled');
CREATE TYPE job_status AS ENUM ('assigned', 'in_progress', 'continue_later', 'closed');

CREATE SEQUENCE job_number_seq START 10001;

CREATE TABLE jobs (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_number              integer NOT NULL UNIQUE DEFAULT nextval('job_number_seq'),
  job_type                job_type NOT NULL,
  priority                job_priority NOT NULL DEFAULT 'normal',
  store_id                uuid NOT NULL REFERENCES stores(id),
  client_order_ref        text,
  fault_reported          text NOT NULL,
  scheduled_date          date NOT NULL,
  lead_technician_id      uuid NOT NULL REFERENCES users(id),
  status                  job_status NOT NULL DEFAULT 'assigned',
  follow_up_of_job_id     uuid REFERENCES jobs(id),
  created_by              uuid NOT NULL REFERENCES users(id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  -- close-out
  closed_at               timestamptz,
  manager_name            text,
  signature_photo_id      uuid,
  manager_unavailable_reason text,
  manager_unavailable_spoke_to text,
  CHECK (status <> 'closed' OR closed_at IS NOT NULL),
  CHECK (status <> 'closed' OR signature_photo_id IS NOT NULL
         OR (manager_unavailable_reason IS NOT NULL AND manager_unavailable_spoke_to IS NOT NULL))
);

CREATE TABLE job_helpers (
  job_id          uuid NOT NULL REFERENCES jobs(id),
  user_id         uuid NOT NULL REFERENCES users(id),
  added_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, user_id)
);

CREATE TYPE visit_state AS ENUM ('on_the_way', 'arrived', 'working', 'paused', 'done', 'continue_later');
CREATE TYPE pause_reason AS ENUM ('waiting_for_parts', 'store_asked_to_stop', 'collecting_parts', 'break');
CREATE TYPE unfinished_reason AS ENUM ('more_work_needed', 'waiting_for_parts', 'store_access', 'waiting_for_quote_approval', 'other');

CREATE TABLE job_visits (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id                  uuid NOT NULL REFERENCES jobs(id),
  technician_id           uuid NOT NULL REFERENCES users(id),
  state                   visit_state NOT NULL DEFAULT 'on_the_way',
  go_at                   timestamptz NOT NULL,
  arrived_at              timestamptz,
  arrived_outside_geofence_reason text,
  checked_in_manager      text,
  safety_check            jsonb,              -- {"area_safe":true,"isolated":true,"public_clear":true}
  started_at              timestamptz,
  ended_at                timestamptz,
  progress_note           text,
  unfinished_reason       unfinished_reason,
  planned_return_date     date,
  store_manager_informed  text,
  synced_at               timestamptz NOT NULL DEFAULT now(),
  CHECK (state <> 'continue_later'
         OR (progress_note IS NOT NULL AND unfinished_reason IS NOT NULL AND planned_return_date IS NOT NULL))
);
CREATE INDEX job_visits_job ON job_visits (job_id, go_at);

CREATE TABLE visit_pauses (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id        uuid NOT NULL REFERENCES job_visits(id),
  reason          pause_reason NOT NULL,
  paused_at       timestamptz NOT NULL,
  resumed_at      timestamptz,
  supply_run_id   uuid                        -- set when reason = collecting_parts
);

CREATE TYPE item_origin AS ENUM ('reported', 'found_on_site');
CREATE TYPE fault_type AS ENUM ('electrical', 'refrigeration', 'mechanical', 'water', 'wear_and_tear', 'user_damage', 'no_fault_found', 'other');
CREATE TYPE tested_result AS ENUM ('yes', 'partly', 'no');
CREATE TYPE item_outcome AS ENUM ('complete', 'needs_follow_up', 'needs_quote', 'waiting_for_parts');
CREATE TYPE item_status AS ENUM ('not_started', 'in_progress', 'finished');

CREATE TABLE work_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          uuid NOT NULL REFERENCES jobs(id),
  title           text NOT NULL,
  origin          item_origin NOT NULL,
  equipment_id    uuid REFERENCES equipment(id),
  fault_type      fault_type,
  found_text      text,
  did_text        text,
  no_materials    boolean NOT NULL DEFAULT false,
  tested          tested_result,
  outcome         item_outcome,
  still_needed    text,
  status          item_status NOT NULL DEFAULT 'not_started',
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX work_items_job ON work_items (job_id);

CREATE TYPE photo_kind AS ENUM ('before', 'after', 'rating_plate', 'signature', 'fuel_slip', 'supplier_slip', 'bought_out_slip');

CREATE TABLE photos (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            photo_kind NOT NULL,
  job_id          uuid REFERENCES jobs(id),
  work_item_id    uuid REFERENCES work_items(id),
  file_path       text NOT NULL,
  taken_at        timestamptz NOT NULL,
  taken_by        uuid NOT NULL REFERENCES users(id),
  synced_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE jobs ADD CONSTRAINT jobs_signature_fk FOREIGN KEY (signature_photo_id) REFERENCES photos(id);

CREATE TABLE planned_maintenance_checks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          uuid NOT NULL REFERENCES jobs(id),
  step            text NOT NULL,
  done            boolean NOT NULL DEFAULT false,
  done_at         timestamptz
);

-- ---------------------------------------------------------------------------
-- Stock, bought out, tools
-- ---------------------------------------------------------------------------

CREATE TABLE stock_items (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                text NOT NULL UNIQUE,
  description         text NOT NULL,
  unit                text NOT NULL DEFAULT 'each',
  selling_price_cents integer,                -- set by Director / pricing access only
  active              boolean NOT NULL DEFAULT true
);

-- Every stock change is a movement; holdings are computed, never typed.
-- from/to: NULL technician + is_stockroom = stockroom; NULL both sides = outside the system.
CREATE TYPE movement_kind AS ENUM ('receive', 'assign', 'return', 'transfer', 'use_on_job', 'supply_run', 'stocktake_adjustment');

CREATE TABLE stock_movements (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stock_item_id       uuid NOT NULL REFERENCES stock_items(id),
  qty                 numeric(10,2) NOT NULL CHECK (qty > 0),
  kind                movement_kind NOT NULL,
  from_stockroom      boolean NOT NULL DEFAULT false,
  from_technician_id  uuid REFERENCES users(id),
  to_stockroom        boolean NOT NULL DEFAULT false,
  to_technician_id    uuid REFERENCES users(id),
  job_id              uuid REFERENCES jobs(id),
  work_item_id        uuid REFERENCES work_items(id),
  supply_run_id       uuid,
  created_by          uuid NOT NULL REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  accepted_at         timestamptz,            -- transfers between technicians wait for this
  CHECK (NOT (from_stockroom AND from_technician_id IS NOT NULL)),
  CHECK (NOT (to_stockroom AND to_technician_id IS NOT NULL)),
  CHECK (kind <> 'use_on_job' OR (work_item_id IS NOT NULL AND from_technician_id IS NOT NULL))
);

CREATE VIEW technician_stock AS
SELECT t.technician_id, t.stock_item_id, SUM(t.qty) AS qty
FROM (
  SELECT to_technician_id AS technician_id, stock_item_id, qty
    FROM stock_movements
   WHERE to_technician_id IS NOT NULL
     AND (kind <> 'transfer' OR accepted_at IS NOT NULL)
  UNION ALL
  SELECT from_technician_id, stock_item_id, -qty
    FROM stock_movements
   WHERE from_technician_id IS NOT NULL
     AND (kind <> 'transfer' OR accepted_at IS NOT NULL)
) t
GROUP BY t.technician_id, t.stock_item_id;

CREATE VIEW stockroom_stock AS
SELECT stock_item_id,
       SUM(CASE WHEN to_stockroom THEN qty ELSE 0 END)
     - SUM(CASE WHEN from_stockroom THEN qty ELSE 0 END) AS qty
FROM stock_movements
GROUP BY stock_item_id;

CREATE TYPE supplier_status AS ENUM ('new', 'approved', 'rejected');

CREATE TABLE suppliers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  lat             double precision,           -- learned from where the vehicle stopped
  lng             double precision,
  geofence_m      integer NOT NULL DEFAULT 150,
  status          supplier_status NOT NULL DEFAULT 'new',
  first_named_by  uuid REFERENCES users(id),
  reviewed_by     uuid REFERENCES users(id),
  reviewed_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE supply_purpose AS ENUM ('job_parts', 'stock_topup');

CREATE TABLE supply_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  technician_id   uuid NOT NULL REFERENCES users(id),
  supplier_id     uuid NOT NULL REFERENCES suppliers(id),
  purpose         supply_purpose NOT NULL,
  job_id          uuid REFERENCES jobs(id),
  approved_by     uuid REFERENCES users(id),  -- required for stock_topup unless self-approval allowed
  started_at      timestamptz NOT NULL,
  collected_at    timestamptz,
  slip_photo_id   uuid REFERENCES photos(id),
  slip_amount_cents integer,                  -- read from the slip
  CHECK (purpose <> 'job_parts' OR job_id IS NOT NULL)
);

ALTER TABLE stock_movements ADD CONSTRAINT movements_supply_run_fk FOREIGN KEY (supply_run_id) REFERENCES supply_runs(id);
ALTER TABLE visit_pauses ADD CONSTRAINT pauses_supply_run_fk FOREIGN KEY (supply_run_id) REFERENCES supply_runs(id);

CREATE TABLE bought_out_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          uuid NOT NULL REFERENCES jobs(id),
  work_item_id    uuid NOT NULL REFERENCES work_items(id),
  description     text NOT NULL,
  qty             numeric(10,2) NOT NULL CHECK (qty > 0),
  price_cents     integer NOT NULL CHECK (price_cents >= 0),
  supplier_id     uuid REFERENCES suppliers(id),
  slip_photo_id   uuid NOT NULL REFERENCES photos(id),
  created_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tools (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  description     text NOT NULL,
  serial_or_mark  text,
  photo_path      text
);

CREATE TABLE tool_assignments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tool_id         uuid NOT NULL REFERENCES tools(id),
  technician_id   uuid NOT NULL REFERENCES users(id),
  issued_by       uuid NOT NULL REFERENCES users(id),
  issued_at       timestamptz NOT NULL DEFAULT now(),
  accepted_at     timestamptz,
  returned_at     timestamptz,
  return_condition text                        -- 'ok', 'damaged', 'missing' + notes
);
CREATE UNIQUE INDEX tool_one_holder ON tool_assignments (tool_id) WHERE returned_at IS NULL;

CREATE TYPE stocktake_scope AS ENUM ('stockroom', 'technician');

CREATE TABLE stocktakes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope           stocktake_scope NOT NULL,
  technician_id   uuid REFERENCES users(id),
  started_by      uuid NOT NULL REFERENCES users(id),
  started_at      timestamptz NOT NULL DEFAULT now(),
  signed_off_by   uuid REFERENCES users(id),
  signed_off_at   timestamptz,
  CHECK (scope <> 'technician' OR technician_id IS NOT NULL)
);

CREATE TABLE stocktake_lines (
  stocktake_id    uuid NOT NULL REFERENCES stocktakes(id),
  stock_item_id   uuid NOT NULL REFERENCES stock_items(id),
  expected_qty    numeric(10,2) NOT NULL,
  counted_qty     numeric(10,2) NOT NULL,
  PRIMARY KEY (stocktake_id, stock_item_id)
);

-- ---------------------------------------------------------------------------
-- Fuel
-- ---------------------------------------------------------------------------

CREATE TABLE fuel_logs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id      uuid NOT NULL REFERENCES vehicles(id),
  user_id         uuid NOT NULL REFERENCES users(id),
  litres          numeric(6,2) NOT NULL CHECK (litres > 0),
  amount_cents    integer NOT NULL CHECK (amount_cents > 0),
  slip_photo_id   uuid NOT NULL REFERENCES photos(id),
  logged_at       timestamptz NOT NULL,       -- phone time
  lat             double precision,
  lng             double precision,
  odometer_km     numeric(9,1),               -- from tracker at that moment
  synced_at       timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Tracker data and trips
-- ---------------------------------------------------------------------------

CREATE TABLE tracker_positions (
  vehicle_id      uuid NOT NULL REFERENCES vehicles(id),
  recorded_at     timestamptz NOT NULL,
  lat             double precision NOT NULL,
  lng             double precision NOT NULL,
  speed_kmh       real,
  ignition        boolean,
  odometer_km     numeric(9,1),
  PRIMARY KEY (vehicle_id, recorded_at)
);

CREATE TYPE trip_purpose AS ENUM ('job', 'supply_run', 'commute', 'fuel', 'office', 'none');

CREATE TABLE trips (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id          uuid NOT NULL REFERENCES vehicles(id),
  driver_id           uuid REFERENCES users(id),     -- from the scan record
  started_at          timestamptz NOT NULL,
  ended_at            timestamptz,
  start_lat           double precision,
  start_lng           double precision,
  end_lat             double precision,
  end_lng             double precision,
  distance_km         numeric(8,1),
  moving_minutes      numeric(8,1),
  stopped_minutes     numeric(8,1),
  purpose             trip_purpose NOT NULL DEFAULT 'none',
  job_visit_id        uuid REFERENCES job_visits(id),
  supply_run_id       uuid REFERENCES supply_runs(id),
  destination_store_id uuid REFERENCES stores(id),
  excluded_from_baseline boolean NOT NULL DEFAULT false
);
CREATE INDEX trips_vehicle_time ON trips (vehicle_id, started_at DESC);

-- Learned normal trip times: start area (rounded grid cell) -> store, by hour band
CREATE TABLE route_baselines (
  origin_cell     text NOT NULL,
  store_id        uuid NOT NULL REFERENCES stores(id),
  hour_band       smallint NOT NULL CHECK (hour_band BETWEEN 0 AND 23),
  median_minutes  numeric(6,1) NOT NULL,
  trip_count      integer NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (origin_cell, store_id, hour_band)
);

-- ---------------------------------------------------------------------------
-- Flags, timesheets
-- ---------------------------------------------------------------------------

CREATE TYPE flag_type AS ENUM (
  'slow_to_site', 'on_site_not_started', 'driving_no_job', 'off_route', 'open_job_card',
  'manager_unavailable', 'unsigned_pattern', 'timesheet_mismatch', 'fuel_mismatch',
  'tracker_fault', 'scan_not_confirmed', 'arrived_outside_geofence', 'phone_not_synced',
  'new_supplier'
);
CREATE TYPE flag_status AS ENUM ('open', 'explained', 'resolved', 'escalated');
CREATE TYPE flag_severity AS ENUM ('low', 'normal', 'high');

CREATE TABLE flags (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  flag_type       flag_type NOT NULL,
  severity        flag_severity NOT NULL DEFAULT 'normal',
  technician_id   uuid REFERENCES users(id),
  vehicle_id      uuid REFERENCES vehicles(id),
  job_id          uuid REFERENCES jobs(id),
  trip_id         uuid REFERENCES trips(id),
  raised_at       timestamptz NOT NULL DEFAULT now(),
  details         jsonb NOT NULL DEFAULT '{}',
  question        text,                        -- what the technician is asked
  explanation     text,
  explained_at    timestamptz,
  status          flag_status NOT NULL DEFAULT 'open',
  resolved_by     uuid REFERENCES users(id),
  resolved_at     timestamptz,
  resolution_note text,
  CHECK (status <> 'resolved' OR (resolved_by IS NOT NULL AND resolution_note IS NOT NULL))
);
CREATE INDEX flags_open ON flags (technician_id) WHERE status IN ('open', 'explained', 'escalated');

CREATE TABLE timesheets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  technician_id   uuid NOT NULL REFERENCES users(id),
  work_date       date NOT NULL,
  submitted_at    timestamptz NOT NULL,
  UNIQUE (technician_id, work_date)
);

CREATE TABLE timesheet_lines (
  timesheet_id    uuid NOT NULL REFERENCES timesheets(id),
  job_id          uuid NOT NULL REFERENCES jobs(id),
  minutes         integer NOT NULL CHECK (minutes >= 0),
  PRIMARY KEY (timesheet_id, job_id)
);

-- ---------------------------------------------------------------------------
-- Confidential employee log, departures, policy acknowledgements, audit
-- ---------------------------------------------------------------------------

CREATE TYPE log_entry_type AS ENUM ('observation', 'verbal_warning', 'written_warning', 'final_written_warning', 'commendation', 'correction');

CREATE TABLE employee_log_entries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id     uuid NOT NULL REFERENCES users(id),
  author_id       uuid NOT NULL REFERENCES users(id),
  entry_type      log_entry_type NOT NULL,
  what_happened   text NOT NULL,
  action_taken    text,
  reason          text,
  corrects_entry_id uuid REFERENCES employee_log_entries(id),
  linked_flag_id  uuid REFERENCES flags(id),
  linked_job_id   uuid REFERENCES jobs(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- LRA Schedule 8 item 5: transgression, action taken, reasons
  CHECK (entry_type NOT IN ('verbal_warning', 'written_warning', 'final_written_warning')
         OR (action_taken IS NOT NULL AND reason IS NOT NULL)),
  CHECK (entry_type <> 'correction' OR corrects_entry_id IS NOT NULL)
);

CREATE TABLE log_views (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id     uuid NOT NULL REFERENCES users(id),
  viewer_id       uuid NOT NULL REFERENCES users(id),
  viewed_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE how_left AS ENUM ('resigned', 'dismissed', 'contract_ended', 'retired', 'other');
CREATE TYPE rehire AS ENUM ('yes', 'no', 'with_conditions');

CREATE TABLE departures (
  user_id             uuid PRIMARY KEY REFERENCES users(id),
  last_working_day    date NOT NULL,
  how_left            how_left NOT NULL,
  reason              text NOT NULL,
  eligible_for_rehire rehire NOT NULL,
  started_by          uuid NOT NULL REFERENCES users(id),
  started_at          timestamptz NOT NULL DEFAULT now(),
  stocktake_id        uuid REFERENCES stocktakes(id),
  tool_check_signed_by uuid REFERENCES users(id),
  tool_check_signed_at timestamptz,
  completed_at        timestamptz               -- only when all three checks pass
);

CREATE TABLE policy_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version         text NOT NULL UNIQUE,
  body            text NOT NULL,
  published_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE policy_acknowledgements (
  user_id             uuid NOT NULL REFERENCES users(id),
  policy_version_id   uuid NOT NULL REFERENCES policy_versions(id),
  acknowledged_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, policy_version_id)
);

CREATE TABLE audit_log (
  id              bigserial PRIMARY KEY,
  actor_id        uuid REFERENCES users(id),
  action          text NOT NULL,
  entity          text NOT NULL,
  entity_id       text,
  details         jsonb NOT NULL DEFAULT '{}',
  at              timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Pricing, estimates, quotes, invoices
-- ---------------------------------------------------------------------------

CREATE TABLE rates (
  key             text PRIMARY KEY,           -- labour_per_hour, call_out, travel_per_km ...
  amount_cents    integer NOT NULL CHECK (amount_cents >= 0),
  updated_by      uuid NOT NULL REFERENCES users(id),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE price_changes (
  id              bigserial PRIMARY KEY,
  what            text NOT NULL,              -- 'rate:labour_per_hour', 'stock:<code>', 'quote:<id>'
  old_cents       integer,
  new_cents       integer NOT NULL,
  changed_by      uuid NOT NULL REFERENCES users(id),
  changed_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE estimates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          uuid NOT NULL REFERENCES jobs(id),
  work_item_id    uuid NOT NULL REFERENCES work_items(id),
  created_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL,
  labour_hours    numeric(6,2) NOT NULL DEFAULT 0,
  lines           jsonb NOT NULL DEFAULT '[]', -- [{stock_item_id|description, qty, unit_price_cents}]
  total_cents     integer NOT NULL,
  label           text NOT NULL DEFAULT 'Estimate only, not official'
                  CHECK (label = 'Estimate only, not official'),
  emailed_to      text
);

CREATE TYPE doc_status AS ENUM ('draft', 'sent', 'accepted', 'declined', 'paid', 'cancelled');

CREATE SEQUENCE quote_number_seq START 5001;
CREATE SEQUENCE invoice_number_seq START 7001;

CREATE TABLE quotes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_number    integer NOT NULL UNIQUE DEFAULT nextval('quote_number_seq'),
  job_id          uuid NOT NULL REFERENCES jobs(id),
  from_estimate_id uuid REFERENCES estimates(id),
  status          doc_status NOT NULL DEFAULT 'draft',
  created_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz,
  accepted_at     timestamptz,
  resulting_job_id uuid REFERENCES jobs(id)
);

CREATE TABLE invoices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number  integer NOT NULL UNIQUE DEFAULT nextval('invoice_number_seq'),
  job_id          uuid NOT NULL REFERENCES jobs(id),
  status          doc_status NOT NULL DEFAULT 'draft',
  created_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz
);

CREATE TYPE line_kind AS ENUM ('labour', 'call_out', 'travel', 'stock', 'bought_out', 'other');

CREATE TABLE document_lines (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id        uuid REFERENCES quotes(id),
  invoice_id      uuid REFERENCES invoices(id),
  kind            line_kind NOT NULL,
  description     text NOT NULL,
  qty             numeric(10,2) NOT NULL,
  unit_price_cents integer NOT NULL,
  work_item_id    uuid REFERENCES work_items(id),
  CHECK ((quote_id IS NULL) <> (invoice_id IS NULL))
);

-- ---------------------------------------------------------------------------
-- Records that can never be edited or deleted
-- ---------------------------------------------------------------------------

CREATE FUNCTION forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% records cannot be edited or deleted; add a dated correction instead', TG_TABLE_NAME;
END $$;

CREATE TRIGGER employee_log_immutable BEFORE UPDATE OR DELETE ON employee_log_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER log_views_immutable BEFORE UPDATE OR DELETE ON log_views
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER price_changes_immutable BEFORE UPDATE OR DELETE ON price_changes
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER policy_ack_immutable BEFORE UPDATE OR DELETE ON policy_acknowledgements
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- A closed job card is locked
CREATE FUNCTION lock_closed_job() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'job cards cannot be deleted';
  END IF;
  IF OLD.status = 'closed' THEN
    RAISE EXCEPTION 'job % is closed and locked', OLD.job_number;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER jobs_lock BEFORE UPDATE OR DELETE ON jobs
  FOR EACH ROW EXECUTE FUNCTION lock_closed_job();

-- Work items of a closed job are locked too
CREATE FUNCTION lock_items_of_closed_job() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s job_status;
BEGIN
  SELECT status INTO s FROM jobs WHERE id = COALESCE(NEW.job_id, OLD.job_id);
  IF s = 'closed' THEN
    RAISE EXCEPTION 'work items of a closed job are locked';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

CREATE TRIGGER work_items_lock BEFORE INSERT OR UPDATE OR DELETE ON work_items
  FOR EACH ROW EXECUTE FUNCTION lock_items_of_closed_job();

COMMIT;

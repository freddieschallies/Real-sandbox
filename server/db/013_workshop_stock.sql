-- The mechanic's own stock: the workshop is a stock location like the stockroom and the technicians.
-- The stock controller (or office) issues to it and sets what it keeps; the mechanic uses it on
-- job cards and daily checks. Oil and other poured stock is never exact: small losses are allowed
-- but always recorded; bigger ones go to the office to explain.


ALTER TABLE stock_movements ADD COLUMN from_workshop boolean NOT NULL DEFAULT false;
ALTER TABLE stock_movements ADD COLUMN to_workshop boolean NOT NULL DEFAULT false;
ALTER TABLE stock_movements ADD COLUMN fleet_job_part_id uuid REFERENCES fleet_job_parts(id);
ALTER TABLE stock_movements ADD COLUMN daily_check_id uuid REFERENCES daily_checks(id);
ALTER TABLE stock_movements ADD COLUMN note text;
ALTER TABLE stock_movements ADD CONSTRAINT movements_one_from CHECK ((from_workshop::int + from_stockroom::int + (from_technician_id IS NOT NULL)::int) <= 1);
ALTER TABLE stock_movements ADD CONSTRAINT movements_one_to CHECK ((to_workshop::int + to_stockroom::int + (to_technician_id IS NOT NULL)::int) <= 1);
ALTER TABLE stock_movements ADD CONSTRAINT movements_loss_noted CHECK (kind <> 'workshop_loss' OR length(trim(coalesce(note, ''))) >= 5);

-- Poured or measured stock (oil, coolant, brake fluid): small handling losses are expected.
ALTER TABLE stock_items ADD COLUMN measured boolean NOT NULL DEFAULT false;

CREATE VIEW workshop_stock WITH (security_invoker = true) AS
SELECT stock_item_id,
       SUM(CASE WHEN to_workshop THEN qty ELSE 0 END) - SUM(CASE WHEN from_workshop THEN qty ELSE 0 END) AS qty
  FROM stock_movements GROUP BY stock_item_id;

-- What the workshop keeps, set by the stock controller or office.
CREATE TABLE workshop_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL DEFAULT current_company() REFERENCES companies(id),
  stock_item_id   uuid NOT NULL REFERENCES stock_items(id),
  min_qty         numeric(10,2) NOT NULL DEFAULT 0 CHECK (min_qty >= 0),
  daily_check_use text CHECK (daily_check_use IN ('oil', 'water')),
  set_by          uuid NOT NULL REFERENCES users(id),
  set_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, stock_item_id)
);
CREATE UNIQUE INDEX workshop_items_daily_use ON workshop_items (company_id, daily_check_use) WHERE daily_check_use IS NOT NULL;
ALTER TABLE workshop_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE workshop_items FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON workshop_items USING (company_id = current_company()) WITH CHECK (company_id = current_company());

-- Counting (or dipping) workshop stock: what the system expected, what was there, and the allowance.
CREATE TABLE workshop_counts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL DEFAULT current_company() REFERENCES companies(id),
  stock_item_id   uuid NOT NULL REFERENCES stock_items(id),
  expected_qty    numeric(10,2) NOT NULL,
  counted_qty     numeric(10,2) NOT NULL CHECK (counted_qty >= 0),
  used_since      numeric(10,2) NOT NULL DEFAULT 0,
  allowance       numeric(10,2) NOT NULL DEFAULT 0,
  result          text NOT NULL CHECK (result IN ('ok', 'within_allowance', 'short', 'over')),
  note            text,
  counted_by      uuid NOT NULL REFERENCES users(id),
  counted_at      timestamptz NOT NULL,
  CHECK (result NOT IN ('short', 'over') OR length(trim(coalesce(note, ''))) >= 5)
);
ALTER TABLE workshop_counts ENABLE ROW LEVEL SECURITY;
ALTER TABLE workshop_counts FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON workshop_counts USING (company_id = current_company()) WITH CHECK (company_id = current_company());
CREATE TRIGGER workshop_counts_locked BEFORE UPDATE OR DELETE ON workshop_counts FOR EACH ROW EXECUTE FUNCTION daily_check_locked();

ALTER TABLE stock_movements ADD COLUMN workshop_count_id uuid REFERENCES workshop_counts(id);

-- Parts on a mechanic job card can come from his own workshop stock.
ALTER TABLE fleet_job_parts DROP CONSTRAINT fleet_job_parts_source_check;
ALTER TABLE fleet_job_parts ADD CONSTRAINT fleet_job_parts_source_check CHECK (source IN ('stockroom', 'bought', 'other', 'workshop'));
ALTER TABLE fleet_job_parts ADD COLUMN stock_item_id uuid REFERENCES stock_items(id);
ALTER TABLE fleet_job_parts ADD CONSTRAINT fleet_job_parts_workshop_item CHECK (source <> 'workshop' OR stock_item_id IS NOT NULL);

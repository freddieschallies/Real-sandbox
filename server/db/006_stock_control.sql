-- Total stock control on the technician's side.
-- Every item on a technician is held either as van stock (holding_job_id NULL) or for one job.
-- It stays on his name until it is used on a job card or the stock controller confirms it came back.

ALTER TYPE movement_kind ADD VALUE 'supplier_invoice';
ALTER TYPE flag_type ADD VALUE 'stock_return_short';
ALTER TYPE flag_type ADD VALUE 'duplicate_supplier_invoice';
ALTER TYPE flag_type ADD VALUE 'supplier_invoice_changed';

-- Which holding on the technician's side a movement adds to or draws from.
ALTER TABLE stock_movements ADD COLUMN holding_job_id uuid REFERENCES jobs(id);
ALTER TABLE stock_movements ADD COLUMN supplier_invoice_line_id uuid;
ALTER TABLE stock_movements ADD COLUMN return_line_id uuid;
ALTER TABLE stock_movements ADD COLUMN unit_cost_cents integer CHECK (unit_cost_cents >= 0);

-- Movements are the record; they are never edited or deleted. Mistakes are corrected with a new movement.
-- The one exception: a transfer between technicians gets its accepted_at once, when the receiver accepts.
CREATE FUNCTION stock_movement_locked() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.kind = 'transfer' AND OLD.accepted_at IS NULL
     AND (to_jsonb(NEW) - 'accepted_at') = (to_jsonb(OLD) - 'accepted_at') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'stock movements cannot be edited or deleted; record a correcting movement instead';
END $$;
CREATE TRIGGER stock_movements_locked BEFORE UPDATE OR DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION stock_movement_locked();

-- Items first seen on a supplier invoice get a stock item at once (so they are counted) and wait for
-- the stock controller to give them a proper code, or merge them into an existing one.
ALTER TABLE stock_items ADD COLUMN needs_review boolean NOT NULL DEFAULT false;
ALTER TABLE stock_items ADD COLUMN supplier_code text;

CREATE VIEW technician_holdings WITH (security_invoker = true) AS
SELECT t.technician_id, t.stock_item_id, t.holding_job_id, SUM(t.qty) AS qty
FROM (
  SELECT to_technician_id AS technician_id, stock_item_id, holding_job_id, qty
    FROM stock_movements
   WHERE to_technician_id IS NOT NULL AND (kind <> 'transfer' OR accepted_at IS NOT NULL)
  UNION ALL
  SELECT from_technician_id, stock_item_id, holding_job_id, -qty
    FROM stock_movements
   WHERE from_technician_id IS NOT NULL AND (kind <> 'transfer' OR accepted_at IS NOT NULL)
) t
GROUP BY t.technician_id, t.stock_item_id, t.holding_job_id
HAVING SUM(t.qty) <> 0;

-- ---- Supplier invoices ------------------------------------------------------

CREATE TYPE invoice_status AS ENUM ('reading', 'to_confirm', 'confirmed', 'unreadable');

CREATE TABLE supplier_invoices (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL DEFAULT current_company() REFERENCES companies(id),
  technician_id     uuid NOT NULL REFERENCES users(id),
  photo_id          uuid NOT NULL REFERENCES photos(id),
  job_id            uuid REFERENCES jobs(id),             -- bought for this job; NULL = van stock
  status            invoice_status NOT NULL DEFAULT 'reading',
  read_by           text,                                 -- 'ai' or 'manual'
  read_result       jsonb,                                -- exactly what was read, kept for comparison
  read_error        text,
  read_attempts     integer NOT NULL DEFAULT 0,
  supplier_id       uuid REFERENCES suppliers(id),
  supplier_name     text,
  invoice_number    text,
  invoice_date      date,
  total_cents       integer CHECK (total_cents >= 0),
  scanned_at        timestamptz NOT NULL,
  confirmed_at      timestamptz,
  changed_from_read boolean NOT NULL DEFAULT false,       -- technician changed what was read
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'confirmed' OR (confirmed_at IS NOT NULL AND supplier_name IS NOT NULL AND invoice_number IS NOT NULL))
);
CREATE UNIQUE INDEX supplier_invoice_once ON supplier_invoices (company_id, lower(supplier_name), lower(invoice_number)) WHERE status = 'confirmed';

CREATE TABLE supplier_invoice_lines (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL DEFAULT current_company() REFERENCES companies(id),
  invoice_id        uuid NOT NULL REFERENCES supplier_invoices(id),
  line_no           integer NOT NULL,
  description       text NOT NULL,
  supplier_code     text,
  qty               numeric(10,2) NOT NULL CHECK (qty > 0),
  unit_price_cents  integer CHECK (unit_price_cents >= 0),
  stock_item_id     uuid NOT NULL REFERENCES stock_items(id),
  UNIQUE (invoice_id, line_no)
);
ALTER TABLE stock_movements ADD CONSTRAINT movements_invoice_line_fk FOREIGN KEY (supplier_invoice_line_id) REFERENCES supplier_invoice_lines(id);

-- ---- Returns to the stockroom ----------------------------------------------

CREATE TYPE return_status AS ENUM ('pending', 'received');

CREATE TABLE stock_returns (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL DEFAULT current_company() REFERENCES companies(id),
  technician_id     uuid NOT NULL REFERENCES users(id),
  status            return_status NOT NULL DEFAULT 'pending',
  requested_at      timestamptz NOT NULL,
  received_by       uuid REFERENCES users(id),
  received_at       timestamptz,
  note              text,
  CHECK ((status = 'received') = (received_by IS NOT NULL AND received_at IS NOT NULL))
);

CREATE TABLE stock_return_lines (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL DEFAULT current_company() REFERENCES companies(id),
  return_id         uuid NOT NULL REFERENCES stock_returns(id),
  stock_item_id     uuid NOT NULL REFERENCES stock_items(id),
  holding_job_id    uuid REFERENCES jobs(id),
  qty               numeric(10,2) NOT NULL CHECK (qty > 0),
  qty_received      numeric(10,2) CHECK (qty_received >= 0 AND qty_received <= qty)
);
ALTER TABLE stock_movements ADD CONSTRAINT movements_return_line_fk FOREIGN KEY (return_line_id) REFERENCES stock_return_lines(id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['supplier_invoices', 'supplier_invoice_lines', 'stock_returns', 'stock_return_lines'] LOOP
    EXECUTE format('CREATE INDEX %I ON %I (company_id)', t || '_company_idx', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY company_isolation ON %I USING (company_id = current_company()) WITH CHECK (company_id = current_company())', t);
  END LOOP;
END $$;

-- What is already on its way back, so it can't be returned twice or used meanwhile.
CREATE VIEW pending_returns WITH (security_invoker = true) AS
SELECT r.technician_id, l.stock_item_id, l.holding_job_id, SUM(l.qty) AS qty
  FROM stock_returns r JOIN stock_return_lines l ON l.return_id = r.id
 WHERE r.status = 'pending'
 GROUP BY r.technician_id, l.stock_item_id, l.holding_job_id;

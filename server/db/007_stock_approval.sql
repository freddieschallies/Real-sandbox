-- The stock controller approves everything that leaves or enters the stockroom.
-- Booking out is a request; nothing moves until the controller picks it and issues it.

ALTER TYPE photo_kind ADD VALUE 'stock_item';
ALTER TYPE photo_kind ADD VALUE 'delivery_note';

CREATE TYPE issue_status AS ENUM ('pending', 'issued', 'rejected');

CREATE TABLE stock_issues (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL DEFAULT current_company() REFERENCES companies(id),
  technician_id   uuid NOT NULL REFERENCES users(id),
  job_id          uuid REFERENCES jobs(id),               -- NULL = van stock top-up
  status          issue_status NOT NULL DEFAULT 'pending',
  requested_at    timestamptz NOT NULL,
  decided_by      uuid REFERENCES users(id),
  decided_at      timestamptz,
  note            text,
  CHECK ((status = 'pending') = (decided_by IS NULL AND decided_at IS NULL)),
  CHECK (status <> 'rejected' OR note IS NOT NULL)
);

CREATE TABLE stock_issue_lines (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL DEFAULT current_company() REFERENCES companies(id),
  issue_id        uuid NOT NULL REFERENCES stock_issues(id),
  stock_item_id   uuid NOT NULL REFERENCES stock_items(id),
  qty_requested   numeric(10,2) NOT NULL CHECK (qty_requested > 0),
  qty_issued      numeric(10,2) CHECK (qty_issued >= 0),
  photo_id        uuid REFERENCES photos(id)
);

-- Deliveries from suppliers into the stockroom.
CREATE TABLE stock_deliveries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL DEFAULT current_company() REFERENCES companies(id),
  supplier_id     uuid REFERENCES suppliers(id),
  supplier_name   text NOT NULL,
  reference       text NOT NULL,
  photo_id        uuid REFERENCES photos(id),
  received_by     uuid NOT NULL REFERENCES users(id),
  received_at     timestamptz NOT NULL
);

ALTER TABLE stock_return_lines ADD COLUMN photo_id uuid REFERENCES photos(id);
ALTER TABLE stock_movements ADD COLUMN issue_line_id uuid REFERENCES stock_issue_lines(id);
ALTER TABLE stock_movements ADD COLUMN delivery_id uuid REFERENCES stock_deliveries(id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['stock_issues', 'stock_issue_lines', 'stock_deliveries'] LOOP
    EXECUTE format('CREATE INDEX %I ON %I (company_id)', t || '_company_idx', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY company_isolation ON %I USING (company_id = current_company()) WITH CHECK (company_id = current_company())', t);
  END LOOP;
END $$;

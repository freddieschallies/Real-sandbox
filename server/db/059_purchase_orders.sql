-- Purchase orders for stock runs: the technician asks for one on his phone (supplier, parts, the job
-- or his van); the stock controller, admin, his department manager or the CEO approves it; he shows
-- the PO number at the supplier's counter and scans the slip against it, which books the parts to
-- the job. Pastel gets the PO through the direct link (with the office server); until then
-- pastel_sent_at stays empty.
CREATE TABLE purchase_orders (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL DEFAULT current_company() REFERENCES companies(id),
  po_number      integer NOT NULL DEFAULT next_company_number('purchase_order', 1001),
  technician_id  uuid NOT NULL REFERENCES users(id),
  supplier_id    uuid REFERENCES suppliers(id),
  supplier_name  text NOT NULL,
  job_id         uuid REFERENCES jobs(id),
  note           text,
  status         text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'approved', 'rejected', 'collected', 'cancelled')),
  requested_at   timestamptz NOT NULL DEFAULT now(),
  decided_by     uuid REFERENCES users(id),
  decided_at     timestamptz,
  decision_note  text,
  collected_at   timestamptz,
  pastel_sent_at timestamptz,
  pastel_ref     text,
  UNIQUE (company_id, po_number),
  CHECK (status NOT IN ('approved', 'rejected', 'collected') OR (decided_by IS NOT NULL AND decided_at IS NOT NULL)),
  CHECK (status <> 'rejected' OR length(trim(coalesce(decision_note, ''))) >= 3)
);
CREATE TABLE purchase_order_lines (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL DEFAULT current_company() REFERENCES companies(id),
  po_id          uuid NOT NULL REFERENCES purchase_orders(id),
  line_no        integer NOT NULL,
  stock_item_id  uuid REFERENCES stock_items(id),
  description    text NOT NULL,
  qty            numeric(10,2) NOT NULL CHECK (qty > 0),
  UNIQUE (po_id, line_no)
);
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['purchase_orders', 'purchase_order_lines'] LOOP
    EXECUTE format('CREATE INDEX %I ON %I (company_id)', t || '_company_idx', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY company_isolation ON %I USING (company_id = current_company()) WITH CHECK (company_id = current_company())', t);
  END LOOP;
END $$;

-- The slip scanned against a PO.
ALTER TABLE supplier_invoices ADD COLUMN purchase_order_id uuid REFERENCES purchase_orders(id);
CREATE UNIQUE INDEX supplier_invoices_one_po ON supplier_invoices (purchase_order_id) WHERE purchase_order_id IS NOT NULL AND status = 'confirmed';

-- Accounts: supplier invoices checked, approved and sent to Pastel; credit notes to Pastel too; each
-- supplier's Pastel code; and the last cost price of each stock item (for the clients' mark-up).

-- Pastel batches of credit notes and supplier invoices (supplier invoice numbers are text: refs).
ALTER TABLE pastel_batches DROP CONSTRAINT pastel_batches_kind_check;
ALTER TABLE pastel_batches ADD CONSTRAINT pastel_batches_kind_check CHECK (kind IN ('invoice', 'quote', 'credit', 'supplier_invoice'));
ALTER TABLE pastel_batches ADD COLUMN refs text[];

-- Credit notes are kept as issued (never changed), so which batch took each one is kept beside them.
CREATE TABLE credit_note_pastel (
  credit_note_id uuid PRIMARY KEY REFERENCES credit_notes(id),
  company_id     uuid NOT NULL DEFAULT current_company() REFERENCES companies(id),
  batch_id       uuid NOT NULL REFERENCES pastel_batches(id)
);
ALTER TABLE credit_note_pastel ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_note_pastel FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON credit_note_pastel USING (company_id = current_company()) WITH CHECK (company_id = current_company());

ALTER TABLE suppliers ADD COLUMN pastel_code text CHECK (length(pastel_code) <= 6);
CREATE UNIQUE INDEX suppliers_pastel_code ON suppliers (company_id, upper(pastel_code)) WHERE pastel_code IS NOT NULL;

-- Supplier invoices: a technician's till slip (counter) or one the office scanned (office: no
-- technician, no stock booked to anyone). Accounts checks each one: approved, or queried with a note.
ALTER TABLE supplier_invoices ALTER COLUMN technician_id DROP NOT NULL;
ALTER TABLE supplier_invoices ADD COLUMN source text NOT NULL DEFAULT 'counter' CHECK (source IN ('counter', 'office'));
ALTER TABLE supplier_invoices ADD COLUMN added_by uuid REFERENCES users(id);
ALTER TABLE supplier_invoices ADD COLUMN vat_cents integer CHECK (vat_cents >= 0);
ALTER TABLE supplier_invoices ADD COLUMN delivery_id uuid REFERENCES stock_deliveries(id);
ALTER TABLE supplier_invoices ADD COLUMN check_status text NOT NULL DEFAULT 'to_check' CHECK (check_status IN ('to_check', 'queried', 'approved'));
ALTER TABLE supplier_invoices ADD COLUMN check_note text;
ALTER TABLE supplier_invoices ADD COLUMN checked_by uuid REFERENCES users(id);
ALTER TABLE supplier_invoices ADD COLUMN checked_at timestamptz;
ALTER TABLE supplier_invoices ADD COLUMN pastel_batch_id uuid REFERENCES pastel_batches(id);
ALTER TABLE supplier_invoices ADD CONSTRAINT supplier_invoices_who CHECK (technician_id IS NOT NULL OR (source = 'office' AND added_by IS NOT NULL));
ALTER TABLE supplier_invoices ADD CONSTRAINT supplier_invoices_approved CHECK (check_status <> 'approved' OR status = 'confirmed');
CREATE UNIQUE INDEX supplier_invoices_one_delivery ON supplier_invoices (delivery_id) WHERE delivery_id IS NOT NULL;
-- An office invoice may have lines that are not stock (freight, a service).
ALTER TABLE supplier_invoice_lines ALTER COLUMN stock_item_id DROP NOT NULL;

-- What a stock item last cost (excluding VAT), from the supplier invoices: the clients' mark-up is on this.
ALTER TABLE stock_items ADD COLUMN cost_cents integer CHECK (cost_cents >= 0);
ALTER TABLE stock_items ADD COLUMN cost_at timestamptz;

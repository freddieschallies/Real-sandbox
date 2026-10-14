-- The stockroom: stock takes (count, differences, sign off, stock corrected) and ordering from
-- suppliers (purchase orders made from the order list, sent, and received against the delivery).

-- Suppliers' contact details, for sending them purchase orders.
ALTER TABLE suppliers ADD COLUMN email text, ADD COLUMN phone text, ADD COLUMN contact_name text;

-- Purchase orders the stockroom makes for its own stock (no technician, approved as made).
ALTER TABLE purchase_orders DROP CONSTRAINT purchase_orders_source_check;
ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_source_check CHECK (source IN ('app', 'group', 'stockroom'));
ALTER TABLE purchase_orders DROP CONSTRAINT purchase_orders_who;
ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_who CHECK (technician_id IS NOT NULL OR source IN ('group', 'stockroom'));
ALTER TABLE purchase_orders ADD COLUMN sent_at timestamptz, ADD COLUMN sent_to text[], ADD COLUMN sent_by uuid REFERENCES users(id), ADD COLUMN sent_how text CHECK (sent_how IN ('email', 'whatsapp', 'printed', 'phone'));
ALTER TABLE purchase_order_lines ADD COLUMN unit_price_cents integer CHECK (unit_price_cents >= 0), ADD COLUMN supplier_code text;
ALTER TABLE stock_deliveries ADD COLUMN purchase_order_id uuid REFERENCES purchase_orders(id);

-- Stock takes of the stockroom: everything, or one category; each count kept with who and when.
ALTER TABLE stocktakes ADD COLUMN category text CHECK (category IN ('stock', 'tool', 'ppe')), ADD COLUMN note text,
  ADD COLUMN signoff_note text, ADD COLUMN cancelled_at timestamptz, ADD COLUMN cancelled_by uuid REFERENCES users(id);
ALTER TABLE stocktake_lines ADD COLUMN counted_by uuid REFERENCES users(id), ADD COLUMN counted_at timestamptz, ADD COLUMN note text;
CREATE UNIQUE INDEX stocktakes_one_open ON stocktakes (company_id) WHERE scope = 'stockroom' AND signed_off_at IS NULL AND cancelled_at IS NULL;
ALTER TABLE stock_movements ADD COLUMN stocktake_id uuid REFERENCES stocktakes(id);

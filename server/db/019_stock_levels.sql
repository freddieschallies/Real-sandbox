-- The stockroom's order list: a minimum per item, how many to order, a photo of the part, and
-- whether it has been ordered (cleared when a delivery brings it in).
ALTER TABLE stock_items ADD COLUMN min_qty numeric(10,2) NOT NULL DEFAULT 0 CHECK (min_qty >= 0);
ALTER TABLE stock_items ADD COLUMN reorder_qty numeric(10,2) CHECK (reorder_qty > 0);
ALTER TABLE stock_items ADD COLUMN photo_id uuid REFERENCES photos(id);
ALTER TABLE stock_items ADD COLUMN supplier_name text;
ALTER TABLE stock_items ADD COLUMN ordered_at timestamptz;
ALTER TABLE stock_items ADD COLUMN ordered_qty numeric(10,2);
ALTER TABLE stock_items ADD COLUMN ordered_by uuid REFERENCES users(id);
ALTER TABLE stock_items ADD COLUMN ordered_note text;

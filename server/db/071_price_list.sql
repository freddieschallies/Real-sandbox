-- The price list: who last put up the reference picture of a part, and when.
ALTER TABLE stock_items
  ADD COLUMN photo_set_by uuid REFERENCES users(id),
  ADD COLUMN photo_set_at timestamptz;

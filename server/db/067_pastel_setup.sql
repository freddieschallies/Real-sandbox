-- Pastel's guided set-up: Pastel's own lists, given to the app once, so it matches the account codes itself.
CREATE TABLE pastel_lists (
  company_id  uuid NOT NULL DEFAULT current_company() REFERENCES companies(id),
  kind        text NOT NULL CHECK (kind IN ('customers', 'suppliers', 'accounts', 'items')),
  entries     jsonb NOT NULL,                 -- [{code, name}]
  filename    text,
  uploaded_by uuid NOT NULL REFERENCES users(id),
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, kind)
);
ALTER TABLE pastel_lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE pastel_lists FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON pastel_lists USING (company_id = current_company()) WITH CHECK (company_id = current_company());

-- A part's code in Pastel when it differs from the stockroom's own code (the stockroom code stays as it is).
ALTER TABLE stock_items ADD COLUMN pastel_code text CHECK (length(pastel_code) <= 15);
-- The practice import: what Pastel said if it did not work.
ALTER TABLE pastel_settings ADD COLUMN practice_note text;

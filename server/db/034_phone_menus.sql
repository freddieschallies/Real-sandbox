-- Which tabs are pinned to the bottom of the phone screen, per position (the rest go under More).
-- Set by the CEO or an admin; no row = the automatic choice.
CREATE TABLE phone_menus (
  company_id uuid NOT NULL DEFAULT current_company() REFERENCES companies(id),
  level      login_level NOT NULL,
  pinned     text[] NOT NULL CHECK (cardinality(pinned) BETWEEN 1 AND 4),
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, level)
);
ALTER TABLE phone_menus ENABLE ROW LEVEL SECURITY;
ALTER TABLE phone_menus FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON phone_menus USING (company_id = current_company()) WITH CHECK (company_id = current_company());

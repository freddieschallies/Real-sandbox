-- The CEO's start-up checklist: what they ticked as right (departments), skipped (stock, vehicles),
-- and whether the checklist is put away.
CREATE TABLE company_setup (
  company_id          uuid PRIMARY KEY DEFAULT current_company() REFERENCES companies(id),
  departments_checked boolean NOT NULL DEFAULT false,
  skipped             text[] NOT NULL DEFAULT '{}',
  dismissed_at        timestamptz,
  updated_by          uuid REFERENCES users(id),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE company_setup ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_setup FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON company_setup USING (company_id = current_company()) WITH CHECK (company_id = current_company());

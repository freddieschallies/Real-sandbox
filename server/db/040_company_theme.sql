-- The company's colour theme, chosen by the director (CEO): one of three. Light or dark is each
-- person's own choice on their device.
CREATE TABLE company_theme (
  company_id  uuid PRIMARY KEY DEFAULT current_company() REFERENCES companies(id),
  accent      text NOT NULL DEFAULT 'orange' CHECK (accent IN ('orange', 'blue', 'green')),
  updated_by  uuid REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE company_theme ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_theme FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON company_theme USING (company_id = current_company()) WITH CHECK (company_id = current_company());

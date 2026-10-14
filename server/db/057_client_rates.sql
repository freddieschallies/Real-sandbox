-- Each client's own rates (labour per hour, call-out, travel per km, travel per hour), each of which
-- can be switched off for that client, and its mark-up on parts in three price bands (the cheaper the
-- part, the higher the mark-up). Set by the CEO and Accounts. A client without its own uses the
-- company's rates.
CREATE TABLE client_rates (
  client_id   uuid PRIMARY KEY REFERENCES clients(id),
  company_id  uuid NOT NULL DEFAULT current_company() REFERENCES companies(id),
  rates       jsonb NOT NULL,
  markup      jsonb NOT NULL,
  updated_by  uuid NOT NULL REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE client_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_rates FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON client_rates USING (company_id = current_company()) WITH CHECK (company_id = current_company());

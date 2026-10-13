-- Store map points found by the app. A company imports its customers and their sites with addresses;
-- the server looks each address up on the map and pins it. A pin that only found the suburb, or that
-- came from a technician's first "Arrived" there, is marked for the office to check. A store without
-- a pin still works (Arrived is then not checked against the store).
ALTER TABLE stores ALTER COLUMN lat DROP NOT NULL;
ALTER TABLE stores ALTER COLUMN lng DROP NOT NULL;
ALTER TABLE stores ADD CONSTRAINT stores_pin_pair CHECK ((lat IS NULL) = (lng IS NULL));
ALTER TABLE stores
  ADD COLUMN pin_source  text NOT NULL DEFAULT 'manual' CHECK (pin_source IN ('manual', 'lookup', 'arrival', 'import', 'none')),
  ADD COLUMN pin_status  text NOT NULL DEFAULT 'ok' CHECK (pin_status IN ('ok', 'check', 'looking', 'not_found')),
  ADD COLUMN pin_note    text,
  ADD COLUMN pin_at      timestamptz,
  ADD COLUMN lookup_tries integer NOT NULL DEFAULT 0,
  ADD COLUMN phone       text;
ALTER TABLE stores ADD CONSTRAINT stores_pin_known CHECK (pin_status IN ('looking', 'not_found') OR lat IS NOT NULL);
CREATE INDEX stores_looking ON stores (company_id) WHERE pin_status = 'looking';

-- An uploaded customer list, kept until it is applied (the office checks the columns first).
CREATE TABLE customer_imports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL DEFAULT current_company() REFERENCES companies(id),
  filename    text,
  headers     jsonb NOT NULL,
  rows        jsonb NOT NULL,
  uploaded_by uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  applied_at  timestamptz,
  applied_by  uuid REFERENCES users(id),
  result      jsonb
);
ALTER TABLE customer_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_imports FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON customer_imports USING (company_id = current_company()) WITH CHECK (company_id = current_company());

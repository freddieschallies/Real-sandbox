-- Departments can be switched off (a business without refrigeration, or that doesn't do electrical)
-- and back on; their van stock list is kept. Every company starts with Admin (the office staff),
-- Electrical, Plumbing, Service and Foodservice (Refrigeration is there to switch on).
ALTER TABLE departments ADD COLUMN active boolean NOT NULL DEFAULT true;
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT id FROM companies LOOP
    PERFORM set_config('app.company_id', c.id::text, true);
    INSERT INTO departments (company_id, name)
      SELECT c.id, n FROM unnest(ARRAY['Admin', 'Electrical', 'Plumbing', 'Service', 'Foodservice']) AS n
       WHERE NOT EXISTS (SELECT 1 FROM departments d WHERE d.company_id = c.id AND lower(d.name) = lower(n));
  END LOOP;
  PERFORM set_config('app.company_id', '', true);
END $$;

-- Sending quotes and invoices to Sage Pastel Partner: each client's Pastel customer code, which
-- Pastel codes the non-stock lines go to, and the import batches made (each document once).
ALTER TABLE clients ADD COLUMN pastel_code text CHECK (length(pastel_code) <= 6);
CREATE UNIQUE INDEX clients_pastel_code ON clients (company_id, upper(pastel_code)) WHERE pastel_code IS NOT NULL;

CREATE TABLE pastel_settings (
  company_id      uuid PRIMARY KEY DEFAULT current_company() REFERENCES companies(id),
  year_start_month integer NOT NULL DEFAULT 3 CHECK (year_start_month BETWEEN 1 AND 12),
  tax_type        text NOT NULL DEFAULT '01' CHECK (tax_type ~ '^[0-9]{2}$'),
  codes           jsonb NOT NULL DEFAULT '{}',
  store           text CHECK (length(store) <= 3),
  updated_by      uuid NOT NULL REFERENCES users(id),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE pastel_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE pastel_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON pastel_settings USING (company_id = current_company()) WITH CHECK (company_id = current_company());

CREATE TABLE pastel_batches (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL DEFAULT current_company() REFERENCES companies(id),
  kind        text NOT NULL CHECK (kind IN ('invoice', 'quote')),
  numbers     integer[] NOT NULL,
  file        text NOT NULL,
  created_by  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE pastel_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE pastel_batches FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON pastel_batches USING (company_id = current_company()) WITH CHECK (company_id = current_company());
CREATE TRIGGER pastel_batches_immutable BEFORE UPDATE OR DELETE ON pastel_batches FOR EACH ROW EXECUTE FUNCTION forbid_change();

ALTER TABLE quotes ADD COLUMN pastel_batch_id uuid REFERENCES pastel_batches(id);
ALTER TABLE invoices ADD COLUMN pastel_batch_id uuid REFERENCES pastel_batches(id);

-- A sent quote or invoice can still be marked as sent to Pastel.
CREATE OR REPLACE FUNCTION document_locked() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN RAISE EXCEPTION '% % has been sent and cannot be deleted', TG_TABLE_NAME, OLD.id; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'draft' AND (to_jsonb(NEW) - ARRAY['status','accepted_at','declined_at','decision_note','resulting_job_id','paid_at','paid_ref','cancelled_at','cancel_note','updated_at','pastel_batch_id'])
                              <> (to_jsonb(OLD) - ARRAY['status','accepted_at','declined_at','decision_note','resulting_job_id','paid_at','paid_ref','cancelled_at','cancel_note','updated_at','pastel_batch_id']) THEN
    RAISE EXCEPTION 'a sent % cannot be changed', TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END $$;

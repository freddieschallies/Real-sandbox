-- Credit notes: an invoice already sent (or paid) is never changed; money given back is a credit note
-- against it, in full or in part, with the reason. Kept as issued.
CREATE TABLE credit_notes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL DEFAULT current_company() REFERENCES companies(id),
  credit_number  integer NOT NULL DEFAULT next_company_number('credit', 9001),
  invoice_id     uuid NOT NULL REFERENCES invoices(id),
  job_id         uuid NOT NULL REFERENCES jobs(id),
  amount_cents   bigint NOT NULL CHECK (amount_cents > 0),   -- excluding VAT
  vat_pct        numeric(4,2) NOT NULL,
  reason         text NOT NULL CHECK (length(trim(reason)) >= 5),
  created_by     uuid NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, credit_number)
);
ALTER TABLE credit_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_notes FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON credit_notes USING (company_id = current_company()) WITH CHECK (company_id = current_company());
CREATE TRIGGER credit_notes_immutable BEFORE UPDATE OR DELETE ON credit_notes FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- The office: editing jobs (every change logged on the job), the company's details for its
-- letterhead, and quotes and invoices.

-- Every change the office makes to a job, shown on the job card.
CREATE TABLE job_changes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL DEFAULT current_company() REFERENCES companies(id),
  job_id      uuid NOT NULL REFERENCES jobs(id),
  field       text NOT NULL,
  old_value   text,
  new_value   text,
  reason      text,
  changed_by  uuid NOT NULL REFERENCES users(id),
  changed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX job_changes_job ON job_changes (job_id, changed_at);
ALTER TABLE job_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_changes FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON job_changes USING (company_id = current_company()) WITH CHECK (company_id = current_company());
CREATE TRIGGER job_changes_immutable BEFORE UPDATE OR DELETE ON job_changes FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- The company's own details, printed on quotes and invoices.
CREATE TABLE company_profile (
  company_id    uuid PRIMARY KEY DEFAULT current_company() REFERENCES companies(id),
  legal_name    text NOT NULL,
  trading_name  text,
  reg_no        text,
  vat_no        text,
  address       text,
  phone         text,
  email         text,
  bank_details  text,
  quote_terms   text,
  invoice_terms text,
  logo_photo_id uuid REFERENCES photos(id),
  vat_pct       numeric(4,2) NOT NULL DEFAULT 15 CHECK (vat_pct >= 0 AND vat_pct <= 30),
  quote_valid_days integer NOT NULL DEFAULT 30 CHECK (quote_valid_days BETWEEN 1 AND 365),
  invoice_due_days integer NOT NULL DEFAULT 30 CHECK (invoice_due_days BETWEEN 0 AND 365),
  updated_by    uuid NOT NULL REFERENCES users(id),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE company_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_profile FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON company_profile USING (company_id = current_company()) WITH CHECK (company_id = current_company());
ALTER TYPE photo_kind ADD VALUE 'company_logo';

-- Quotes: for a job, or for a store before there is a job.
ALTER TABLE quotes ALTER COLUMN job_id DROP NOT NULL;
ALTER TABLE quotes ADD COLUMN store_id uuid REFERENCES stores(id);
ALTER TABLE quotes ADD COLUMN title text;
ALTER TABLE quotes ADD COLUMN notes text;
ALTER TABLE quotes ADD COLUMN client_ref text;
ALTER TABLE quotes ADD COLUMN valid_until date;
ALTER TABLE quotes ADD COLUMN vat_pct numeric(4,2) NOT NULL DEFAULT 15;
ALTER TABLE quotes ADD COLUMN declined_at timestamptz;
ALTER TABLE quotes ADD COLUMN decision_note text;
ALTER TABLE quotes ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE quotes ADD CONSTRAINT quotes_where CHECK (job_id IS NOT NULL OR store_id IS NOT NULL);

ALTER TABLE invoices ADD COLUMN notes text;
ALTER TABLE invoices ADD COLUMN client_ref text;
ALTER TABLE invoices ADD COLUMN due_date date;
ALTER TABLE invoices ADD COLUMN vat_pct numeric(4,2) NOT NULL DEFAULT 15;
ALTER TABLE invoices ADD COLUMN paid_at timestamptz;
ALTER TABLE invoices ADD COLUMN paid_ref text;
ALTER TABLE invoices ADD COLUMN cancelled_at timestamptz;
ALTER TABLE invoices ADD COLUMN cancel_note text;
ALTER TABLE invoices ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE invoices ADD CONSTRAINT invoices_cancel_noted CHECK (status <> 'cancelled' OR cancel_note IS NOT NULL);
CREATE UNIQUE INDEX invoices_one_per_job ON invoices (job_id) WHERE status <> 'cancelled';

ALTER TABLE document_lines ADD COLUMN position integer NOT NULL DEFAULT 0;
ALTER TABLE document_lines ADD COLUMN stock_item_id uuid REFERENCES stock_items(id);
ALTER TABLE document_lines ADD CONSTRAINT document_lines_price CHECK (unit_price_cents >= 0 AND qty > 0);

-- Once sent, a quote or invoice cannot be changed: only its status moves on.
CREATE FUNCTION document_locked() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN RAISE EXCEPTION '% % has been sent and cannot be deleted', TG_TABLE_NAME, OLD.id; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'draft' AND (to_jsonb(NEW) - ARRAY['status','accepted_at','declined_at','decision_note','resulting_job_id','paid_at','paid_ref','cancelled_at','cancel_note','updated_at'])
                              <> (to_jsonb(OLD) - ARRAY['status','accepted_at','declined_at','decision_note','resulting_job_id','paid_at','paid_ref','cancelled_at','cancel_note','updated_at']) THEN
    RAISE EXCEPTION 'a sent % cannot be changed', TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER quotes_locked BEFORE UPDATE OR DELETE ON quotes FOR EACH ROW EXECUTE FUNCTION document_locked();
CREATE TRIGGER invoices_locked BEFORE UPDATE OR DELETE ON invoices FOR EACH ROW EXECUTE FUNCTION document_locked();

CREATE FUNCTION document_lines_locked() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s doc_status;
BEGIN
  IF COALESCE(NEW.quote_id, OLD.quote_id) IS NOT NULL THEN
    SELECT status INTO s FROM quotes WHERE id = COALESCE(NEW.quote_id, OLD.quote_id);
  ELSE
    SELECT status INTO s FROM invoices WHERE id = COALESCE(NEW.invoice_id, OLD.invoice_id);
  END IF;
  IF s <> 'draft' THEN RAISE EXCEPTION 'lines of a sent document cannot be changed'; END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER document_lines_locked BEFORE INSERT OR UPDATE OR DELETE ON document_lines FOR EACH ROW EXECUTE FUNCTION document_lines_locked();

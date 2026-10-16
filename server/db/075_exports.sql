-- Every document the app makes (job card, quote, invoice, statement, PO, timesheet, report...) exported
-- as a PDF, a link for WhatsApp or an email: the page exactly as it went out, who made it and where it went.
CREATE TABLE doc_exports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL DEFAULT current_company() REFERENCES companies(id),
  kind        text NOT NULL,
  title       text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  ref         text,
  html        text NOT NULL,
  pdf_path    text,
  made_by     uuid NOT NULL REFERENCES users(id),
  made_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX doc_exports_made ON doc_exports (company_id, made_at DESC);
ALTER TABLE doc_exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE doc_exports FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON doc_exports USING (company_id = current_company()) WITH CHECK (company_id = current_company());

CREATE TABLE doc_export_sends (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL DEFAULT current_company() REFERENCES companies(id),
  export_id   uuid NOT NULL REFERENCES doc_exports(id),
  how         text NOT NULL CHECK (how IN ('download', 'link', 'email')),
  sent_to     text,
  sent_by     uuid NOT NULL REFERENCES users(id),
  sent_at     timestamptz NOT NULL DEFAULT now(),
  ok          boolean NOT NULL DEFAULT true,
  error       text
);
CREATE INDEX doc_export_sends_export ON doc_export_sends (export_id);
ALTER TABLE doc_export_sends ENABLE ROW LEVEL SECURITY;
ALTER TABLE doc_export_sends FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON doc_export_sends USING (company_id = current_company()) WITH CHECK (company_id = current_company());

-- What went out is never changed or deleted (only its PDF is filed once). It is its own record, so the
-- history does not copy the whole page again.
CREATE FUNCTION doc_exports_keep() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'exported documents are kept'; END IF;
  IF NEW.html IS DISTINCT FROM OLD.html OR NEW.title IS DISTINCT FROM OLD.title OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.ref IS DISTINCT FROM OLD.ref
     OR NEW.made_by IS DISTINCT FROM OLD.made_by OR NEW.made_at IS DISTINCT FROM OLD.made_at OR NEW.company_id IS DISTINCT FROM OLD.company_id
     OR (OLD.pdf_path IS NOT NULL AND NEW.pdf_path IS DISTINCT FROM OLD.pdf_path) THEN
    RAISE EXCEPTION 'exported documents are kept as they went out';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER doc_exports_keep BEFORE UPDATE OR DELETE ON doc_exports FOR EACH ROW EXECUTE FUNCTION doc_exports_keep();
CREATE TRIGGER doc_exports_no_truncate BEFORE TRUNCATE ON doc_exports FOR EACH STATEMENT EXECUTE FUNCTION history_refuse();

CREATE OR REPLACE FUNCTION history_watch_all() RETURNS integer LANGUAGE plpgsql AS $$
DECLARE t text; n integer := 0;
BEGIN
  FOR t IN
    SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables x USING (table_schema, table_name)
     WHERE c.table_schema = 'public' AND c.column_name = 'company_id' AND x.table_type = 'BASE TABLE'
       AND c.table_name NOT IN ('history', 'history_seals', 'audit_log', 'sync_requests', 'tracker_positions', 'notifications', 'log_views',
                                'tracker_driver_outbox', 'route_baselines', 'doc_exports')
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'history_watch' AND tgrelid = ('public.' || quote_ident(t))::regclass) THEN
      EXECUTE format('CREATE TRIGGER history_watch AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION history_capture()', t);
      n := n + 1;
    END IF;
  END LOOP;
  RETURN n;
END $$;

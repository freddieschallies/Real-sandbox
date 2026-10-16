-- The history: every change to the company's records (added, changed, deleted), who did it and when,
-- kept for good, for in case of fraud. Nothing in the app can change or delete it: the database
-- refuses, whoever asks. Each entry is sealed with the one before it (a chain of fingerprints), so
-- if anyone ever removed or altered an entry outside the app, the check shows exactly where.
-- (Each entry carries its own fingerprint; seals chain them, see history_seal.)
-- Only the Creator (the CEO) reads it.

CREATE TABLE history (
  id          bigint PRIMARY KEY,
  company_id  uuid NOT NULL REFERENCES companies(id),
  at          timestamptz NOT NULL,
  actor_id    uuid,
  actor_name  text,
  tbl         text NOT NULL,
  op          text NOT NULL CHECK (op IN ('add', 'change', 'delete')),
  row_id      text,
  old         jsonb,
  new         jsonb,
  hash        text NOT NULL
);
CREATE SEQUENCE history_id_seq OWNED BY history.id;
CREATE INDEX history_company_at ON history (company_id, at DESC);
CREATE INDEX history_company_row ON history (company_id, tbl, row_id);
ALTER TABLE history ENABLE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON history USING (company_id = current_company());

-- Seals: every few minutes the entries so far are chained together (each seal's fingerprint covers
-- every entry before it), so an entry taken out or slipped in later shows up at the check.
CREATE TABLE history_seals (
  id          bigserial PRIMARY KEY,
  company_id  uuid NOT NULL REFERENCES companies(id),
  upto_id     bigint NOT NULL,
  entries     bigint NOT NULL,          -- how many entries up to and including upto_id
  chain       text NOT NULL,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX history_seals_company ON history_seals (company_id, upto_id DESC);
ALTER TABLE history_seals ENABLE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON history_seals USING (company_id = current_company());

-- Never changed, never deleted.
CREATE FUNCTION history_refuse() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'the history cannot be changed or deleted';
END $$;
CREATE TRIGGER history_no_change BEFORE UPDATE OR DELETE ON history FOR EACH ROW EXECUTE FUNCTION history_refuse();
CREATE TRIGGER history_no_truncate BEFORE TRUNCATE ON history FOR EACH STATEMENT EXECUTE FUNCTION history_refuse();
CREATE TRIGGER seals_no_change BEFORE UPDATE OR DELETE ON history_seals FOR EACH ROW EXECUTE FUNCTION history_refuse();
CREATE TRIGGER seals_no_truncate BEFORE TRUNCATE ON history_seals FOR EACH STATEMENT EXECUTE FUNCTION history_refuse();
CREATE TRIGGER audit_no_change BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION history_refuse();
CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION history_refuse();

-- What is kept of a row: everything except secrets (passwords, codes, keys) and things that tick over
-- on their own every few seconds (seen_at, updated_at...).
CREATE FUNCTION history_clean(j jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(jsonb_object_agg(k, v), '{}'::jsonb) FROM jsonb_each(j) e(k, v)
   WHERE k !~ '(password|secret|token|_hash$|^qr_svg$|^seen_at$|^updated_at$|^last_[a-z_]*_at$|checked_at$|^groups$)'
$$;

-- An entry's fingerprint: everything in it.
CREATE FUNCTION history_fingerprint(id bigint, at timestamptz, company uuid, actor uuid, actor_name text, tbl text, op text, row_id text, old jsonb, new jsonb)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(sha256(convert_to(
    id || '|' || (extract(epoch FROM at) * 1000000)::bigint || '|' || company || '|' || coalesce(actor::text, '') || '|' ||
    coalesce(actor_name, '') || '|' || tbl || '|' || op || '|' || coalesce(row_id, '') || '|' || coalesce(old::text, '') || '|' || coalesce(new::text, ''), 'UTF8')), 'hex')
$$;

CREATE FUNCTION history_capture() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  o jsonb; n jsonb; cid uuid; actor uuid; aname text; rid text; hid bigint; hat timestamptz; kind text;
BEGIN
  IF TG_OP <> 'INSERT' THEN o := history_clean(to_jsonb(OLD)); END IF;
  IF TG_OP <> 'DELETE' THEN n := history_clean(to_jsonb(NEW)); END IF;
  IF TG_OP = 'UPDATE' AND o = n THEN RETURN NULL; END IF;
  cid := coalesce((coalesce(n, o) ->> 'company_id')::uuid, current_company());
  IF cid IS NULL THEN RETURN NULL; END IF;
  actor := nullif(current_setting('app.user_id', true), '')::uuid;
  IF actor IS NOT NULL THEN SELECT full_name INTO aname FROM users WHERE id = actor; END IF;
  rid := coalesce(coalesce(n, o) ->> 'id', coalesce(n, o) ->> 'user_id', coalesce(n, o) ->> 'job_id', coalesce(n, o) ->> 'stock_item_id');
  kind := CASE TG_OP WHEN 'INSERT' THEN 'add' WHEN 'UPDATE' THEN 'change' ELSE 'delete' END;
  hid := nextval('history_id_seq');
  hat := clock_timestamp();
  INSERT INTO history (id, company_id, at, actor_id, actor_name, tbl, op, row_id, old, new, hash)
  VALUES (hid, cid, hat, actor, aname, TG_TABLE_NAME, kind, rid, o, n, history_fingerprint(hid, hat, cid, actor, aname, TG_TABLE_NAME, kind, rid, o, n));
  RETURN NULL;
END $$;

-- Seals the entries older than `settle` (by then every change that took a number has been saved).
CREATE FUNCTION history_seal(cid uuid, settle interval DEFAULT interval '5 minutes') RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE last history_seals; c text; k bigint; r record; upto bigint := NULL;
BEGIN
  IF cid IS DISTINCT FROM current_company() THEN RAISE EXCEPTION 'only your own company''s history'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('history_seal:' || cid));
  SELECT * INTO last FROM history_seals WHERE company_id = cid ORDER BY upto_id DESC LIMIT 1;
  c := coalesce(last.chain, ''); k := coalesce(last.entries, 0);
  FOR r IN SELECT id, hash FROM history WHERE company_id = cid AND id > coalesce(last.upto_id, 0) AND at < now() - settle ORDER BY id LOOP
    c := encode(sha256(convert_to(c || r.hash, 'UTF8')), 'hex'); k := k + 1; upto := r.id;
  END LOOP;
  IF upto IS NULL THEN RETURN 0; END IF;
  INSERT INTO history_seals (company_id, upto_id, entries, chain) VALUES (cid, upto, k, c);
  RETURN k - coalesce(last.entries, 0);
END $$;

-- The check: every entry still as it was written, and none taken out or added in between.
CREATE FUNCTION history_verify(cid uuid) RETURNS TABLE (ok boolean, checked bigint, bad_id bigint, problem text) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record; s record; c text := ''; k bigint := 0; nxt int := 0;
  seals history_seals[];
BEGIN
  IF cid IS DISTINCT FROM current_company() THEN RAISE EXCEPTION 'only your own company''s history'; END IF;
  SELECT array_agg(x ORDER BY x.upto_id) INTO seals FROM history_seals x WHERE x.company_id = cid;
  nxt := 1;
  FOR r IN SELECT * FROM history h WHERE h.company_id = cid ORDER BY h.id LOOP
    IF r.hash <> history_fingerprint(r.id, r.at, r.company_id, r.actor_id, r.actor_name, r.tbl, r.op, r.row_id, r.old, r.new) THEN
      RETURN QUERY SELECT false, k, r.id, 'this entry was changed after it was written'; RETURN;
    END IF;
    IF seals IS NOT NULL AND nxt <= array_length(seals, 1) AND r.id > seals[nxt].upto_id THEN
      RETURN QUERY SELECT false, k, r.id, 'entries before this one were taken out'; RETURN;
    END IF;
    c := encode(sha256(convert_to(c || r.hash, 'UTF8')), 'hex'); k := k + 1;
    IF seals IS NOT NULL AND nxt <= array_length(seals, 1) AND r.id = seals[nxt].upto_id THEN
      IF c <> seals[nxt].chain OR k <> seals[nxt].entries THEN
        RETURN QUERY SELECT false, k, r.id, 'entries up to this one were taken out or added afterwards'; RETURN;
      END IF;
      nxt := nxt + 1;
    END IF;
  END LOOP;
  IF seals IS NOT NULL AND nxt <= array_length(seals, 1) THEN
    RETURN QUERY SELECT false, k, seals[nxt].upto_id, 'the newest sealed entries were taken out'; RETURN;
  END IF;
  RETURN QUERY SELECT true, k, NULL::bigint, NULL::text;
END $$;

-- Watches every table of company records (and any added later: run again after each migration).
CREATE FUNCTION history_watch_all() RETURNS integer LANGUAGE plpgsql AS $$
DECLARE t text; n integer := 0;
BEGIN
  FOR t IN
    SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables x USING (table_schema, table_name)
     WHERE c.table_schema = 'public' AND c.column_name = 'company_id' AND x.table_type = 'BASE TABLE'
       AND c.table_name NOT IN ('history', 'history_seals', 'audit_log', 'sync_requests', 'tracker_positions', 'notifications', 'log_views',
                                'tracker_driver_outbox', 'route_baselines')
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'history_watch' AND tgrelid = ('public.' || quote_ident(t))::regclass) THEN
      EXECUTE format('CREATE TRIGGER history_watch AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION history_capture()', t);
      n := n + 1;
    END IF;
  END LOOP;
  RETURN n;
END $$;

SELECT history_watch_all();

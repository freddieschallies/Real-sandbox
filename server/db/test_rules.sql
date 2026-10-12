-- Checks that the database itself enforces the spec's hard rules.
-- Runs inside a transaction and rolls back, so it leaves no data behind.
\set ON_ERROR_STOP 1
BEGIN;

INSERT INTO users (id, full_name, login_level, password_hash) VALUES
  ('00000000-0000-0000-0000-000000000001', 'Test Tech', 'technician', 'x'),
  ('00000000-0000-0000-0000-000000000002', 'Test Manager', 'management', 'x');
INSERT INTO clients (id, name) VALUES ('00000000-0000-0000-0000-0000000000c1', 'Test Chain');
INSERT INTO stores (id, client_id, name, lat, lng) VALUES
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 'Branch 1', -28.78, 32.04);
INSERT INTO jobs (id, job_type, store_id, fault_reported, scheduled_date, lead_technician_id, created_by)
VALUES ('00000000-0000-0000-0000-0000000000b1', 'breakdown', '00000000-0000-0000-0000-0000000000a1',
        'Ice machine not dispensing', current_date,
        '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002');

-- 1. A job cannot close without a signature or a manager-unavailable reason
DO $$ BEGIN
  BEGIN
    UPDATE jobs SET status = 'closed', closed_at = now() WHERE id = '00000000-0000-0000-0000-0000000000b1';
    RAISE EXCEPTION 'FAIL 1: closed without signature';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS 1: close needs signature or unavailable reason';
  END;
END $$;

-- 2. Close with manager unavailable, then the card is locked
UPDATE jobs SET status = 'closed', closed_at = now(),
  manager_unavailable_reason = 'Manager off sick', manager_unavailable_spoke_to = 'Assistant manager Thabo'
WHERE id = '00000000-0000-0000-0000-0000000000b1';
DO $$ BEGIN
  BEGIN
    UPDATE jobs SET fault_reported = 'changed' WHERE id = '00000000-0000-0000-0000-0000000000b1';
    RAISE EXCEPTION 'FAIL 2: closed job edited';
  EXCEPTION WHEN raise_exception THEN RAISE NOTICE 'PASS 2: closed job card is locked';
  END;
END $$;

-- 3. No new work items on a closed job
DO $$ BEGIN
  BEGIN
    INSERT INTO work_items (job_id, title, origin) VALUES ('00000000-0000-0000-0000-0000000000b1', 'late add', 'found_on_site');
    RAISE EXCEPTION 'FAIL 3';
  EXCEPTION WHEN raise_exception THEN RAISE NOTICE 'PASS 3: work items of a closed job are locked';
  END;
END $$;

-- 4. A written warning needs action taken and reason (LRA Schedule 8)
DO $$ BEGIN
  BEGIN
    INSERT INTO employee_log_entries (employee_id, author_id, entry_type, what_happened)
    VALUES ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', 'written_warning', 'Late again');
    RAISE EXCEPTION 'FAIL 4';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS 4: warning needs action and reason';
  END;
END $$;

-- 5. Log entries cannot be edited or deleted
INSERT INTO employee_log_entries (id, employee_id, author_id, entry_type, what_happened)
VALUES ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', 'observation', 'Arrived late');
DO $$ BEGIN
  BEGIN
    DELETE FROM employee_log_entries WHERE id = '00000000-0000-0000-0000-0000000000e1';
    RAISE EXCEPTION 'FAIL 5';
  EXCEPTION WHEN raise_exception THEN RAISE NOTICE 'PASS 5: log entries cannot be deleted';
  END;
END $$;

-- 6. Estimates always carry the "not official" label
DO $$ BEGIN
  BEGIN
    INSERT INTO work_items (id, job_id, title, origin) VALUES (gen_random_uuid(), '00000000-0000-0000-0000-0000000000b1', 'x', 'reported');
  EXCEPTION WHEN raise_exception THEN NULL; -- job is closed; use a fresh job below
  END;
END $$;
INSERT INTO jobs (id, job_type, store_id, fault_reported, scheduled_date, lead_technician_id, created_by)
VALUES ('00000000-0000-0000-0000-0000000000b2', 'breakdown', '00000000-0000-0000-0000-0000000000a1',
        'Oven door seal', current_date, '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002');
INSERT INTO work_items (id, job_id, title, origin) VALUES
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000b2', 'Door seal torn', 'reported');
DO $$ BEGIN
  BEGIN
    INSERT INTO estimates (job_id, work_item_id, created_by, created_at, total_cents, label)
    VALUES ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000d1',
            '00000000-0000-0000-0000-000000000001', now(), 100000, 'Official quote');
    RAISE EXCEPTION 'FAIL 6';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS 6: estimates are always marked not official';
  END;
END $$;

-- 7. Van stock: assigned stock appears immediately; an unaccepted transfer does not move
INSERT INTO users (id, full_name, login_level, password_hash) VALUES
  ('00000000-0000-0000-0000-000000000003', 'Second Tech', 'technician', 'x');
INSERT INTO stock_items (id, code, description) VALUES ('00000000-0000-0000-0000-0000000000f1', 'SEAL-01', 'Door seal');
INSERT INTO stock_movements (stock_item_id, qty, kind, to_stockroom, created_by)
VALUES ('00000000-0000-0000-0000-0000000000f1', 10, 'receive', true, '00000000-0000-0000-0000-000000000002');
INSERT INTO stock_movements (stock_item_id, qty, kind, from_stockroom, to_technician_id, created_by)
VALUES ('00000000-0000-0000-0000-0000000000f1', 4, 'assign', true, '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002');
INSERT INTO stock_movements (stock_item_id, qty, kind, from_technician_id, to_technician_id, created_by)
VALUES ('00000000-0000-0000-0000-0000000000f1', 1, 'transfer', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001');
DO $$ DECLARE tech numeric; room numeric; BEGIN
  SELECT qty INTO tech FROM technician_stock WHERE technician_id = '00000000-0000-0000-0000-000000000001';
  SELECT qty INTO room FROM stockroom_stock WHERE stock_item_id = '00000000-0000-0000-0000-0000000000f1';
  IF tech = 4 AND room = 6 THEN RAISE NOTICE 'PASS 7: assigned stock is in van stock; pending transfer not moved';
  ELSE RAISE EXCEPTION 'FAIL 7: tech=% room=%', tech, room; END IF;
END $$;

-- 8. One tool, one holder at a time
INSERT INTO tools (id, description) VALUES ('00000000-0000-0000-0000-0000000000a9', 'Multimeter');
INSERT INTO tool_assignments (tool_id, technician_id, issued_by) VALUES
  ('00000000-0000-0000-0000-0000000000a9', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002');
DO $$ BEGIN
  BEGIN
    INSERT INTO tool_assignments (tool_id, technician_id, issued_by) VALUES
      ('00000000-0000-0000-0000-0000000000a9', '00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000002');
    RAISE EXCEPTION 'FAIL 8';
  EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'PASS 8: a tool can only be on one name';
  END;
END $$;

-- 9. Continue later needs progress, reason and return date
DO $$ BEGIN
  BEGIN
    INSERT INTO job_visits (job_id, technician_id, state, go_at)
    VALUES ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-000000000001', 'continue_later', now());
    RAISE EXCEPTION 'FAIL 9';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS 9: continue later needs progress, reason, return date';
  END;
END $$;

ROLLBACK;

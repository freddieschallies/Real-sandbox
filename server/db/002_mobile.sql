-- What the phone app needs: offline-safe replays, notices, tracker outbox, supply run approval.
BEGIN;

-- A phone that was offline replays its queued requests. Each carries an Idempotency-Key;
-- a key seen before returns the stored response instead of doing the work twice.
CREATE TABLE sync_requests (
  user_id         uuid NOT NULL REFERENCES users(id),
  idem_key        text NOT NULL CHECK (length(idem_key) BETWEEN 8 AND 100),
  method          text NOT NULL,
  url             text NOT NULL,
  status_code     integer NOT NULL,
  response        text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, idem_key)
);

-- Notices (not flags): "Thabo took Sipho's usual vehicle", "new supplier to review", ...
CREATE TABLE notifications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id    uuid NOT NULL REFERENCES users(id),
  kind            text NOT NULL,
  message         text NOT NULL,
  details         jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  read_at         timestamptz
);
CREATE INDEX notifications_unread ON notifications (recipient_id) WHERE read_at IS NULL;

-- Driver changes waiting for the tracker connection to write them into the Tracking Africa portal.
CREATE TABLE tracker_driver_outbox (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id      uuid NOT NULL REFERENCES vehicles(id),
  driver_id       uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  done_at         timestamptz,
  error           text
);

-- Supply runs: who approved a van-stock top-up, and the run's own status.
CREATE TYPE supply_status AS ENUM ('awaiting_approval', 'approved', 'collected', 'cancelled');
ALTER TABLE supply_runs ADD COLUMN status supply_status NOT NULL DEFAULT 'approved';
ALTER TABLE supply_runs ADD COLUMN approved_at timestamptz;

-- Photos: size and type of the stored file.
ALTER TABLE photos ADD COLUMN content_type text;
ALTER TABLE photos ADD COLUMN bytes integer;

-- Work items may be created on the phone while offline, so ids can come from the phone.
-- (uuid columns already accept a supplied id; nothing to change.)

COMMIT;

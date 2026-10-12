-- A cancelled job keeps everything that happened on it; it just leaves the technician's day.
ALTER TABLE jobs ADD COLUMN cancelled_at timestamptz;
ALTER TABLE jobs ADD COLUMN cancelled_by uuid REFERENCES users(id);
ALTER TABLE jobs ADD COLUMN cancel_note text;
ALTER TABLE jobs ADD CONSTRAINT jobs_cancel_noted CHECK (status <> 'cancelled' OR (cancel_note IS NOT NULL AND cancelled_at IS NOT NULL));

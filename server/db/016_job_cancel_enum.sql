-- The office can cancel a job that should not go ahead (added on its own: Postgres cannot use a
-- new enum value in the same transaction).
ALTER TYPE job_status ADD VALUE 'cancelled';

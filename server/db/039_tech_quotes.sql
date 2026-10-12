-- Technicians submit quotes: on one of their jobs that is not finished, or from scratch for a store
-- with an older job card linked for reference. The office checks, prices and sends them.
ALTER TABLE quotes ADD COLUMN from_technician boolean NOT NULL DEFAULT false;
ALTER TABLE quotes ADD COLUMN reference_job_id uuid REFERENCES jobs(id);

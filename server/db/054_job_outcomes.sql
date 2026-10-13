-- How a job ended, for the money side too: invoiced (and paid or credited), closed at no charge
-- (with the reason: warranty, a callback on our own work, goodwill, covered by a contract, no fault
-- found), or cancelled, and by whom (the client, or us).
ALTER TABLE jobs ADD COLUMN cancelled_by_party text CHECK (cancelled_by_party IN ('client', 'us'));

-- A closed job card stays locked; "no charge" is the office's billing decision about it, kept beside it.
CREATE TABLE job_no_charge (
  job_id      uuid PRIMARY KEY REFERENCES jobs(id),
  company_id  uuid NOT NULL DEFAULT current_company() REFERENCES companies(id),
  reason      text NOT NULL CHECK (reason IN ('warranty', 'callback', 'goodwill', 'contract', 'no_fault', 'other')),
  note        text,
  decided_by  uuid NOT NULL REFERENCES users(id),
  decided_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (reason <> 'other' OR length(trim(coalesce(note, ''))) >= 3)
);
ALTER TABLE job_no_charge ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_no_charge FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON job_no_charge USING (company_id = current_company()) WITH CHECK (company_id = current_company());

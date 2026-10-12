-- How long vehicle photos are kept. Fault and damage photos (and handover signatures): 2 years.
-- Routine inspection photos where nothing new was found: 90 days, except the vehicle's latest
-- inspection, which is always kept as the starting point for the next handover. Only the picture
-- file is removed; the record of the inspection (km, fuel, checks, who signed) stays for good.
ALTER TABLE photos ADD COLUMN purged_at timestamptz;
ALTER TABLE photos ADD COLUMN purge_reason text;
ALTER TABLE photos ADD CONSTRAINT photos_purge_reason CHECK (purged_at IS NULL OR purge_reason IS NOT NULL);
CREATE INDEX photos_retention ON photos (kind, taken_at) WHERE purged_at IS NULL;

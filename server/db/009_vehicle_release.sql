-- A technician releases a vehicle from his name: km and where it is left are recorded.
ALTER TABLE odometer_readings DROP CONSTRAINT odometer_readings_source_check;
ALTER TABLE odometer_readings ADD CONSTRAINT odometer_readings_source_check CHECK (source IN ('handover', 'fleet_job', 'mechanic', 'release'));
ALTER TABLE vehicle_scans ADD COLUMN release_km integer CHECK (release_km >= 0);
ALTER TABLE vehicle_scans ADD COLUMN release_place text;
ALTER TABLE vehicle_scans ADD COLUMN release_note text;

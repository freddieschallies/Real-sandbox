-- What kind of technician someone is (for now: foodservice tech, plumber, electrician, assistant).
ALTER TABLE users ADD COLUMN trade text CHECK (trade IN ('foodservice', 'plumber', 'electrician', 'assistant'));

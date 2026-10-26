-- A machine booked into the workshop by the office (the client brought it in, or we collected it),
-- not only uplifted from site by a technician.
ALTER TABLE machine_moves DROP CONSTRAINT IF EXISTS machine_moves_kind_check;
ALTER TABLE machine_moves ADD CONSTRAINT machine_moves_kind_check CHECK (kind IN ('uplifted', 'booked_in', 'delivered', 'loan_out', 'loan_back'));

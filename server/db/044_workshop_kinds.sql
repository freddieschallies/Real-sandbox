-- Workshop repairs: a job type for machines repaired in our workshop, a visit state for a machine
-- uplifted from site, and photos for upliftment, loan machines and delivery back.
ALTER TYPE job_type ADD VALUE 'workshop_repair';
ALTER TYPE visit_state ADD VALUE 'uplifted';
ALTER TYPE photo_kind ADD VALUE 'uplift';
ALTER TYPE photo_kind ADD VALUE 'loan';
ALTER TYPE photo_kind ADD VALUE 'delivery';

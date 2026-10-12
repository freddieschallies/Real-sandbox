-- Profile pictures (added on their own: Postgres cannot use a new enum value in the same transaction).
ALTER TYPE photo_kind ADD VALUE 'profile';

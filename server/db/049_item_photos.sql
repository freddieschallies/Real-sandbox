-- Every vehicle has a profile picture, and every tool and ladder in the tool store a picture of how it
-- looks (stock items and people already have theirs).
ALTER TABLE vehicles ADD COLUMN photo_id uuid REFERENCES photos(id);
ALTER TABLE store_tools ADD COLUMN photo_id uuid REFERENCES photos(id);

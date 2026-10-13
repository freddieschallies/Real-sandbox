-- The stockroom's tools and ladders: a flag when one is not signed back, and the signature picture.
ALTER TYPE flag_type ADD VALUE 'tool_not_returned';
ALTER TYPE photo_kind ADD VALUE 'tool_signature';

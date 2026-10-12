-- Tools and PPE issued to a person come out of (and go back into) the stockroom.
ALTER TYPE movement_kind ADD VALUE 'issue_kit';
ALTER TYPE movement_kind ADD VALUE 'return_kit';

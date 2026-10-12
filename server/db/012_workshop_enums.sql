-- New values for the workshop stock (013). Added on their own: Postgres cannot use a new enum value in the same transaction.
ALTER TYPE movement_kind ADD VALUE 'use_on_fleet';
ALTER TYPE movement_kind ADD VALUE 'workshop_loss';
ALTER TYPE flag_type ADD VALUE 'workshop_stock_short';

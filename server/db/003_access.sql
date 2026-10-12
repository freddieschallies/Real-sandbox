-- The CEO decides who has access to what: changes per login type and per person,
-- on top of the defaults in the code. Every change is kept in an append-only history.
BEGIN;

CREATE TYPE access_effect AS ENUM ('grant', 'deny');
CREATE TYPE access_scope AS ENUM ('own_department', 'all_departments', 'selected_departments');

CREATE TABLE access_overrides (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  level           login_level,
  user_id         uuid REFERENCES users(id),
  action          text NOT NULL,
  effect          access_effect NOT NULL,
  scope           access_scope,
  department_ids  uuid[] NOT NULL DEFAULT '{}',
  set_by          uuid NOT NULL REFERENCES users(id),
  set_at          timestamptz NOT NULL DEFAULT now(),
  CHECK ((level IS NULL) <> (user_id IS NULL)),
  CHECK (scope <> 'selected_departments' OR cardinality(department_ids) > 0)
);
CREATE UNIQUE INDEX access_overrides_level ON access_overrides (level, action) WHERE level IS NOT NULL;
CREATE UNIQUE INDEX access_overrides_user ON access_overrides (user_id, action) WHERE user_id IS NOT NULL;

CREATE TABLE access_changes (
  id              bigserial PRIMARY KEY,
  changed_by      uuid NOT NULL REFERENCES users(id),
  level           login_level,
  user_id         uuid REFERENCES users(id),
  action          text NOT NULL,
  change          text NOT NULL,          -- 'grant all_departments', 'deny', 'back to default', ...
  at              timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER access_changes_immutable BEFORE UPDATE OR DELETE ON access_changes
  FOR EACH ROW EXECUTE FUNCTION forbid_change();

-- Pricing access given earlier moves into the new system.
INSERT INTO access_overrides (user_id, action, effect, set_by, set_at)
SELECT user_id, 'set_prices', 'grant', granted_by, granted_at FROM user_permissions WHERE permission = 'pricing';
DROP TABLE user_permissions;
DROP TYPE extra_permission;

COMMIT;

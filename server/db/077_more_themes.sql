-- More colour themes, and the company's own colour (#rrggbb, e.g. from its logo).
ALTER TABLE company_theme DROP CONSTRAINT IF EXISTS company_theme_accent_check;
ALTER TABLE company_theme ADD CONSTRAINT company_theme_accent_check
  CHECK (accent IN ('orange', 'blue', 'green', 'teal', 'sky', 'indigo', 'purple', 'pink', 'red', 'copper', 'yellow', 'lime', 'slate') OR accent ~ '^#[0-9A-Fa-f]{6}$');

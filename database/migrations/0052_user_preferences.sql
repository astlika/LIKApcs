-- 0.29.4: per-account display preferences of the phone app (theme, text size). Saved on the
-- account, so the same username sees the same settings on any phone.
CREATE TABLE user_preferences (
  user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data       jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

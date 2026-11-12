-- 0.20.0: looks. Each PC can override the house customer-screen look (widget size, position,
-- style, colour theme, ads on/off) and have its own lock-screen wallpaper. Reusable layouts
-- ("presets") store a set of house `client.*` settings under a name, so the Admin can apply
-- the same look to every PC in one step.

ALTER TABLE stations
  ADD COLUMN look jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(look) = 'object'),
  ADD COLUMN wallpaper_file text
    CHECK (wallpaper_file IS NULL OR wallpaper_file ~ '^[a-z0-9]{24}\.(jpg|png|webp|gif)$');

CREATE TABLE client_layout_presets (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL UNIQUE CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
  settings   jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(settings) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL
);

CREATE TRIGGER client_layout_presets_set_updated_at BEFORE UPDATE ON client_layout_presets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

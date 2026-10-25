-- 0.23.0: a desktop wallpaper per PC (the Windows desktop background, set by the client). The
-- lock-screen wallpaper (`wallpaper_file`) stays as it was.
ALTER TABLE stations ADD COLUMN IF NOT EXISTS desktop_wallpaper_file text;

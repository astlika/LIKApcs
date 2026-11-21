-- 0.35.1 — the countdown widget stays on the screen during a game.
--
-- "Hide in games" (client.widget_hide_in_games, 0.19.7) was on by default, and an installation
-- keeps the value it has stored: the widget went away in every fullscreen game, which the owners
-- read as "the widget does not stay". 0.35.0 turned the default off for new installations only.
-- This turns the stored value off once; the switch stays in Settings › Client screen for whoever
-- wants the widget hidden while a game runs.
UPDATE settings SET value = 'false', updated_at = now()
 WHERE key = 'client.widget_hide_in_games' AND value = 'true';

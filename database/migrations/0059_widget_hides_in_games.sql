-- 0.35.3 — the countdown widget hides again while a game holds the screen.
--
-- 0058 (0.35.1) turned "hide in games" (client.widget_hide_in_games) off in every installation,
-- so that the widget would stay on a game. With the widget left on the screen, games in exclusive
-- fullscreen (CS2 at a resolution of its own) lost the screen and minimized as soon as they were
-- entered. Up to 0.34.0 the widget was hidden during a game and games ran. This puts the stored
-- value back on, once; the switch stays in Settings › Client screen for whoever runs the games in
-- "Fullscreen Windowed" and wants the widget on them.
UPDATE settings SET value = 'true', updated_at = now()
 WHERE key = 'client.widget_hide_in_games' AND value = 'false';

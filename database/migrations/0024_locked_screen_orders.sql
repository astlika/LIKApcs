-- 0024 — orders from a locked PC (0.14.0)
--
-- The menu can be browsed and ordered from the lock screen, before a session starts: the order
-- carries no session (`station_orders.session_id` has been nullable since 0020) and is settled
-- at the desk — or put on the bill once a session is running on that PC. Switchable.

INSERT INTO settings (key, value) VALUES
  ('orders.locked_screen', 'true');

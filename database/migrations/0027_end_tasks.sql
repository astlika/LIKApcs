-- 0.17.0 · End Task: close the games / launchers on a PC from the desk.
--
-- The owner lists the programs (name.exe) in Settings › Stations; the client never closes
-- anything else (and never itself). Optionally the server sends the same command by itself
-- whenever a session ends ("auto", default off). The last run per PC is kept in memory by the
-- server (it only matters until the next session starts) — nothing else is stored.
INSERT INTO settings (key, value) VALUES
  ('stations.end_tasks_exes', '[]'),
  ('stations.end_tasks_auto', 'false')
ON CONFLICT (key) DO NOTHING;

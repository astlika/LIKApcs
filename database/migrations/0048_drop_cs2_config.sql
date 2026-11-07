-- 0.25.0: the CS2 match server was removed. Its one-row config table goes with it
-- (it held the server and RCON passwords).
DROP TABLE IF EXISTS cs2_config;

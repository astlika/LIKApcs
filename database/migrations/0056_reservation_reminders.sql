-- 0.33.4 (reservations): a booking no longer marks its PCs from the moment it is made. Each booking
-- carries its own reminder lead: from `starts_at - remind_minutes` the desk is reminded and the PC
-- is kept for the booking (a start on it asks who sits down); before that the PC is free for anyone
-- and a session on it does not touch the booking.
ALTER TABLE reservations
  ADD COLUMN remind_minutes integer NOT NULL DEFAULT 10 CHECK (remind_minutes BETWEEN 0 AND 240);

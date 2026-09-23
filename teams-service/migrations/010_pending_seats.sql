-- Pending licensed-seat decreases apply at next billing period end.
ALTER TABLE teams ADD COLUMN pending_seat_quantity INTEGER;

-- Distinguish an unpriced model (`cost_known = 0`) from a genuinely free call
-- whose reported or estimated cost is exactly zero (`cost_known = 1`).
--
-- Legacy positive values necessarily came from a price/report and remain known.
-- A legacy zero is ambiguous, so migration classifies it conservatively as
-- unknown rather than presenting invented certainty on the Usage page.

ALTER TABLE usage_events
  ADD COLUMN cost_known INTEGER NOT NULL DEFAULT 0 CHECK (cost_known IN (0, 1));

UPDATE usage_events
   SET cost_known = 1
 WHERE cost_usd > 0;

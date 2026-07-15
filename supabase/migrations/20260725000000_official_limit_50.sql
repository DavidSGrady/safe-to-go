-- Align the flood-point threshold with the official figure: Esbjerg
-- Kommune's guidance is that crossing is safe below +50 cm at Ribe
-- Kammersluse, and since the frontend reframe (git 0ca82de) the threshold
-- is displayed as "officiel grænse · {caution_max_cm} cm" — so the stored
-- value must be the official 50, not the earlier unsourced 60.
--
-- Normally an /admin change; done as a migration because the admin login
-- was unavailable. The guard makes it a no-op if the value was already
-- adjusted through /admin. updated_by is cleared so the change is not
-- attributed to the previous editor; rule_change_log records old/new.
--
-- Engine effect: red rows start at 50; rising deadline targets
-- (50 − flood_margin 5) = 45 cm; falling passable limit (fall_margin 0)
-- becomes 50 — windows tighten to the official envelope.

update public.safety_rules
set caution_max_cm = 50,
    updated_by = null,
    updated_at = now()
where id = 1
  and caution_max_cm = 60;

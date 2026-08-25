-- The conversation a visitor builds for themselves before they ever open
-- WhatsApp.
--
-- It cannot live on the tenant: every trial lead shares one demo number, so
-- one tenant row would mean one shared conversation and the last person to
-- press save would rewrite everyone else's. It hangs off the signup code
-- instead, which is already the thing that binds a browser session to the
-- phone number that messages in.

alter table signup_tokens add column if not exists flow jsonb;

-- Which starter they began from, purely so we can see which vertical the
-- people trying the demo actually come from.
alter table signup_tokens add column if not exists flow_template text;

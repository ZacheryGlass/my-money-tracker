-- Historically enforced a GLOBAL unique merchant_key so concurrent expense
-- syncs could not double-insert. Superseded by the per-user index in
-- 029_user_scoping_enforce.sql; this file must stay a no-op (migrations
-- re-run every boot, and recreating the old global index here would break
-- two users tracking the same merchant).
SELECT 1;

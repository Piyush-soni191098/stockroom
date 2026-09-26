-- Supabase Cron (pg_cron) runs the sweep inside the database every 15 minutes.
-- cron.schedule upserts by job name, so re-running this migration is harmless.
create extension if not exists pg_cron with schema pg_catalog;
select cron.schedule('inventory-reconcile', '*/15 * * * *', 'select public.reconcile()');

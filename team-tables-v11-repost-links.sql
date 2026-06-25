-- v11 — liens directs des reposts par plateforme. 100% ADDITIF + snapshot. Aucune suppression.
-- Permet à chaque frère d'enregistrer le lien direct de son post (Snap Spotlight, URL Twitter, etc.)
-- pour générer le message de partage avec les vrais liens (pas le lien YouTube).
create table if not exists public.team_video_reposts_backup_20260625 as select * from public.team_video_reposts;

alter table public.team_video_reposts add column if not exists direct_url text;

-- vérif : les totaux doivent être identiques
select 'reposts'    q, count(*) n from public.team_video_reposts
union all
select 'reposts_bk' q, count(*) n from public.team_video_reposts_backup_20260625;

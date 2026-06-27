// Équipe Dawah — Edge Function sync-youtube (Deno / Supabase)
// Déclenchée par pg_cron (toutes les 2h). Synchronise les chaînes YouTube actives vers team_videos.
// La clé YouTube est lue depuis public.team_config (key='yt_api_key') via service_role
// (non lisible par anon → jamais exposée). Réplique la logique de syncChannel() du client.

import { createClient } from "npm:@supabase/supabase-js@2.45.0";

const SB_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const CODE = "0000";
const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

function durSec(d: string): number {
  if (!d) return 0;
  const m = d.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return (+(m[1] || 0)) * 3600 + (+(m[2] || 0)) * 60 + (+(m[3] || 0));
}

Deno.serve(async (_req: Request) => {
  // 1) clé YouTube depuis team_config (service_role bypasse RLS)
  const { data: cfg } = await sb.from("team_config").select("value").eq("key", "yt_api_key").maybeSingle();
  const YT = cfg?.value;
  if (!YT) {
    return new Response(JSON.stringify({ ok: false, error: "Clé YouTube absente de team_config (key='yt_api_key')." }), { status: 400, headers: { "Content-Type": "application/json" } });
  }

  // 2) chaînes actives
  const { data: channels, error: chErr } = await sb.from("team_channels")
    .select("key,uploads_playlist_id,active").eq("code", CODE).eq("active", true).order("sort");
  if (chErr) {
    return new Response(JSON.stringify({ ok: false, error: "Lecture team_channels: " + chErr.message }), { status: 500, headers: { "Content-Type": "application/json" } });
  }

  const out: any[] = [];
  let grand = 0;

  for (const ch of (channels || [])) {
    if (!ch.uploads_playlist_id) { out.push({ ch: ch.key, skip: "no playlist" }); continue; }

    // ids déjà connus (dédup)
    const known: Record<string, number> = {};
    const { data: ex } = await sb.from("team_videos").select("yt_id").eq("code", CODE).eq("channel_key", ch.key).limit(5000);
    (ex || []).forEach((v: any) => (known[v.yt_id] = 1));

    let token = "", pages = 0, scanned = 0;
    let apiErr: string | null = null;
    const toAdd: any[] = [], byId: Record<string, any> = {}, needDur: string[] = [];

    do {
      const u = "https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=50&playlistId=" +
        ch.uploads_playlist_id + "&key=" + YT + (token ? "&pageToken=" + token : "");
      const j = await (await fetch(u)).json();
      if (j.error) { apiErr = (j.error.errors && j.error.errors[0] && j.error.errors[0].reason) || j.error.message; break; }
      for (const it of (j.items || [])) {
        scanned++;
        const sn = it.snippet || {};
        const vid = sn.resourceId && sn.resourceId.videoId;
        if (!vid || known[vid]) continue;
        known[vid] = 1;
        const th = sn.thumbnails || {};
        const row = {
          code: CODE, title: sn.title || "(sans titre)", url: "https://www.youtube.com/watch?v=" + vid, yt_id: vid,
          thumbnail_url: (th.high || th.medium || th.default || {}).url || null, channel_key: ch.key,
          kind: "appel", published_at: sn.publishedAt || null, is_short: null, added_by: "auto",
        };
        toAdd.push(row); byId[vid] = row; needDur.push(vid);
      }
      token = j.nextPageToken || ""; pages++;
    } while (token && pages < 40);

    // durées → Shorts
    for (let b = 0; b < needDur.length; b += 50) {
      try {
        const dj = await (await fetch("https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=" +
          needDur.slice(b, b + 50).join(",") + "&key=" + YT)).json();
        for (const it of (dj.items || [])) {
          const sec = durSec(it.contentDetails && it.contentDetails.duration);
          if (byId[it.id]) byId[it.id].is_short = (sec > 0 && sec <= 60);
        }
      } catch (_) { /* ignore */ }
    }

    // insertion par lots
    let insErr: string | null = null;
    for (let i = 0; i < toAdd.length; i += 100) {
      const { error } = await sb.from("team_videos").insert(toAdd.slice(i, i + 100));
      if (error) insErr = error.message;
    }

    out.push({ ch: ch.key, scanned, added: toAdd.length, apiErr, insErr });
    grand += toAdd.length;
  }

  return new Response(JSON.stringify({ ok: true, total_added: grand, channels: out, at: new Date().toISOString() }), { headers: { "Content-Type": "application/json" } });
});

// Synchro serveur des chaînes YouTube → Supabase (lancé par GitHub Actions, cron).
// Réplique la logique de syncChannel() de l'app : pour chaque chaîne active de team_channels,
// récupère les vidéos de la playlist "uploads", déduplique, classe les Shorts (durée ≤ 60s),
// et insère les nouvelles dans team_videos. La clé YouTube vient d'un secret GitHub (YT_API_KEY).
const SB = "https://lpvuklsxnrqliarwvmst.supabase.co";
const SK = "sb_publishable_OMWOk-Vvkr_2JGle1oz0kg_d1JLntHJ"; // clé publishable (publique par design)
const YT = process.env.YT_API_KEY;
const CODE = "0000";

if (!YT) { console.error("❌ Secret YT_API_KEY manquant."); process.exit(1); }

const sb = (path, opts = {}) =>
  fetch(SB + "/rest/v1/" + path, {
    ...opts,
    headers: { apikey: SK, Authorization: "Bearer " + SK, "Content-Type": "application/json", ...(opts.headers || {}) },
  });

function durSec(d) {
  if (!d) return 0;
  const m = d.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return (+(m[1] || 0)) * 3600 + (+(m[2] || 0)) * 60 + (+(m[3] || 0));
}

const channels = await (await sb("team_channels?select=key,uploads_playlist_id,active&code=eq." + CODE + "&active=eq.true&order=sort")).json();
if (!Array.isArray(channels)) { console.error("❌ Lecture team_channels:", channels); process.exit(1); }

let grandTotal = 0;
for (const ch of channels) {
  if (!ch.uploads_playlist_id) continue;
  // ids déjà connus pour cette chaîne (dédup)
  const known = {};
  const ex = await (await sb("team_videos?select=yt_id&code=eq." + CODE + "&channel_key=eq." + ch.key + "&limit=5000")).json();
  (Array.isArray(ex) ? ex : []).forEach((v) => (known[v.yt_id] = 1));

  let token = "", pages = 0;
  const toAdd = [], byId = {}, needDur = [];
  do {
    const u = "https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=50&playlistId=" +
      ch.uploads_playlist_id + "&key=" + YT + (token ? "&pageToken=" + token : "");
    const j = await (await fetch(u)).json();
    if (j.error) { console.error(ch.key, "API:", j.error.message); break; }
    for (const it of (j.items || [])) {
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
    } catch (e) { /* ignore */ }
  }

  // insertion par lots de 100
  for (let i = 0; i < toAdd.length; i += 100) {
    const r = await sb("team_videos", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(toAdd.slice(i, i + 100)) });
    if (r.status >= 300) console.error(ch.key, "insert HTTP", r.status, (await r.text()).slice(0, 200));
  }
  console.log(ch.key + " : +" + toAdd.length + " vidéo(s)");
  grandTotal += toAdd.length;
}
console.log("✅ Total nouvelles vidéos :", grandTotal);

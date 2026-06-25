// Équipe Dawah — Edge Function send-push v7 (Deno / Supabase)
// Déclenchée par Database Webhooks sur INSERT/UPDATE dans
//   team_ideas, team_idea_comments, team_releases, team_meetings.
// Envoie une web push aux frères du même code (exclut l'auteur).
//
// Releases (Quoi de neuf v6) :
//   - INSERT status='draft'        → push uniquement à Bilal (texte "prête à publier")
//   - UPDATE draft→published       → push à tous sauf shipped_by ("✨ Nouveauté · …")
//   - autres transitions           → ignorées
//
// Secrets requis (Edge Functions → Secrets) :
//   DAWAH_VAPID_PUBLIC, DAWAH_VAPID_PRIVATE, DAWAH_VAPID_SUBJECT (mailto:...)
// SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY sont injectés automatiquement.

import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2.45.0";

const VAPID_PUBLIC  = Deno.env.get("DAWAH_VAPID_PUBLIC")  ?? "";
const VAPID_PRIVATE = Deno.env.get("DAWAH_VAPID_PRIVATE") ?? "";
const VAPID_SUBJECT = Deno.env.get("DAWAH_VAPID_SUBJECT") ?? "mailto:laadissa.bilalpro@gmail.com";
const SB_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

// Frère désigné comme owner des drafts (= reçoit la notif "prête à publier")
const RELEASE_OWNER = "Bilal";

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
}
const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

function truncate(s: string, n: number) {
  s = String(s ?? "");
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// Pure : titre selon table + record (testable séparément).
export function pushTitle(table: string, record: any, op: "INSERT"|"UPDATE" = "INSERT"): string {
  const author = (record && (record.author || record.created_by)) || "Quelqu'un";
  if (table === "team_ideas") {
    const kind = (record && record.kind) || "idee";
    if (kind === "amelioration") return `🛠️ ${author} propose une amélioration`;
    return `💡 ${author} propose une idée`;
  }
  if (table === "team_idea_comments") {
    return `💬 ${author} a commenté`;
  }
  if (table === "team_releases") {
    const t = truncate(record?.title || "Nouveauté", 60);
    if (op === "INSERT" || record?.status === "draft") {
      return `📝 Nouvelle release prête · ${t}`;
    }
    return `✨ Nouveauté · ${t}`;
  }
  if (table === "team_meetings") {
    return `📹 ${author} propose une visio`;
  }
  return "L'Appel — Équipe";
}

Deno.serve(async (req: Request) => {
  // Healthcheck
  if (req.method === "GET") {
    return new Response(
      JSON.stringify({ ok: true, fn: "send-push", version: "v7", configured: !!(VAPID_PUBLIC && VAPID_PRIVATE && SB_KEY) }),
      { headers: { "Content-Type": "application/json" } },
    );
  }

  let body: any;
  try { body = await req.json(); }
  catch { return new Response(JSON.stringify({ error: "invalid json" }), { status: 400, headers: { "Content-Type": "application/json" } }); }

  // Supabase Database Webhook payload : { type, table, record, schema, old_record }
  const type   = body?.type as ("INSERT"|"UPDATE"|"DELETE"|undefined);
  const table  = body?.table;
  const record = body?.record;
  const oldRec = body?.old_record;
  if (!record || !record.code) {
    return new Response(JSON.stringify({ ignored: "no record / code" }), { headers: { "Content-Type": "application/json" } });
  }

  let title = "", bodyText = "", urlPath = "./", author = "", routing: "all-except-author"|"solo-owner" = "all-except-author";

  if (table === "team_ideas") {
    if (type !== "INSERT") return new Response(JSON.stringify({ ignored: "team_ideas " + type }), { headers: { "Content-Type": "application/json" } });
    author   = record.author || "";
    title    = pushTitle(table, record, type as any);
    bodyText = truncate(record.text || "", 120);
    urlPath  = `?idea=${record.id}`;
  } else if (table === "team_idea_comments") {
    if (type !== "INSERT") return new Response(JSON.stringify({ ignored: "team_idea_comments " + type }), { headers: { "Content-Type": "application/json" } });
    author   = record.author || "";
    let ideaText = "";
    let ideaKind = "idee";
    try {
      const { data } = await sb.from("team_ideas").select("text,kind").eq("id", record.idea_id).maybeSingle();
      ideaText = data?.text || "";
      ideaKind = data?.kind || "idee";
    } catch (_) { /* ignore */ }
    title    = pushTitle(table, record, type as any);
    const ctx = ideaText
      ? ` — sur ${ideaKind === "amelioration" ? "l'amélioration" : "l'idée"} : « ${truncate(ideaText, 40)} »`
      : "";
    bodyText = `${truncate(record.text || "", 80)}${ctx}`;
    urlPath  = `?idea=${record.idea_id}`;
  } else if (table === "team_releases") {
    // CAS 1 — INSERT d'un draft → notif solo owner (« prête à publier »)
    if (type === "INSERT" && record.status === "draft") {
      author   = ""; // pas de filtre par auteur ici (la notif va au owner directement)
      title    = pushTitle(table, record, "INSERT");
      bodyText = truncate(record.body || record.title || "", 120);
      urlPath  = `?reviewRelease=${record.id}`;
      routing  = "solo-owner";
    }
    // CAS 2 — UPDATE qui passe draft→published → notif publique
    else if (type === "UPDATE" && oldRec?.status === "draft" && record.status === "published") {
      author = record.shipped_by || "";
      title  = pushTitle(table, record, "UPDATE");
      // Suffixe "Répond à : … (N idées)" si idées liées
      let suffix = "";
      try {
        const { data: links } = await sb.from("team_release_ideas")
          .select("idea_id, team_ideas(text)")
          .eq("release_id", record.id);
        if (links && links.length) {
          const titres = links.map((l: any) => l.team_ideas?.text || "").filter(Boolean).slice(0, 2)
                              .map((t: string) => `« ${truncate(t, 30)} »`).join(", ");
          const extra = links.length > 2 ? ` +${links.length - 2} autre${links.length - 2 > 1 ? "s" : ""}` : "";
          suffix = titres ? ` — Répond à : ${titres}${extra}` : "";
        }
      } catch (_) { /* ignore */ }
      bodyText = `${truncate(record.body || record.title || "", 100)}${suffix}`;
      urlPath  = `?release=${record.id}`;
      routing  = "all-except-author";
    }
    // Toute autre transition → ignorée
    else {
      return new Response(JSON.stringify({ ignored: `team_releases ${type} status=${record.status} old=${oldRec?.status}` }), { headers: { "Content-Type": "application/json" } });
    }
  } else if (table === "team_meetings") {
    // Nouvelle visio proposée → notif à tous sauf l'organisateur ("signale ta présence")
    if (type !== "INSERT") return new Response(JSON.stringify({ ignored: "team_meetings " + type }), { headers: { "Content-Type": "application/json" } });
    author   = record.created_by || "";
    title    = pushTitle(table, record, "INSERT");
    bodyText = truncate(record.title || "", 120) + " — signale ta présence 🙏";
    urlPath  = `?meeting=${record.id}`;
    routing  = "all-except-author";
  } else {
    return new Response(JSON.stringify({ ignored: "table " + table }), { headers: { "Content-Type": "application/json" } });
  }

  // Sélection des souscriptions
  let q = sb.from("team_push_subs").select("id,endpoint,p256dh,auth,member").eq("code", record.code);
  if (routing === "solo-owner") {
    q = q.eq("member", RELEASE_OWNER);
  } else if (author) {
    q = q.neq("member", author);
  }
  const { data: subs, error: subErr } = await q;
  if (subErr) {
    return new Response(JSON.stringify({ error: subErr.message }), { status: 500, headers: { "Content-Type": "application/json" } });
  }

  const payload = JSON.stringify({ title, body: bodyText, url: urlPath, code: record.code });
  let sent = 0, failed = 0, removed = 0;

  for (const s of subs || []) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload,
        { TTL: 60 * 60 * 24 }, // 24h
      );
      sent++;
    } catch (e: any) {
      const sc = e?.statusCode || 0;
      if (sc === 404 || sc === 410) {
        await sb.from("team_push_subs").delete().eq("id", s.id);
        removed++;
      } else {
        failed++;
        console.error("push fail", sc, e?.body || e?.message);
      }
    }
  }

  return new Response(
    JSON.stringify({ sent, failed, removed, total: subs?.length || 0, table, type, title, routing }),
    { headers: { "Content-Type": "application/json" } },
  );
});

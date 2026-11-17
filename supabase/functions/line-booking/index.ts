const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": Deno.env.get("LINE_LIFF_ORIGIN") || "*",
    },
  });

const text = (value: unknown, limit = 300) =>
  String(value ?? "").trim().slice(0, limit);

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "access-control-allow-origin": Deno.env.get("LINE_LIFF_ORIGIN") || "*",
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type",
      },
    });
  }
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const liffChannelId = Deno.env.get("LINE_LIFF_CHANNEL_ID");
  if (!supabaseUrl || !serviceKey || !liffChannelId) {
    return json({ error: "LINE booking integration is not configured" }, 503);
  }

  let input: Record<string, unknown>;
  try {
    input = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const idToken = text(input.idToken, 5000);
  if (!idToken) return json({ error: "Missing LINE ID token" }, 401);

  // Verify the LIFF token with LINE. Never trust a user ID supplied by the browser.
  const verifyBody = new URLSearchParams({ id_token: idToken, client_id: liffChannelId });
  const verified = await fetch("https://api.line.me/oauth2/v2.1/verify", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: verifyBody,
  });
  if (!verified.ok) return json({ error: "LINE identity verification failed" }, 401);
  const identity = await verified.json();
  const lineUserId = text(identity.sub, 100);
  if (!lineUserId || identity.aud !== liffChannelId) {
    return json({ error: "LINE identity does not match this LIFF channel" }, 401);
  }

  const restHeaders = {
    apikey: serviceKey,
    authorization: `Bearer ${serviceKey}`,
    "content-type": "application/json",
  };
  const linksUrl = new URL(`${supabaseUrl}/rest/v1/household_line_links`);
  linksUrl.searchParams.set("line_user_id", `eq.${lineUserId}`);
  linksUrl.searchParams.set("select", "branch_id,household_id,line_display_name,customer_payload");
  const linksResponse = await fetch(linksUrl, { headers: restHeaders });
  if (!linksResponse.ok) return json({ error: "Could not read household LINE binding" }, 500);
  const links = await linksResponse.json();
  const link = Array.isArray(links) ? links[0] : null;
  if (!link) return json({ error: "This LINE account is not linked to a household" }, 403);

  const preferredDate = text(input.preferredDate, 10);
  const desiredTonnage = text(input.desiredTonnage, 30);
  const installationAddress = text(input.installationAddress, 300);
  if (!desiredTonnage || !installationAddress) {
    return json({ error: "desiredTonnage and installationAddress are required" }, 422);
  }
  if (preferredDate && !/^\d{4}-\d{2}-\d{2}$/.test(preferredDate)) {
    return json({ error: "preferredDate must use YYYY-MM-DD" }, 400);
  }

  const customer = link.customer_payload && typeof link.customer_payload === "object"
    ? link.customer_payload as Record<string, unknown>
    : {};
  const existingUrl = new URL(`${supabaseUrl}/rest/v1/confirmed_cases`);
  existingUrl.searchParams.set("branch_id", `eq.${link.branch_id}`);
  existingUrl.searchParams.set("customer_id", `eq.${link.household_id}`);
  existingUrl.searchParams.set("select", "payload");
  const existingResponse = await fetch(existingUrl, { headers: restHeaders });
  if (!existingResponse.ok) return json({ error: "Could not check existing replacement case" }, 500);
  const existingRows = await existingResponse.json();
  const existingPayload = Array.isArray(existingRows) ? existingRows[0]?.payload : null;
  if (existingPayload?.source === "LINE" && existingPayload?.progress !== "已取消") {
    return json({
      ok: true,
      bookingId: existingPayload.lineBookingId,
      status: "already_confirmed",
    });
  }

  const now = new Date().toISOString();
  const bookingId = `AC-${now.slice(0, 10).replaceAll("-", "")}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const payload = {
    ...customer,
    id: link.household_id,
    district: text(customer.district ?? input.district, 80),
    year: customer.year ?? customer.install_year ?? "",
    repairs: customer.repairs ?? customer.repair_count_24m ?? "",
    source: "LINE",
    lineUserId,
    lineDisplayName: text(link.line_display_name || identity.name || "LINE 已綁定", 80),
    lineBookingId: bookingId,
    lineBookingAt: now,
    progress: "LINE 預約成立",
    confirmedAt: now,
    booking: {
      oldTonnage: text(input.oldTonnage, 30),
      desiredTonnage,
      installationAddress,
      outdoorUnitLocation: text(input.outdoorUnitLocation, 100),
      preferredDate,
      contactPhone: text(input.contactPhone, 30),
    },
  };

  const upsertUrl = new URL(`${supabaseUrl}/rest/v1/confirmed_cases`);
  upsertUrl.searchParams.set("on_conflict", "branch_id,customer_id");
  const saved = await fetch(upsertUrl, {
    method: "POST",
    headers: { ...restHeaders, prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([{
      branch_id: link.branch_id,
      customer_id: link.household_id,
      payload,
      updated_at: now,
      updated_by: null,
    }]),
  });
  if (!saved.ok) {
    return json({ error: "Could not create the confirmed replacement case" }, 502);
  }

  return new Response(JSON.stringify({ ok: true, bookingId, status: "confirmed" }), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": Deno.env.get("LINE_LIFF_ORIGIN") || "*",
    },
  });
});

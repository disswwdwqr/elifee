import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders, "Content-Type": "application/json" },
});

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "Only POST is supported." }, 405);

  const authorization = request.headers.get("Authorization");
  const projectUrl = Deno.env.get("SUPABASE_URL");
  const publishable = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  const googleKey = Deno.env.get("GOOGLE_MAPS_API_KEY");
  if (!authorization || !projectUrl || !publishable) return json({ error: "Service is not configured." }, 503);
  if (!googleKey) return json({ error: "Google Maps Routes API secret is missing." }, 503);

  const supabase = createClient(projectUrl, publishable, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) return json({ error: "Sign-in required." }, 401);

  let input: any;
  try { input = await request.json(); } catch { return json({ error: "Invalid JSON." }, 400); }
  const branchId = String(input.branchId ?? "").trim();
  const origin = input.origin;
  const stops = input.stops;
  if (!branchId || !origin || !Array.isArray(stops) || stops.length < 1 || stops.length > 25) {
    return json({ error: "Provide a branch, origin, and 1–25 stops." }, 400);
  }
  const inRange = (point: any) => Number.isFinite(point?.lat) && Number.isFinite(point?.lng)
    && point.lat >= -90 && point.lat <= 90 && point.lng >= -180 && point.lng <= 180;
  if (!inRange(origin) || stops.some((stop: any) => !inRange(stop))) return json({ error: "Coordinates are invalid." }, 400);

  const { data: membership, error: membershipError } = await supabase
    .from("branch_memberships").select("branch_id").eq("user_id", authData.user.id).eq("branch_id", branchId).maybeSingle();
  if (membershipError || !membership) return json({ error: "You do not have access to this branch." }, 403);

  const waypoint = (point: any) => ({ location: { latLng: { latitude: point.lat, longitude: point.lng } } });
  const body: Record<string, unknown> = {
    origin: waypoint(origin),
    destination: waypoint(origin),
    intermediates: stops.map(waypoint),
    travelMode: "DRIVE",
    routingPreference: "TRAFFIC_AWARE",
    optimizeWaypointOrder: true,
  };
  const timeMatch = String(input.timeWindow ?? "").match(/^(\d{2}):(\d{2})/);
  if (timeMatch && /^\d{4}-\d{2}-\d{2}$/.test(String(input.departureDate ?? ""))) {
    const departure = new Date(`${input.departureDate}T${timeMatch[1]}:${timeMatch[2]}:00+08:00`);
    const hoursAway = (departure.getTime() - Date.now()) / 3_600_000;
    if (Number.isFinite(departure.getTime()) && hoursAway >= 0 && hoursAway <= 7 * 24) body.departureTime = departure.toISOString();
  }

  const response = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": googleKey,
      "X-Goog-FieldMask": "routes.distanceMeters,routes.duration,routes.staticDuration,routes.optimizedIntermediateWaypointIndex",
    },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) return json({ error: result?.error?.message ?? "Google Routes request failed." }, response.status);
  const route = result?.routes?.[0];
  if (!route) return json({ error: "No drivable route was found." }, 404);
  const optimizedIndexes: number[] = route.optimizedIntermediateWaypointIndex ?? stops.map((_: unknown, i: number) => i);
  return json({
    optimizedIds: optimizedIndexes.map((index) => stops[index]?.id).filter(Boolean),
    distanceMeters: route.distanceMeters ?? 0,
    durationSeconds: Number.parseFloat(String(route.duration ?? "0s").replace(/s$/, "")) || 0,
    staticDurationSeconds: Number.parseFloat(String(route.staticDuration ?? "0s").replace(/s$/, "")) || 0,
    departureTimeUsed: body.departureTime ?? null,
  });
});

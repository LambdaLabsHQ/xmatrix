const ALLOWED_AVATAR_HOSTS = new Set(["lh3.googleusercontent.com"]);
const MAX_AVATAR_BYTES = 1024 * 1024;

export async function GET(request: Request) {
  const rawUrl = new URL(request.url).searchParams.get("url");
  const avatarUrl = parseAllowedAvatarUrl(rawUrl);
  if (!avatarUrl) {
    return Response.json({ error: "Unsupported avatar URL" }, { status: 400 });
  }

  const response = await fetchAllowedAvatar(avatarUrl);
  if (!response || !response.ok) {
    return Response.json({ error: "Avatar unavailable" }, { status: 502 });
  }

  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (!contentType?.startsWith("image/") || contentType === "image/svg+xml") {
    return Response.json({ error: "Unsupported avatar content type" }, { status: 415 });
  }

  const contentLength = Number(response.headers.get("content-length") || "0");
  if (contentLength > MAX_AVATAR_BYTES) {
    return Response.json({ error: "Avatar too large" }, { status: 413 });
  }

  const body = await response.arrayBuffer();
  if (body.byteLength > MAX_AVATAR_BYTES) {
    return Response.json({ error: "Avatar too large" }, { status: 413 });
  }

  return new Response(body, {
    headers: {
      "content-type": contentType,
      "cache-control": "public, max-age=86400, stale-while-revalidate=604800",
    },
  });
}

function parseAllowedAvatarUrl(rawUrl: string | null): URL | undefined {
  if (!rawUrl) return undefined;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" || !ALLOWED_AVATAR_HOSTS.has(url.hostname)) {
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
}

async function fetchAllowedAvatar(url: URL): Promise<Response | undefined> {
  let current = url;
  for (let redirects = 0; redirects < 3; redirects++) {
    const response = await fetch(current, {
      headers: {
        accept: "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8",
      },
      redirect: "manual",
    });
    if (response.status < 300 || response.status >= 400) {
      return response;
    }
    const location = response.headers.get("location");
    if (!location) return undefined;
    const next = parseAllowedAvatarUrl(new URL(location, current).toString());
    if (!next) return undefined;
    current = next;
  }
  return undefined;
}

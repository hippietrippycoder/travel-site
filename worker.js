// Trip Site Worker — serves the static pages and adds a small document
// library backed by an R2 bucket (flight bookings, hotel confirmations,
// safari tickets, etc).
//
// Routes handled here:
//   GET  /api/documents        -> list uploaded documents (JSON)
//   POST /api/upload           -> upload a document (multipart/form-data)
//   POST /api/delete           -> delete a document (JSON body)
//   GET  /files/<key>          -> download/view a stored document
//   *    everything else       -> falls through to the static assets

const CATEGORIES = new Set(["flights", "hotels", "safari", "other"]);
const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB per file

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json; charset=utf-8", ...(init.headers || {}) },
  });
}

function safeName(name) {
  return (name || "file").replace(/[^\w.\-]+/g, "_").slice(-140);
}

async function listDocuments(env) {
  const items = [];
  let cursor;
  do {
    const page = await env.DOCS_BUCKET.list({ cursor, include: ["customMetadata", "httpMetadata"] });
    for (const obj of page.objects) {
      const meta = obj.customMetadata || {};
      const category = meta.category || obj.key.split("/")[0] || "other";
      items.push({
        key: obj.key,
        category: CATEGORIES.has(category) ? category : "other",
        name: meta.originalName || obj.key.split("/").slice(1).join("/"),
        note: meta.note || "",
        size: obj.size,
        type: obj.httpMetadata?.contentType || "",
        uploaded: (meta.uploadedAt || obj.uploaded?.toISOString?.() || ""),
        url: "/files/" + obj.key.split("/").map(encodeURIComponent).join("/"),
      });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  items.sort((a, b) => (b.uploaded || "").localeCompare(a.uploaded || ""));
  return items;
}

async function handleUpload(request, env) {
  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ error: "Could not read upload — please try again." }, { status: 400 });
  }

  const passphrase = String(form.get("passphrase") || "");
  if (!env.UPLOAD_PASSPHRASE || passphrase !== env.UPLOAD_PASSPHRASE) {
    return json({ error: "Wrong passphrase." }, { status: 401 });
  }

  const file = form.get("file");
  if (!(file && typeof file.arrayBuffer === "function")) {
    return json({ error: "No file was attached." }, { status: 400 });
  }
  if (file.size === 0) {
    return json({ error: "That file is empty." }, { status: 400 });
  }
  if (file.size > MAX_FILE_BYTES) {
    return json({ error: "That file is larger than the 20 MB limit." }, { status: 413 });
  }

  let category = String(form.get("category") || "other").toLowerCase();
  if (!CATEGORIES.has(category)) category = "other";
  const note = String(form.get("note") || "").slice(0, 200);

  const originalName = safeName(file.name);
  const key = `${category}/${Date.now()}-${originalName}`;

  await env.DOCS_BUCKET.put(key, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type || "application/octet-stream" },
    customMetadata: {
      originalName: file.name || originalName,
      category,
      note,
      uploadedAt: new Date().toISOString(),
    },
  });

  return json({ ok: true, key });
}

async function handleDelete(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Bad request." }, { status: 400 });
  }
  const passphrase = String(body.passphrase || "");
  if (!env.UPLOAD_PASSPHRASE || passphrase !== env.UPLOAD_PASSPHRASE) {
    return json({ error: "Wrong passphrase." }, { status: 401 });
  }
  const key = String(body.key || "");
  if (!key) return json({ error: "Missing key." }, { status: 400 });

  await env.DOCS_BUCKET.delete(key);
  return json({ ok: true });
}

async function handleDownload(pathname, env) {
  const key = decodeURIComponent(pathname.replace(/^\/files\//, ""));
  const obj = await env.DOCS_BUCKET.get(key);
  if (!obj) return new Response("Not found", { status: 404 });

  const filename = obj.customMetadata?.originalName || key.split("/").pop();
  const headers = new Headers();
  headers.set("content-type", obj.httpMetadata?.contentType || "application/octet-stream");
  headers.set("content-disposition", `inline; filename="${filename.replace(/"/g, "")}"`);
  headers.set("cache-control", "private, max-age=0, must-revalidate");
  return new Response(obj.body, { headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    try {
      if (pathname === "/api/documents" && request.method === "GET") {
        return json({ documents: await listDocuments(env) });
      }
      if (pathname === "/api/debug" && request.method === "GET") {
        // Temporary — reports whether the secret is bound and how long it is,
        // never the value itself. Safe to leave reachable while troubleshooting.
        const val = env.UPLOAD_PASSPHRASE;
        return json({
          secretConfigured: typeof val === "string" && val.length > 0,
          secretLength: typeof val === "string" ? val.length : 0,
          bucketConfigured: !!env.DOCS_BUCKET,
        });
      }
      if (pathname === "/api/upload" && request.method === "POST") {
        return await handleUpload(request, env);
      }
      if (pathname === "/api/delete" && request.method === "POST") {
        return await handleDelete(request, env);
      }
      if (pathname.startsWith("/files/") && request.method === "GET") {
        return await handleDownload(pathname, env);
      }
    } catch (err) {
      return json({ error: "Something went wrong: " + err.message }, { status: 500 });
    }

    // Everything else is a plain static page.
    return env.ASSETS.fetch(request);
  },
};

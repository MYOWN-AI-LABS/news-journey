import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchConfiguredPublicApis,
  parsePublicApisMarkdown,
  searchPublicApiCatalog,
} from "./public-apis.js";

const catalogFixture = `
### News
API | Description | Auth | HTTPS | CORS |
|:---|:---|:---|:---|:---|
| [Spaceflight News](https://spaceflightnewsapi.net) | Spaceflight related news | No | Yes | Yes |
### Weather
API | Description | Auth | HTTPS | CORS |
|:---|:---|:---|:---|:---|
| [Example Weather](https://weather.example.test/docs) | Forecast data | \`apiKey\` | Yes | Unknown |
`;

test("Public APIs catalog parser preserves discovery metadata and filters it", () => {
  const entries = parsePublicApisMarkdown(catalogFixture);
  assert.equal(entries.length, 2);
  assert.deepEqual(searchPublicApiCatalog(entries, { query: "spaceflight", auth: ["none"], httpsOnly: true }), [entries[0]]);
  assert.deepEqual(searchPublicApiCatalog(entries, { categories: ["Weather"] }), [entries[1]]);
});

test("configured public API JSON is mapped into provenance-preserving harvest items", async () => {
  process.env.TEST_PUBLIC_API_TOKEN = "test-token";
  try {
    const items = await fetchConfiguredPublicApis(
      {
        endpoints: [{
          id: "example-news",
          name: "Example News",
          url: "https://api.example.test/v1/articles",
          itemPath: "results",
          maxItems: 1,
          headerEnv: { Authorization: "TEST_PUBLIC_API_TOKEN" },
          fields: { title: "title", url: "url", summary: "summary", publishedAt: "published_at", score: "score" },
        }],
      },
      async (_url, init) => {
        assert.equal((init?.headers as Record<string, string>).Authorization, "test-token");
        return new Response(JSON.stringify({ results: [
          { title: "Verified API story", url: "https://source.example.test/story", summary: "Primary-source summary", published_at: "2026-08-17T12:00:00Z", score: 8 },
          { title: "Second story", url: "https://source.example.test/second" },
        ] }), { status: 200, headers: { "content-type": "application/json" } });
      }
    );
    assert.equal(items.length, 1);
    assert.equal(items[0].source, "public-api:example-news");
    assert.equal(items[0].url, "https://source.example.test/story");
    assert.equal(items[0].score, 8);
    assert.equal(items[0].publishedAt, "2026-08-17T12:00:00.000Z");
  } finally {
    delete process.env.TEST_PUBLIC_API_TOKEN;
  }
});

test("configured public APIs reject unsafe targets and missing provenance", async () => {
  await assert.rejects(
    fetchConfiguredPublicApis({ endpoints: [{ id: "local-api", name: "Local", url: "http://127.0.0.1/data", fields: { title: "title", url: "url" } }] }),
    /HTTPS/
  );
  await assert.rejects(
    fetchConfiguredPublicApis({ endpoints: [{ id: "missing-url", name: "Missing", url: "https://api.example.test/data", fields: { title: "title" } }] }),
    /fields.url or canonicalUrl/
  );
});

/**
 * Discovered live against a real endpoint (Launch Library 2): leaving an optional field unmapped
 * must never leak the record. readPath("", path) with an UNSET path returns the WHOLE value — that
 * is exactly what an unset itemPath needs ("no path" means "the payload is already the array") —
 * but reused unguarded for a per-record optional field, it stringifies the entire raw record (image
 * URLs, internal ids, license metadata) into that field instead of leaving it empty.
 */
test("an endpoint that omits an optional field ships an empty value, never the raw record", async () => {
  const items = await fetchConfiguredPublicApis(
    {
      endpoints: [{
        id: "no-optional-fields",
        name: "No Optional Fields",
        url: "https://api.example.test/v1/items",
        canonicalUrl: "https://api.example.test/docs",
        itemPath: "results",
        // summary, publishedAt, and score are all deliberately omitted.
        fields: { title: "title" },
      }],
    },
    async () => new Response(JSON.stringify({
      results: [{ title: "Item with extra fields", internalId: "secret-123", nested: { a: 1, b: 2 } }],
    }), { status: 200, headers: { "content-type": "application/json" } })
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].summary, "");
  assert.equal(items[0].publishedAt, null);
  assert.equal(items[0].score, 0);
  assert.ok(!items[0].summary.includes("secret-123"), "summary must never leak an unmapped field's raw contents");
});

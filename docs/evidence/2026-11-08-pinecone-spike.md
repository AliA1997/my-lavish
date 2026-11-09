# Pinecone spike (Phase 0 of `docs/superpowers/plans/2026-11-08-pinecone-error-store.md`)

Date: 2026-11-08 · SDK `@pinecone-database/pinecone` **9.2.0** (API `2026-07`) · Node v24.21.0 on Windows 11 · Index: serverless, `aws` / `us-east-1`, schema `{ text: { type: "string", embed: {} } }` (default model `llama-text-embed-v2`, 1024 dimensions) · Two throwaway indexes `see-plan-spike-*`, both deleted afterwards (the account shows 0 indexes after the runs). The scripts ran outside the repo, and the key was never printed or written.

## Results

| Check | Result | What it means for the plan |
| --- | --- | --- |
| Key works (`listIndexes`) | OK, 405 ms | — |
| Create a document index with an embedded field (`pc.createIndex({ schema, deployment, waitUntilReady })`) | OK, ready in ~6 s | `see-plan pinecone init` can create the index and wait for it. |
| `index.documents.upsert` with metadata fields next to `text` | OK, 3 docs in ~950 ms | Metadata is plain top-level fields on the document. |
| `index.documents.fetch({ ids })` right after upsert | **Not reliable.** Run 1: visible at once (280 ms). Run 2: not visible at once. | Read-after-write by ID isn't guaranteed. The write-through cache (S3) is required, not optional. |
| `index.documents.fetch({ filter, limit, paginationToken })` | Works and pages (`pagination.next`). **New records showed up after ~7 s**; 0 before that. `{ $eq: v }` and a bare value both work. | `/errors` loads one project with a filtered fetch (no list-then-fetch). The cache must cover the ~7 s gap. |
| `index.documents.search({ scoreBy: [{ type: "embed", field: "text", query }], filter, topK })` | OK, ~490 ms; filter applied; relevant record ranked first (0.49 vs 0.25) | `see-plan errors similar` works as designed. |
| `index.documents.update({ documents: [{ _id, severity, rated_at }] })` | OK; **merges** fields; the change was visible after ~0.7 s | Rating uses `update`, not upsert. |
| Re-upsert the same `_id` without some fields | **Replaces the whole document**: the missing fields were gone | Never re-upsert to change a record. Dedupe must check (cache, then fetch) before the first upsert. |
| Upsert with a `null` field | The API accepted it; the read-back was inconclusive (doc not visible yet) | Keep omitting null keys, as the plan says. |
| A key left out on upsert | Absent when fetched (not `null`) | The mapping restores missing keys as `null` when reading. |
| `describeIndexStats` | `recordCount` correct per namespace | `see-plan pinecone status` can show the count. |
| esbuild bundle, CJS, `node22` (same settings as `scripts/build-sea.js`) | OK, **1.36 MB** bundle; ran with no `node_modules` present | Fits the SEA build. SDK license **Apache-2.0** (8.2 MB on disk). |

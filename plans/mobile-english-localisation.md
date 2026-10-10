# OpenFicM Mobile — English Localisation Plan

## Goal
Convert the **mobile-rn** (OpenFicM Android) app to an **English-only, British-English** product:
- All user-facing UI text in English.
- Agent-generated prose and replies in English.
- Semantic search works on English content.

## Hard constraints
- **Do not translate or edit the SHA-pinned remote content**: the OpenFicM agent catalog
  (`tioners/OpenFicM@186e7b0…`), the Lorn plugin
  (`lornshrimp/Lorn.NovelWriteSkills@5acd345…`) and oh-story
  (`worldwonderer/oh-story-claudecode`). They are downloaded at runtime and hash-verified;
  editing local copies has no effect and would break verification.
- Keep `backend/`, `frontend/`, `desktop/`, `docs/` out of scope (separate i18n already exists there).

## Key decisions
1. **Output language is controlled by our own system prompt**, not the Chinese skill bodies.
   Add an explicit English contract in `buildSystemPrompt()` at the top and bottom so it
   outranks Chinese methodology manuals and reference samples.
2. **Embedder swap only**: replace `bge-small-zh-v1.5` (~14.7 MB) with `bge-small-en-v1.5`
   (~20–35 MB Q4). Keep the XLM-RoBERTa-based `bge-reranker-base` (~209 MB) as-is — it is
   already broadly multilingual. Avoid `bge-m3` (~350–450 MB Q4) to protect the
   lightweight footprint.
3. **Remote bodies stay Chinese**; only our wrappers, display names, tool schemas, prompts
   and errors become English.

## Workstreams
- **Agent layer** (`agent/runtime.ts`, `agent/tools.ts`): system prompt + English output
  contract, English intent-detection regexes, English tool descriptions and errors.
- **LLM layer** (`llm/client.ts`, `model-catalog.ts`, `selection.ts`, `responses-api.ts`).
- **Data layer** (`data/*.ts`): error strings and seed defaults (`历史对话`, `正文`,
  `第一章`, `世界书`, `我的作者文风`, `新对话`).
- **UI**: 9 screens, shared components, `App.tsx`, `navigation`, `theme`.
- **Settings layer** (`settings/*.ts`): `TOOL_CATALOG` names, validation errors,
  `app-update.ts`, `oh-story-updater.ts` display names.
- **Style layer** (`style/*.ts`): errors, `profile-options.ts`, `sampling.describeWindow`,
  distillation runner/store.
- **Lib layer** (`lib/export.ts`, `backup.ts`, `style-label.ts`, `sha256.ts`).
- **Search layer** (`search/indexer.ts`, `search/local-models.ts`): English query prefix;
  generalise the CJK/FTS branch so English uses FTS.
- **Content layer**: English display-name override map for built-in/remote
  skills and agents; English style-distillation prompts; Lorn wrapper/policy text.
- **Branding/assets**: `assets/models/LICENSES.md`, `mobile-rn/README.md`, model constants.

## Risks
- Occasional Chinese leakage when the user pastes Chinese source text. Mitigated by the
  English contract instructing translation-not-echo; cannot be fully eliminated.
- Auto skill activation depends on Chinese intent regexes — must add English equivalents,
  or routing silently stops working for English requests.
- Model swap requires the real Hugging Face byte size and SHA-256; the download/verify flow
  in `remote-resources.ts` must be updated with the true values.

## Validation
- `npm ci` and `npm run type-check` in `mobile-rn`.
- Grep audit: no user-facing Han characters in screens/components; only allowed in
  comments, and in code paths that intentionally support Chinese input (chapter-heading
  regex, CJK FTS branch).
- Manual smoke test: create project → write/save chapter → assistant run → style
  distillation → semantic search → export.

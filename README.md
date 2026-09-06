# Recurrent

Recurrent is a mobile-first PWA for continuous, source-linked professional learning. This initial vertical slice demonstrates the intended pilot flow: a short daily study session, source citations, a daily lesson, publication controls, and defensible proficiency reporting.

## Architecture

- **Next.js / React / TypeScript / Tailwind** render the PWA application shell.
- **Firebase Auth** provides email/password identity; **Firestore** stores user-scoped metadata, sessions, results, and mastery state; **Cloud Storage** stores source PDFs.
- A server-only ingestion worker (Firebase Functions or Cloud Run) extracts PDF pages, preserves provenance, chunks text, creates knowledge items, and invokes the configured AI provider only where policy allows.
- `src/domain` holds testable selection and spaced-repetition logic. `src/services` provides provider seams and persistence/ingestion helpers. The current interface uses illustrative seed content until Firebase is configured.

## Data model

All document paths begin with `users/{uid}` and are owner-scoped:

| Collection | Purpose |
| --- | --- |
| `domains`, `platforms` | Generic taxonomy; Aviation is data, not application logic. |
| `publications` | Metadata, activation, sensitivity, processing status, Storage location. |
| `publications/{id}/sections` | Extracted text reference, page and section provenance. |
| `knowledgeItems`, `questions` | Source-linked learnable material and generated questions. |
| `studySessions`, `studyResults` | Downloadable sessions and answer history. |
| `masteryStates`, `studyProfiles`, `devicePreferences` | Scheduling, reusable focus profiles, and per-device settings. |

Each generated item retains `publicationId`, publication title, section, page, source excerpt, category, answer, explanation, strictness, and confidence. PDFs are never stored in Firestore.

## Ingestion and AI / RAG

`PDF → Storage → extraction → page/section map → chunks → metadata/topics → knowledge items → questions → source-linked storage`.

Retrieval selects relevant chunks from an active, authorized publication before a provider is asked to generate explanatory content. The stored source remains canonical. `controlled` publications are excluded from external AI calls (`canUseExternalAi`), and the upload flow must clearly tell users that they are responsible for authorization. No claim is made that this is approved for classified, CUI, export-controlled, or other controlled material.

## Study selection and mastery

The daily selector begins from configurable weights: 35% due, 20% weak, 15% critical, 15% recent, 15% new. It gives each question a transparent priority based on due date, observed performance, criticality, and novelty. The initial scheduler expands review intervals after confident correct recalls and brings failures back the next day.

Topic confidence is a smoothed, rounded percentage—unseen material has no score—so the UI does not imply false precision.

## Security model

The browser may access only data beneath its own authenticated `users/{uid}` prefix. Storage has the same ownership boundary. Admin credentials and AI keys belong only in Functions/Cloud Run environment variables. Validate file type, size, metadata, and server-side function input before processing.

See `firestore.rules` and `storage.rules` as the MVP baseline; deploy and test rules with the Firebase emulator before production.

## Local setup

1. Install dependencies: `npm install`
2. Copy `.env.example` to `.env.local` and fill in public Firebase web configuration.
3. Run `npm run dev`
4. Open `http://localhost:3000`; use Safari’s **Add to Home Screen** to install after deployment over HTTPS.

Useful commands:

```bash
npm run dev
npm run build
npm run test
```

## Required environment variables

```bash
NEXT_PUBLIC_FIREBASE_API_KEY=
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=
NEXT_PUBLIC_FIREBASE_PROJECT_ID=
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=
# Server-only: never prefix these with NEXT_PUBLIC_
OPENAI_API_KEY=
FIREBASE_ADMIN_PROJECT_ID=
FIREBASE_ADMIN_CLIENT_EMAIL=
FIREBASE_ADMIN_PRIVATE_KEY=
```

## Firebase setup and deployment

Create a Firebase project, enable Email/Password Authentication, create Firestore and Cloud Storage, then deploy the supplied rules with Firebase CLI. Add a Functions or Cloud Run worker for ingestion. Configure secrets in the server runtime, not in `.env.local` shipped to clients. Deploy the Next.js app to Firebase App Hosting, Cloud Run, or another HTTPS-capable host.

## Current limitations and next work

The present UI is a fully interactive, locally seeded pilot shell—not yet a connected Firebase implementation. The next milestone is to wire Firebase Authentication and owner-scoped repositories, then implement Storage upload and the server ingestion worker. After that: offline IndexedDB answer queue/sync, source document viewer, semantic grading, profile editor, and real notification scheduling.

# GoaTrip — Complete Feature Documentation

> **Version:** 2026 (Neon Postgres + Netlify Functions edition)  
> **Purpose:** This document explains every feature in the GoaTrip platform in plain language — what it does, why it exists, how it works step-by-step, and how it connects to other parts of the app.

---

## Table of Contents

1. [App Overview](#1-app-overview)
2. [Trip Context System](#2-trip-context-system)
3. [Public Landing Page (`index.html`)](#3-public-landing-page-indexhtml)
   - 3.1 [Hero Section](#31-hero-section)
   - 3.2 [Countdown Timer](#32-countdown-timer)
   - 3.3 [Announcement Banner](#33-announcement-banner)
   - 3.4 [Place Gallery and Map](#34-place-gallery-and-map)
   - 3.5 [Journey / Route Section](#35-journey--route-section)
   - 3.6 [Itinerary Preview](#36-itinerary-preview)
   - 3.7 [Registration Wizard](#37-registration-wizard)
   - 3.8 [Crew / Team Section](#38-crew--team-section)
4. [Itinerary Editor (`itinerary.html`)](#4-itinerary-editor-itineraryhtml)
5. [Shared Wallet (`goa-wallet.html`)](#5-shared-wallet-goa-wallethtml)
   - 5.1 [Expenses](#51-expenses)
   - 5.2 [Deposits](#52-deposits)
   - 5.3 [Settlements](#53-settlements)
   - 5.4 [Balances View](#54-balances-view)
   - 5.5 [Activity Log](#55-activity-log)
   - 5.6 [Approval Workflow](#56-approval-workflow)
6. [Boarding Pass (`boarding-pass.html`)](#6-boarding-pass-boarding-passhtml)
7. [Cancellation Portal (`cancellation.html`)](#7-cancellation-portal-cancellationhtml)
8. [Admin Console (`admin.html`)](#8-admin-console-adminhtml)
   - 8.1 [Admin Authentication](#81-admin-authentication)
   - 8.2 [Feature Flags](#82-feature-flags)
   - 8.3 [Trip Manager](#83-trip-manager)
   - 8.4 [Content Editor](#84-content-editor)
   - 8.5 [Crew Manager](#85-crew-manager)
   - 8.6 [Registrations Manager](#86-registrations-manager)
   - 8.7 [Wallet Admin Controls](#87-wallet-admin-controls)
9. [Admin Approval Flow (`approve.html`)](#9-admin-approval-flow-approvehtml)
10. [User Login System](#10-user-login-system)
11. [Site Hold / Maintenance Page](#11-site-hold--maintenance-page)
12. [Shared Utilities](#12-shared-utilities)
    - 12.1 [Place Resolution Engine](#121-place-resolution-engine)
    - 12.2 [Route Optimiser](#122-route-optimiser)
    - 12.3 [UI Utilities](#123-ui-utilities)
13. [Serverless Backend (Netlify Functions)](#13-serverless-backend-netlify-functions)
14. [Database Schema (Neon Postgres)](#14-database-schema-neon-postgres)
15. [Security Model](#15-security-model)
16. [PWA and Progressive Enhancement](#16-pwa-and-progressive-enhancement)
17. [Feature Relationships Map](#17-feature-relationships-map)
18. [Environment Variables Reference](#18-environment-variables-reference)

---

## 1. App Overview

GoaTrip is a **multi-trip group travel platform** — a single codebase and database that can host and manage multiple separate trip events simultaneously. It was originally built for "The Goa Run 2026" and has since been refactored to be fully trip-agnostic.

**What it does at a glance:**

| Feature | Who uses it |
|---|---|
| Public landing page with gallery and route | All visitors |
| Registration form | Participants signing up |
| Day-by-day itinerary planning | Participants and admins |
| Shared expense wallet (Splitwise-style) | All participants |
| Train boarding pass lookup | Registered participants |
| Trip cancellation requests | Participants |
| Admin console (feature flags, trip config, content) | Admins only |

**Core design principle:** Nothing is hardcoded to one trip. Every page, on first load, asks "which trip am I showing?" and renders itself entirely from that trip's live data. This means the same URL structure, the same wallet, the same itinerary editor — all reused for any future trip without any code changes.

---

## 2. Trip Context System

**File:** `shared.js`, function `initTripContext()`  
**Backend:** `netlify/functions/trips.js`

### What it is
The trip context system is the invisible foundation every page runs first. It resolves *which trip is currently active* and loads its full configuration into a global `window.TRIP` object that all page-specific code then reads from.

### Purpose
Without this, every page would need to know the trip ID upfront, making it impossible to support multiple trips or share links that automatically open the right trip.

### How it works (step-by-step)

```
Page loads
    |
Check URL: is there a ?trip=<id> query parameter?
    |-- Yes --> use that ID
    |-- No  --> check sessionStorage for last visited trip ID
                    |-- Found      --> use that ID
                    |-- Not found  --> fetch the backend's "active" trip (is_active = true)
    |
GET /trips?id=<resolved-id>   (or /trips?active=1)
    |
Response populates window.TRIP = { id, name, startDate, endDate,
  origin, destination, villa, categories, walletParticipants, ... }
    |
sessionStorage saves the resolved trip ID (for cross-page navigation)
    |
Page renders itself from window.TRIP.*
```

### Relations to other features
- **Every page** calls `initTripContext()` before doing anything else.
- **All backend calls** use `TRIP.id` as the `tripId` parameter to scope data.
- **Navigation links** use the `withTrip(url)` helper to append `?trip=<id>` to all internal links, keeping you on the same trip when navigating between pages.

---

## 3. Public Landing Page (`index.html`)

**File:** `index.html`  
**Purpose:** The public face of the trip. Everything a prospective participant sees before signing up lives here.

---

### 3.1 Hero Section

**What it is:** The first thing visitors see — a full-screen section with the trip name, a tagline, and call-to-action buttons.

**Purpose:** Creates the first impression and routes visitors to key actions (Register, View Itinerary, Open Wallet).

**How it works:**
- Text is NOT hardcoded. On load, the page calls `GET /content?action=get&tripId=<id>` and overwrites the default HTML text with whatever an admin saved via the Content Editor.
- The participant count line (e.g., "Fourteen tickets. One unforgettable run.") is derived live from `TRIP.participantCount` — so it always reflects the real, current count, not a stale admin-typed string.
- CTA buttons link to registration (same page, scrolls down) and to other pages.

**Relations:** Content Editor (admin.html) → `content.js` → `site_content` table → this section.

---

### 3.2 Countdown Timer

**What it is:** A live ticking timer showing days/hours/minutes/seconds until the trip departs — and a second "trip ends in" timer that appears once the trip has started.

**Purpose:** Builds anticipation and gives participants a real-time sense of how soon the trip is.

**How it works:**
- The target datetime is stored in the database as the `hero.countdownTarget` content key (set from admin.html's Content Editor).
- JavaScript on the page recalculates the remaining time every second.
- Once `now >= tripStart` the departure timer disappears and the "trip ends in" timer (`hero.tripEndTarget`) is shown instead.

**Relations:** Content Editor sets the target date → `content.js` returns it → landing page renders the timer.

---

### 3.3 Announcement Banner

**What it is:** A dismissible, optionally-scrolling (marquee) banner at the top of the page for urgent notices.

**Purpose:** Allows admins to broadcast a message (e.g., "Bus departs 15 min early") to all visitors without editing HTML.

**How it works:**
- Controlled by a cluster of content keys: `banner.enabled`, `banner.text`, `banner.linkText`, `banner.linkUrl`, `banner.marqueeEnabled`, `banner.direction`, `banner.speed`, `banner.pauseOnHover`.
- All set from admin.html's Content Editor and stored in the `site_content` table.
- If `banner.enabled` is `'false'`, the banner is hidden entirely.
- If marquee is enabled, the text scrolls in the direction and speed the admin configured.

**Relations:** Content Editor → `content.js` → `site_content` table → this banner.

---

### 3.4 Place Gallery and Map

**What it is:** A horizontally-scrollable card gallery of trip destinations, each with a photo, name, and distance from the villa. Clicking a card opens Google Maps directions.

**Purpose:** Gives participants a visual preview of where they're going and how far each place is from the base accommodation.

**How it works:**
1. `TRIP.galleryPlaces` (a JSON array of place names) is fetched as part of the trip config.
2. For each place, `resolvePlace()` (from `shared.js`) is called — this calls `GET /places?action=resolve&q=<place-name>`.
3. The `/places` function geocodes the place via OpenStreetMap Nominatim and finds a Wikipedia photo for it, caching the result in Postgres.
4. Distance from the villa is calculated client-side using `haversineKm()`, with the villa's `lat/lng` from `TRIP.villaLat/villaLng`.
5. Directions link opens Google Maps with driving directions from the villa.

**Relations:**
- `shared.js` → `resolvePlace()` → `places.js` → Nominatim + Wikipedia APIs → `resolved_places` DB table.
- `TRIP.galleryPlaces` (set in Trip Manager) drives which places appear.
- `TRIP.villaLat/villaLng` drives distance calculations and directions origin.

---

### 3.5 Journey / Route Section

**What it is:** A visual departure-board style display of the multi-leg travel route (e.g., Pune → Goa by train, Goa → Pune return).

**Purpose:** Shows participants the full journey structure — which train, what times, which legs.

**How it works:**
- `TRIP.routeLegs` is a JSON array of route objects with `from`, `to`, `mode`, `departure`, `arrival`, and other details.
- The page renders each leg as a departure-board card with animated flip-counter style numbers, train number badge, class, and duration.

**Relations:** Admin → Trip Manager → `trips.js` → `TRIP.routeLegs` → this section.

---

### 3.6 Itinerary Preview

**What it is:** A read-only, collapsible day-by-day preview of the trip itinerary, shown on the landing page.

**Purpose:** Lets visitors see the rough plan without needing to open the full itinerary editor.

**How it works:**
1. Calls `GET /itinerary?tripId=<id>` → gets the saved `itinerary_json` from the `trips` table.
2. Falls back to `TRIP.defaultItinerary` if nothing has been saved yet.
3. Renders each day as a collapsible accordion card with place chips inside.
4. Each place chip calls `resolvePlace()` to get a small photo thumbnail.

**Relations:**
- Reads the same data that `itinerary.html` writes.
- `itinerary.js` backend function is the single source of truth.
- Place photos come from the same `/places` resolution pipeline.

---

### 3.7 Registration Wizard

**What it is:** A multi-step form (modal wizard) that participants fill out to register for the trip. Collects name, phone number, email, city of travel, food preference, and additional notes.

**Purpose:** Builds the participant list that feeds into the wallet, boarding pass, and user login features.

**How it works (step-by-step):**

```
Step 1: Name
    --> User types their name

Step 2: Phone Number
    --> User types their 10-digit Indian mobile number
    --> On blur: live check via GET /registration?type=checkPhone&phone=...
    --> If already registered: shown immediately as an error

Step 3: Email + details
    --> Email (optional), city, food preference

Step 4: Notes
    --> Free text for any special notes

Submit:
    --> POST /registration with all fields
    --> Server validates: name length, phone format, phone uniqueness, email format
    --> On success: confetti animation plays, success screen shown with participant count
    --> Gated by: trip.registration_open AND feature flag 'index.registration'
```

**Server-side validation (always enforced, not just UI):**
- Name: must be at least 2 chars and contain at least one letter.
- Phone: must be exactly 10 digits, not a fake-looking pattern (all-same-digit, sequential runs, repeated blocks).
- Phone: must not already exist in the `registrations` table.
- Email: if provided, must match basic email format.

**Relations:**
- `registration.js` backend handles submission.
- The `registrations` table is the source of truth for participant lists used by the **Wallet**, **Boarding Pass**, and **User Login** features.
- The `index.registration` feature flag (set in admin.html) controls whether the form is usable.
- `TRIP.registrationOpen` is an additional on/off switch.

---

### 3.8 Crew / Team Section

**What it is:** A section displaying the trip organiser team — photo cards with name, role, and an optional note.

**Purpose:** Puts faces to the organisers and builds trust with participants.

**How it works:**
- Calls `GET /crew?tripId=<id>` → returns all crew members from the `crew_members` table.
- Each member can have a photo (`pictures/crew/<filename>`) and a CSS crop rectangle saved in the database.
- No members are hardcoded; the section is empty if no crew have been added via admin.html.

**Relations:** Admin → Crew Manager (admin.html) → `crew.js` → `crew_members` table → this section.

---

## 4. Itinerary Editor (`itinerary.html`)

**File:** `itinerary.html`  
**Backend:** `netlify/functions/itinerary.js`

### What it is
A collaborative day-by-day itinerary editor. Anyone can view it; only logged-in users can edit and save changes.

### Purpose
Gives participants a live, editable plan for the trip — which places to visit each day, in what order, with automatic photo previews and map directions for each stop.

### How it works (step-by-step)

**Loading:**
1. `initTripContext()` resolves the active trip.
2. `GET /itinerary?tripId=<id>` fetches the saved itinerary JSON (array of days, each day an array of place strings).
3. Falls back to `TRIP.defaultItinerary` if no saved version exists yet.
4. For each place entry, `resolvePlace()` fetches a geocoded location and Wikipedia photo.

**Editing (logged-in users):**
1. User clicks to edit a day's place list.
2. They type place names in free form (e.g., "Visit Aguada Fort after breakfast").
3. `extractPlacePhrase()` in `shared.js` strips the surrounding text to extract just the place name ("Aguada Fort").
4. `resolvePlace()` geocodes it and shows a preview photo and distance from villa.
5. On save: `POST /itinerary` with the updated days array.
6. Server requires a valid session token AND `itinerary.editing` feature flag to be on.

**Circuit Route Optimiser:**
- When viewing a day, `calculateCircuitRoute()` in `shared.js` computes the optimal visit order using a nearest-neighbour greedy algorithm starting and ending at the villa.
- Shows driving distances between consecutive stops.
- Provides a "Get Directions" link chaining all stops into one Google Maps URL.

**Relations:**
- Reads from / writes to `itinerary.js` → `trips.itinerary_json` column.
- Place photos come from the same `/places` geocoding pipeline as the landing page gallery.
- User Login is required to save — the session token gates write access.
- Feature flag `itinerary.editing` (set in admin.html) can disable saving for all users.
- `index.html` shows a read-only preview of the same data.

---

## 5. Shared Wallet (`goa-wallet.html`)

**File:** `goa-wallet.html`  
**Backend:** `netlify/functions/wallet.js`

### What it is
A Splitwise-style shared expense tracker for the trip group. Tracks who paid what, how costs are split, who deposited money into the group pool, and who owes whom.

### Purpose
Eliminates manual spreadsheet tracking of group expenses. Every participant can see current balances and activity in real time.

---

### 5.1 Expenses

**What it is:** Logging a shared expense (e.g., "Lunch at Fisherman's Wharf — Rs2400, paid by Ravi").

**How it works:**
1. User clicks "Add Expense".
2. Fills in: title, category, amount, who paid, date, and how to split.
3. `POST /wallet` with `action: 'addExpense'` — server validates schema, inserts into `expenses` table, logs to `activity` table.
4. Expense starts in **DRAFT** state — must be submitted for approval before affecting balances.

**Split types:**
- **Equal** — amount divided evenly among all wallet participants.
- **Subset** — amount split among a selected list of participants.
- **Custom amounts** — each person's exact share is entered manually.
- **Deposit-backed** — the expense is paid from a group deposit pool, not out-of-pocket.

**Relations:** `expenses` table → approval workflow → balance calculation → Balances View.

---

### 5.2 Deposits

**What it is:** Recording that a participant has paid money into the group's shared pool (e.g., "Priya deposited Rs5000 advance").

**Purpose:** Tracks upfront contributions each person makes before the trip, separate from individual expenses.

**How it works:**
- `POST /wallet` with `action: 'addDeposit'` → inserted into `deposits` table.
- Deposit types include: `advance`, `cash`, `UPI`, and others.
- Also goes through the DRAFT → Approval workflow.

---

### 5.3 Settlements

**What it is:** Recording that one person has paid another person back (e.g., "Amit paid Ravi Rs600 to settle their balance").

**Purpose:** Closes the loop on debts calculated by the balance engine.

**How it works:**
- `POST /wallet` with `action: 'addSettlement'`.
- Stored in the `settlements` table with `from` (payer), `to` (receiver), and `amount`.
- Also goes through the approval workflow.

---

### 5.4 Balances View

**What it is:** A real-time view of who owes whom and by how much, calculated from all approved expenses, deposits, and settlements.

**Purpose:** Answers "who needs to pay whom, and how much?" without manual spreadsheet work.

**How it works:**
- The balance engine inside `wallet.js` calculates a net balance for each participant: total deposits minus share of all approved expenses, adjusted for settlements.
- Positive balance = others owe this person; negative = this person owes others.
- The UI shows the minimal set of transactions needed to fully settle all debts.

---

### 5.5 Activity Log

**What it is:** A chronological audit trail of every wallet action — every expense, deposit, or settlement added, edited, or deleted.

**Purpose:** Full transparency — every participant can see who did what and when.

**How it works:**
- Every write to `expenses`, `deposits`, or `settlements` tables also writes a row to the `activity` table with the action type, actor, and timestamp.
- The wallet UI fetches `GET /wallet?tripId=<id>` which returns all four datasets together.

---

### 5.6 Approval Workflow

**What it is:** A DRAFT → PENDING_APPROVAL → APPROVED / REJECTED state machine for all wallet records.

**Purpose:** Prevents unilateral changes to the group's financial records. Any write starts as a draft visible only to the creator, then must be reviewed and approved before affecting shared balances.

**How it works:**

```
User creates record --> DRAFT state
    |
    | User clicks "Submit for Approval"
    |
PENDING_APPROVAL (visible to admins)
    |                       |
    | Admin Approves         | Admin Rejects
    |                       |
APPROVED                  REJECTED
(affects balances)        (with optional reason)
```

- **Submit:** `POST /wallet` with `action: 'submitForApproval'`
- **Approve:** `POST /wallet` with `action: 'approveRecord'` — requires admin session token
- **Reject:** `POST /wallet` with `action: 'rejectRecord'` — requires admin session token, optional reason
- Works for all three record types: `expense`, `deposit`, `settlement`

**Relations:**
- Admin session (from `admin.js` or `login.js`) is required for approve/reject.
- Balance calculation only includes APPROVED records.

---

## 6. Boarding Pass (`boarding-pass.html`)

**File:** `boarding-pass.html`  
**Backend:** `netlify/functions/boarding-pass.js`

### What it is
A self-service page where participants type their name and get a beautifully rendered, printable train boarding pass — one card per journey leg — with a QR code.

### Purpose
Gives each participant a consolidated, printable view of all their train journey legs without distributing individual PDFs.

### How it works (step-by-step)

```
Participant opens boarding-pass.html
    |
Types their name (matched case-insensitively)
    |
GET /boarding-pass?tripId=<id>&name=<name>
    |
Returns all ticket rows for that name (one per leg)
    |
Page renders a card per leg:
  - Origin/destination station codes and names
  - Date, departure time, arrival time
  - Train number and name
  - Class, PNR, coach and seat number, fare
  - QR code (encodes the PNR, generated via api.qrserver.com)
    |
Print button triggers browser print dialog
```

**Ticket data:** Records are inserted directly into the `tickets` table by an admin. The boarding pass page is read-only.

**Relations:**
- `tickets` table is populated out of band (admin-side only).
- `qrApiUrl()` in `shared.js` builds the QR image URL.
- `waitForImagesToLoad()` in `shared.js` ensures the QR image is fully rendered before the print capture.

---

## 7. Cancellation Portal (`cancellation.html`)

**File:** `cancellation.html`  
**Backend:** `netlify/functions/cancellation.js`

### What it is
A formal trip cancellation request portal where participants can submit a cancellation request with a digital signature. Admins review, approve, or reject requests from admin.html.

### Purpose
Provides a formal, documented process for handling cancellations — not just informal messages. Creates a signed PDF record of each request.

### How it works

**Submitting a cancellation:**
1. Participant fills in: full name, email, mobile, trip name, destination, dates, booking reference, reason, and remarks.
2. They draw their digital signature on a canvas element.
3. On submit: signature is captured as a base64 image, sent to `POST /cancellation`.
4. Server generates a unique cancellation ID (format: `TTPL/CNL/0001`), stores all data in the `cancellations` table.

**Checking cancellation status:**
- Participant enters their cancellation ID → `GET /cancellation?id=<cancellationId>` → shows current status: IN REVIEW, APPROVED, or REJECTED.

**Admin review:**
- Admins see all pending cancellations in admin.html.
- They can approve (with optional remarks) or reject.
- Record saves who processed it and when.

**PDF Snapshot:**
- A PDF is generated client-side using `html2canvas` + `jspdf` from the rendered form.
- This PDF snapshot can be archived server-side.

**Relations:**
- Board members (for countersignatures) are stored in the `board_members` table, managed from admin.html.
- Admin session is required for approve/reject actions.
- Trip-scoped via `trip_id`.

---

## 8. Admin Console (`admin.html`)

**File:** `admin.html`  
**Backend:** `netlify/functions/admin.js`

### What it is
The secure admin dashboard. Admins log in with their name and a 6-digit PIN and get access to all management features: feature flags, trip config, content editing, crew management, registrations, and wallet oversight.

---

### 8.1 Admin Authentication

**What it is:** A PIN-based login system for admins. Admins are global (one login manages all trips), but everything they control is trip-scoped.

**Purpose:** Prevents unauthorised changes to trip config, content, and wallet data.

**How it works:**

```
New Admin Request Flow:
    Admin fills "Request Access" form (name + email)
    --> POST /admin?action=requestAdmin
    --> Row inserted in `admins` table with status='Pending'
    --> Email sent to APPROVER_EMAIL with approve/reject links
    --> Approver clicks approve link --> approve.html processes it
    --> Admin status set to 'Approved', temporary 6-digit PIN emailed to new admin
    --> Admin logs in with temp PIN --> forced to set a permanent PIN immediately

Login Flow:
    Admin enters name + 6-digit PIN
    --> POST /admin?action=login
    --> Server finds admin row, verifies PIN with scrypt hash (timing-safe comparison)
    --> On success: HMAC-signed session token (12h TTL) returned to browser
    --> Token stored in sessionStorage, sent as 'token' on every subsequent request

Lockout:
    5 wrong PINs --> account locked for 10 minutes (locked_until column)
    Admins can reset their PIN via a "Forgot PIN" flow (sends a new temp PIN via email)

Logout:
    Sets session_invalidated_at = now() in the DB
    Any token issued before that timestamp is rejected, even within its 12h TTL
```

**Master Admin:** One account (`Shubham Kumar`) can never be revoked or deleted by anyone — enforced server-side, not just in the UI.

**Relations:**
- `auth.js` (lib) — scrypt hashing + HMAC session tokens.
- `mailer.js` (lib) — sends request notifications and temp PIN emails via Resend.
- `approve.html` — the one-click approve/reject landing page for emailed links.
- The session token issued here is the same format used by `wallet.js` and `itinerary.js` to gate admin-only writes.

---

### 8.2 Feature Flags

**What it is:** A per-trip on/off switch system that controls individual site features — without needing a code deploy.

**Purpose:** Allows admins to enable or disable features at runtime (e.g., close registration, lock itinerary editing) without touching any code.

**Feature flag key examples:**
| Key | Controls |
|---|---|
| `index.registration` | Registration form usable |
| `itinerary.editing` | Itinerary can be saved |
| `wallet.expenses` | Expense adding enabled |
| `wallet.settlements` | Settlement adding enabled |

**How it works:**
- Stored in the `feature_flags` table: `(trip_id, feature_key, label, page, enabled)`.
- Admins toggle flags via `POST /admin?action=setFlag`.
- Any page can call `applyFeatureFlags(tripId)` (from `shared.js`) on load — this fetches all flags and automatically hides or disables any element tagged with `data-feature="<key>"` if that flag is off.
- Backend functions also check flags server-side (via `flags.js` lib) for write operations — flags cannot be bypassed by a direct API call.

**Relations:** Admin dashboard → `admin.js` → `feature_flags` table → `flags.js` (lib) → every write endpoint + `applyFeatureFlags()` client-side.

---

### 8.3 Trip Manager

**What it is:** A form in admin.html for creating and editing trips — setting the name, dates, origin, destination, route legs, gallery places, villa coordinates, participant count, and wallet categories.

**Purpose:** The single place to configure all the metadata a trip needs to render every page correctly.

**Key fields:**
| Field | Where it's used |
|---|---|
| `name`, `shortDates` | Page titles, hero section |
| `origin`, `destination`, `waypoint` | Route section display |
| `routeLegs` | Journey display cards |
| `galleryPlaces` | Place gallery and map |
| `villaLat`, `villaLng` | Distance calculations, directions origin |
| `defaultItinerary` | Itinerary fallback before any edits |
| `walletParticipants` | Wallet balance calculations |
| `categories` | Expense category list in wallet |
| `registrationOpen` | Registration form gate |
| `isActive` | Which trip is the site default |

**Relations:** `trips.js` backend → `trips` table → `window.TRIP` global → almost every page.

---

### 8.4 Content Editor

**What it is:** A form in admin.html for editing the copy (text) shown on the landing page — without touching HTML.

**Purpose:** Lets admins keep hero text, countdown dates, social links, and the announcement banner up to date without a code deploy.

**Editable fields:**
- Hero: eyebrow text, second title line, subtext, CTA button labels, countdown target datetime.
- Team section: eyebrow, heading, subtext.
- Footer: tagline, credit.
- Social links: GitHub, Instagram, Twitter, LinkedIn, WhatsApp, YouTube, Facebook, Email.
- Announcement banner: all properties (enabled, text, link, marquee settings).

**How it works:**
- `POST /content` with `action: 'updateContentBatch'` → upserts rows in `site_content` table.
- Empty string = clear the override (page falls back to its hardcoded default).
- Only allowed keys (an explicit allowlist in `content.js`) are accepted.

**Relations:** `content.js` → `site_content` table → landing page hero/banner/footer rendering.

---

### 8.5 Crew Manager

**What it is:** A CRUD interface in admin.html for managing the "Crew" / organiser team cards shown on the landing page.

**Purpose:** Keeps the team section fully dynamic — add, remove, reorder, and photo-crop team members without editing HTML.

**Photo crop feature:**
- Admin uploads a photo file to the repo under `pictures/crew/` (static file, no upload API).
- In the admin panel, they enter the filename, then use a visual crop rectangle tool to frame the subject.
- The crop is stored as four fractions (x, y, w, h — 0 to 1 of the image dimensions) in the DB.
- The public page reconstructs the exact crop using CSS `background-size` and `background-position` — no server-side image processing needed.

**Relations:** `crew.js` → `crew_members` table → landing page Crew section.

---

### 8.6 Registrations Manager

**What it is:** A table in admin.html listing all registered participants for the active trip, with the ability to delete registrations.

**Purpose:** Lets admins review who signed up and remove erroneous or test registrations.

**How it works:**
- `POST /registration` with `action: 'listRegistrations'` + admin session token → returns all rows from `registrations` table.
- Delete: `POST /registration` with `action: 'deleteRegistration'` + `id`.

**Relations:** `registration.js` → `registrations` table → also consumed by Wallet participant list and User Login name picker.

---

### 8.7 Wallet Admin Controls

**What it is:** Admin-specific wallet actions: approving/rejecting pending records, renaming participants, and wallet reset.

**Purpose:** Gives admins oversight over the shared wallet; participants cannot manipulate balances unilaterally.

**Admin-only wallet actions:**
- `approveRecord` / `rejectRecord` — change a record's approval state.
- `renameParticipant` — renames a participant across all expenses, settlements, and deposits.
- `resetWallet` — wipes all wallet data for the trip (requires typing a specific confirm phrase).

**Relations:** `wallet.js` → `expenses`, `settlements`, `deposits`, `activity` tables. All require an admin session token.

---

## 9. Admin Approval Flow (`approve.html`)

**File:** `approve.html`  
**Backend:** `netlify/functions/approve.js` → delegates to `admin.js`

### What it is
A one-page landing that handles the approve and reject links emailed to the approver when a new admin requests access.

### Purpose
Provides a clean, one-click approval/rejection experience from email, without requiring the approver to log into any admin panel.

### How it works

```
Approver receives email with two links:
  /approve.html?action=approve&token=<uuid>
  /approve.html?action=reject&token=<uuid>
    |
approve.html loads, reads action + token from URL
    |
GET /approve?action=approve&token=<uuid>
    |
approve.js --> calls approveAdmin(token) from admin.js
    --> Verifies the token matches a 'Pending' admin row
    --> Generates a temporary 6-digit PIN (scrypt-hashed, stored)
    --> Sets admin status = 'Approved'
    --> Emails the new admin their temp PIN
    |
Page shows "Approved - temp PIN emailed" or "Rejected"
```

**Race-condition safety:** The approve action is atomic — the database UPDATE includes `WHERE status='Pending'`, so if two concurrent requests hit the endpoint simultaneously (e.g., a mail scanner prefetch + a human click), only one succeeds.

**Relations:** Triggered by `admin.js`'s `requestAdmin()` email → `approve.js` → back to `admin.js`'s `approveAdmin()` / `rejectAdmin()`.

---

## 10. User Login System

**File:** `netlify/functions/login.js`

### What it is
A lightweight shared-password login for regular trip participants (not admins). All participants share one trip password, then pick their own registered name.

### Purpose
Allows any registered participant to log in to edit the itinerary or submit wallet records — without per-person PIN management or OTP delivery.

### How it works

```
User opens the login modal (on itinerary.html or wallet.html)
    |
Picks their name from a dropdown (populated from the registrations list)
    |
Enters the shared trip password
    |
POST /login?tripId=<id> with { action: 'login', name, password }
    |
Server:
  1. Looks up the trip's scrypt-hashed password
  2. Verifies the submitted password against it (timing-safe)
  3. Confirms the name matches an actual registered participant (case/whitespace-insensitive)
  4. Issues a signed session token with role: 'user'
    |
Token stored in sessionStorage, used for subsequent writes
```

**Setting the password (admin only):**
- `POST /login` with `action: 'setPassword'` + admin session token.
- Password is scrypt-hashed (same pattern as admin PINs).

**Security trade-off (by design):** Anyone with the shared password can submit as any registered name. This was accepted for a small, trusted group trip. The session token still records the chosen name for audit purposes.

**Relations:**
- Participant names come from `registration.js` → `registrations` table.
- The session token (`role: 'user'`) is verified by `itinerary.js` and `wallet.js` to gate write access.
- `auth.js` lib handles token signing (same format as admin tokens, different role).

---

## 11. Site Hold / Maintenance Page

**File:** `site-hold.html`

### What it is
A minimal "site is temporarily unavailable" page used during maintenance or intentional downtime.

### Purpose
Provides a polished, on-brand holding page instead of a raw server error when the site is taken offline for updates.

### How it works
- Static HTML page — no JS, no backend calls.
- Shown by configuring Netlify redirects to point all traffic here temporarily.
- A snippet version (`site-hold-notice-snippet.html`) exists for embedding the notice into other pages.

---

## 12. Shared Utilities

**Files:** `shared.js`, `shared.css`, `css/shared.css`

These files provide the common foundation used by all pages.

---

### 12.1 Place Resolution Engine

**Functions:** `extractPlacePhrase()`, `resolvePlace()`, `readPlaceCache()`, `writePlaceCache()`

**What it does:** Converts free-form itinerary text ("Morning - Visit Aguada Fort after breakfast") into a canonical geocoded place with coordinates and a Wikipedia photo.

**How the pipeline works:**

```
Raw text: "Morning - Visit Aguada Fort after breakfast"
    |
    | extractPlacePhrase()
    |
Cleaned: "Aguada Fort"
    |
    | normalizePlaceKey() --> cache key
    |
Check sessionStorage cache (avoids repeat round-trips in same page session)
    |
    | cache miss
    |
GET /places?action=resolve&q=Aguada+Fort
    |
places.js backend:
  1. Check resolved_places Postgres cache
  2. Cache miss --> call Nominatim geocoding API
  3. Score and filter results, pick best match above confidence floor (0.18)
  4. Find a Wikipedia photo via geosearch near resolved coordinates
  5. Cache result in resolved_places table
    |
Returns: { name, displayName, lat, lng, photo, photoTitle, confidence }
```

**Two-level caching:**
1. **Server-side (Postgres):** A place is geocoded only once across all visitors, ever.
2. **Client-side (sessionStorage):** The same resolved place is not re-fetched within a single page session.

**Relations:** Used by itinerary.html (editing), index.html (gallery and itinerary preview), and the route optimiser.

---

### 12.2 Route Optimiser

**Function:** `calculateCircuitRoute(villa, places)`

**What it does:** Given the villa's coordinates and a list of places for the day, computes the most efficient visit order (starting and ending at the villa) using a nearest-neighbour greedy algorithm.

**How it works:**
1. Start at the villa.
2. At each step, find the unvisited place closest to the current location (using `haversineKm()`).
3. Move to it, mark it visited, repeat.
4. Returns the ordered list with per-leg distances attached.

**Why nearest-neighbour (not full TSP)?** The number of stops per day is small (~5-10) and the algorithm needs to run in-browser synchronously. Nearest-neighbour gives a good (not necessarily optimal) route cheaply and deterministically.

**Relations:** Used by `itinerary.html` to display optimised day routes with directions links.

---

### 12.3 UI Utilities

| Function | What it does |
|---|---|
| `showBanner(kind, html)` | Shows a status banner (ok/bad/info) in `#bannerZone` |
| `setSyncStatus(state, meta)` | Updates the sync dot in the header |
| `animateValue(el, endValue, prefix)` | Smoothly counts a number up/down (e.g., balance changes) |
| `initials(name)` | Generates 2-letter avatar initials from a full name |
| `showFieldTooltip(inputEl, msg, kind)` | Shows a floating tooltip anchored to an input field |
| `renderQrSafely(el, text)` | Renders a QR code into an `<img>` via api.qrserver.com |
| `waitForImagesToLoad(container)` | Waits for all `<img>` to load (used before capturing for print) |
| `initSmoothScroll()` | Initialises Lenis smooth scrolling if the CDN script is loaded |
| `haversineKm(a, b)` | Great-circle distance in km between two lat/lng points |
| `bearingDeg(a, b)` | Compass bearing in degrees from point a to point b |
| `mapsDirectionsUrl(origin, dest)` | Builds a Google Maps "get directions" deep link |
| `applyFeatureFlags(tripId)` | Fetches feature flags and hides/disables flagged elements |
| `escapeHtml(s)` | Safely escapes a string for insertion into innerHTML |
| `withTrip(url)` | Appends `?trip=<id>` to an internal URL |

---

## 13. Serverless Backend (Netlify Functions)

All backend logic runs as **Netlify Functions** (Node.js serverless functions). Each function file handles one domain.

| Function | Route | What it handles |
|---|---|---|
| `trips.js` | `/trips` | List/get/create/update trips, set active trip |
| `registration.js` | `/registration` | Registration open/closed check, submit registration, participant list, admin list/delete |
| `itinerary.js` | `/itinerary` | Get and save the itinerary JSON |
| `wallet.js` | `/wallet` | Full CRUD for expenses, deposits, settlements, activity log, approval flow |
| `boarding-pass.js` | `/boarding-pass` | Ticket lookup by trip and name |
| `cancellation.js` | `/cancellation` | Submit and review cancellation requests |
| `admin.js` | `/admin` | Admin login, PIN management, feature flags, crew CRUD, content, approvals |
| `approve.js` | `/approve` | One-click approve/reject for emailed admin requests |
| `login.js` | `/login` | Participant login (shared password), set trip password |
| `places.js` | `/places` | Place geocoding and photo matching, backed by Postgres cache |
| `content.js` | `/content` | Get/update editable site content |
| `crew.js` | `/crew` | Crew member CRUD with photo crop support |

### Shared Library (`netlify/functions/lib/`)

| File | Purpose |
|---|---|
| `db.js` | Neon Postgres connection pool (uses `DATABASE_URL`) |
| `http.js` | Response helpers: `ok()`, `badRequest()`, `unauthorized()`, `serverError()` |
| `validate.js` | Input sanitisation (`sanitizeText`, `sanitizeNumber`) and JSON schema validation |
| `auth.js` | scrypt PIN hashing + HMAC-signed session tokens |
| `flags.js` | `isFeatureEnabled(tripId, key)` — server-side feature flag lookup |
| `mailer.js` | Resend email wrapper (throws on API-level failures, not just network errors) |

---

## 14. Database Schema (Neon Postgres)

All data is stored in a Neon Postgres database. Every table except `admins` is scoped by `trip_id`.

| Table | Scope | Purpose |
|---|---|---|
| `trips` | — | One row per trip: all configuration, itinerary JSON (column), password hash, villa coordinates |
| `registrations` | per trip | Signed-up participants: name, phone, email, food pref, notes |
| `expenses` | per trip | Expense records with approval state |
| `settlements` | per trip | Settlement records with approval state |
| `deposits` | per trip | Deposit records with approval state |
| `activity` | per trip | Audit log of all wallet actions |
| `tickets` | per trip | Train journey legs per passenger (for boarding passes) |
| `cancellations` | per trip | Cancellation requests with status and signatures |
| `board_members` | per trip | Countersignatories for cancellation documents |
| `crew_members` | per trip | Organiser team cards with photo crop data |
| `resolved_places` | global | Geocoding + photo cache (place name to coordinates and Wikipedia photo) |
| `site_content` | per trip | Admin-edited page copy (hero text, banner, footer) |
| `feature_flags` | per trip | On/off feature switches |
| `admins` | global | Admin accounts (name, email, hashed PIN, lockout, session invalidation) |

---

## 15. Security Model

| Concern | How it's handled |
|---|---|
| Admin PINs | Hashed with `scrypt` (salted, 64-byte output) — never stored in plaintext |
| Admin sessions | Stateless HMAC-SHA256 signed tokens, 12h TTL, invalidated on logout via `session_invalidated_at` |
| User sessions | Same token format, `role: 'user'` — lower privilege, issued by shared password |
| Lockout | 5 wrong PIN attempts --> account locked 10 minutes (`locked_until` column) |
| Input validation | All inputs sanitised and schema-validated server-side before touching Postgres |
| Database access | `DATABASE_URL` only lives in Netlify Functions (server-side) — never in client HTML/JS |
| Content Security Policy | Enforced site-wide via `netlify.toml` headers — not a meta tag (to avoid CSP intersection issues) |
| Phone validation | Fake-pattern detection (all-same-digit, sequential runs, repeated blocks) in addition to format check |
| Race conditions | Approval operations use atomic `WHERE status='Pending'` UPDATEs |
| Master admin | `Shubham Kumar` account cannot be revoked/deleted by anyone — enforced server-side |
| Rate limiting | Admin request endpoint: max 5 requests per IP per 15 minutes (in-memory per function instance) |

---

## 16. PWA and Progressive Enhancement

**Files:** `manifest.webmanifest`, `sw.js`

### What it is
GoaTrip is a **Progressive Web App** — it can be installed to a phone's home screen and launched as a standalone app (no browser chrome).

### Features
- **Web App Manifest:** Declares the app name, icons (192x192, 512x512, maskable), theme colour, and start URL. Enables "Add to Home Screen" on iOS and Android.
- **Service Worker (`sw.js`):** Registers a service worker for basic caching. Allows the app shell to load offline if the device has visited before.
- **Theme colour:** `#0C3E3A` (deep teal) — applied as the status bar colour on mobile.
- **Viewport fit:** `viewport-fit=cover` and `apple-mobile-web-app-status-bar-style: black-translucent` — content extends to the edges of notched displays.
- **Touch optimisation:** `touch-action: manipulation` on all interactive elements, `-webkit-tap-highlight-color: transparent` globally.

---

## 17. Feature Relationships Map

```
                        +-----------------------------+
                        |         admin.html           |
                        |  +----------+ +----------+  |
                        |  |Feature   | | Content  |  |
                        |  |Flags     | | Editor   |  |
                        |  +-----+----+ +----+-----+  |
                        |        |            |        |
                        |  +-----v----+ +----v-----+  |
                        |  |feature_  | |site_     |  |
                        |  |flags DB  | |content DB|  |
                        |  +-----+----+ +----+-----+  |
                        +--------|-----------------+---+
                                 |             |
         +-----------------------+-------------+-------------------+
         |                       v             v                   |
         |               applyFeatureFlags  loadContent           |
         |                       v             v                   |
         |   +---------------------------------------------+      |
         |   |                index.html                    |      |
         |   |  Hero | Banner | Gallery | Route | Register  |      |
         |   +-------------------+--------------------------+      |
         |                       |                                 |
         |                 registrations ---------------------->   |
         |                       |                    wallet.html  |
         |                       |                                 |
         |                       v                                 |
         |              +--------------+                           |
         |              |  itinerary   |                           |
         |              |   .html      |<---- places.js            |
         |              +------+-------+      (Nominatim cache)    |
         |                     |                                   |
         |                     v                                   |
         |            +-------------------+                        |
         |            | boarding-pass.html|                        |
         |            +-------------------+                        |
         +----------------------------------------------------------+

Shared foundation (every page):
    shared.js  --->  initTripContext() --> window.TRIP
    shared.css --->  design tokens, components
    trips.js   --->  trips table (single source of config)
```

---

## 18. Environment Variables Reference

These must be set in the Netlify dashboard (and locally via `.env` or `netlify env:set`). **Never commit real values to the repository.**

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | Yes | Neon Postgres connection string |
| `SESSION_SECRET` | Yes | Signs admin and user session tokens (long random string) |
| `RESEND_API_KEY` | Yes | Sends admin request/approval/PIN emails |
| `APPROVER_EMAIL` | Yes | Email address that receives admin access request notifications |
| `SITE_BASE_URL` | Yes | The site's public URL (used to build approve/reject email links) |
| `MAIL_FROM` | Recommended | From-address for outgoing email (e.g. `GoaTrip noreply@yourdomain.com`). Defaults to Resend sandbox which only delivers to Resend account owner |
| `WALLET_RESET_CONFIRM_PHRASE` | Optional | Confirm phrase for wallet reset (default: `RESET-GOATRIP-WALLET`) |
| `ADMIN_BOOTSTRAP_SECRET` | One-time | Used to issue a PIN to the very first admin row seeded directly in the DB |

---

*Documentation generated from source code analysis. Last updated: September 2026.*

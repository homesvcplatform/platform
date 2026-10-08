# Phase 2 · 04 — UI Information Architecture & Design System

> Status: **DRAFT for founder approval** · Date: 2026-10-08
> UI is a core product requirement. This defines structure, content and the design system **before** any screen is built. Screens for the first slice are marked **[S]**. Others are listed for IA completeness and built in later phases.

---

## 1. Design principles (all surfaces)
1. **One primary action per screen**, placed at the bottom within thumb reach.
2. **Icon + text, never text alone.** Never colour alone for meaning.
3. **Telugu-first copy** (en-IN alternative), plain words, short sentences, 🔊 read-aloud on key screens.
4. **Honest states:** every async action shows *saving → saved / will send when online / failed: retry*.
5. **Trust is visible:** who is coming, what it costs, what happens next, how to get help.
6. **Low-end first:** designed and tested on 2–3 GB Android over 3G. Desktop is secondary (except admin).
7. **Safe defaults** in admin: masked data, least-privilege controls, confirmation for irreversible actions.

---

## 2. Design system (`@hsp/design-tokens`, `@hsp/ui-web`, `@hsp/ui-native`)

### 2.1 Tokens
| Token group | Specification |
|---|---|
| **Colour** | Semantic tokens only (`surface`, `text`, `primary`, `success`, `warning`, `danger`, `info`, `muted`). Contrast ≥ 4.5:1 for text, ≥ 3:1 for UI components. A technician **high-contrast/sunlight** theme. `danger` reserved for SOS and destructive actions. The brand palette comes from the brand profile (config), so tokens map to brand colours without code changes (ADR-016) |
| **Typography** | Noto Sans Telugu + Noto Sans (subset, self-hosted; system fallback). Base **18 px** (customer/technician), 16 px admin. Line-height 1.5 (Telugu needs extra vertical space). Scale: 14/16/18/22/28/34. Respects OS font scaling up to 200% without clipping. Numbers in Western digits with Indian grouping (₹1,25,000) |
| **Spacing** | 4-pt grid. Screen gutter 16 px |
| **Touch targets** | ≥ 48 × 48 dp. Primary buttons full width, ≥ 56 dp tall. ≥ 8 dp between targets |
| **Iconography** | One outline icon set + **illustrated category/service-type icons** (Plumbing, Electrical, Appliance & Home Equipment; Refrigerator, RO, Washing Machine, Geyser, Air Cooler, AC…). Icons come from catalog config (`icon_ref`), not hard-coded |
| **Elevation/radius** | 2 levels. 8 px radius. Minimal shadows (performance) |
| **Motion** | Minimal. Respect "reduce motion". No animation is required to understand state |
| **Sound/haptics** | Technician offer alert sound + vibration. Read-aloud uses pre-recorded clips where available (consistent with IVR prompts) |

### 2.2 Core components
`AppBar` (language switch + help) · `PrimaryButton` / `SecondaryButton` / `QuietLink` (used for "Send a specialist", Q-A) · `SlideToConfirm` (technician accept) · `IconTile` (category/service type) · `SymptomChip` · `VoiceNoteButton` · `AddressForm` (landmark mandatory) · `StatusTimeline` · `TechnicianCard` (photo, first name, badges, rating bucket, languages, zones) · `CodeDisplay` (large digits + read-aloud) · `CodeEntry` (4-digit, large keypad) · `PriceSummary` (one big total + expandable lines) · `QuoteLine` · `MoneyText` · `OfflineBanner` · `SaveStateIndicator` · `SOSButton` (persistent, long-press/confirm) · `EmergencyPanel` (112 first) · `EmptyState` · `ErrorState` (retry + help) · `MaskedField` (admin: masked by default, reveal with reason) · `QueueTable` (admin) · `AuditTrail` (admin) · `ApprovalPanel` (maker-checker) · `RoleGate` (hides/disables controls by permission; the server enforces anyway)

### 2.3 Content & voice
- Approved glossary (Telugu + English) for: check-up/visit fee, repair price, door code, completion code, quote, approve, specialist, warranty, cash, online payment. Native-speaker review is a Gate 8 exit item.
- Never jargon the customer can't verify ("capacitor"). Show the plain problem first, the technical term second.
- Specialist recommendation copy (Q-A): *"This repair needs a {specialization} specialist. {First name} checked your {appliance} and recommended this."* Never implies poor work.

---

## 3. Customer IA (PWA)

```
Language select [S] → Home [S]
   ├─ Book a service [S]
   │    Category tiles (Plumbing · Electrical · Appliances) [S]
   │    → Appliances: service-type tiles (enabled per city) [S]
   │    → Symptom chips / voice note / photo ("Not sure? Call me") [S]
   │    → Address (locality search, landmark, map pin optional) [S]
   │    → Who will be home? (Me / Adult family member / Other adult) [S]
   │    → When (ASAP / slot) [S]
   │    → Payment preference (Online / Cash / Either) [S]
   │    → Price & confirm: visit fee, "no work without your approval" [S]
   │    → OTP (deferred login) [S]
   ├─ My bookings [S]
   │    Booking detail: StatusTimeline, TechnicianCard, door code, call technician (masked), identity check [S]
   │    → Quote [S]: problem in plain words, photos, one total, lines, warranty, repair options (Q-A), approve/reject
   │    → Repair scheduling [S] (slot, performer)
   │    → Completion: completion code [S], "Was the work done?" [S]
   │    → Pay [S] (UPI sandbox / cash confirmation) → Receipt placeholder [S]
   │    → Warranty card [S] → Rate each technician [S]
   │    → Report a problem (complaint; damage category later)
   ├─ Warranties (claim: later)
   ├─ Help: call / WhatsApp / SOS screen [S]
   └─ Profile & privacy: language, preferred language (optional, Q-C), consents, data requests (basic in slice)
```

**Quote screen (Q-A behaviour) [S]**
- Qualified diagnosing technician: primary button **"Fix it now"** (same technician now, if eligible) → secondary button **"Same technician, later"** → `QuietLink` "Prefer a different specialist?"
- Not qualified: one primary button **"Book recommended specialist"** with the reason line. The diagnosing technician isn't shown as a repair option.
- Price change (v2): "Price changed: was ₹X, now ₹Y. Here's why" + approve/reject. Work on new items waits.

**SOS screen [S]:** large "Call 112" first, then the "Safety team" call button. Hours-aware copy ("Safety team available 8 AM–8 PM") **only once staffed**. Works offline (`tel:` links).

**Low-bandwidth rules:** SSR first paint. Critical payload ≤ 200 KB. Images lazy + small. Icons as an SVG sprite. Offline shell shows the last booking status. Retry queue for actions.

---

## 4. Technician IA (Android app)

```
Login (OTP, auto-read) → Device setup (battery whitelist checklist per OEM, app lock if shared) [S]
Home [S]: Online toggle + today's area · current/next job card · earnings today · SOS (always visible)
   ├─ Offer (full screen) [S]: service type + purpose, locality + distance band, window, YOU EARN ₹…, required skill;
   │     Slide to accept · Not available (reason optional) · countdown · read-aloud
   ├─ Active visit [S]: address/landmark (L2 window only), call customer (masked), navigate, "Is an adult present?",
   │     Depart → Arrive (customer door code) → Diagnose → Send quote → Wait for approval → Repair → Completion code
   │     → Materials used → Payment (UPI QR on screen / record cash, fixed amount) → Done
   ├─ Diagnosis builder [S]: top repair items for this service type, specialization hints, materials with reference price,
   │     photos (in-app camera), notes by voice, preview of customer price + my earnings
   ├─ Earnings [S]: today / this week / next payout · per-job gross → commission → net · cash commission due (+ reason/amount)
   ├─ Jobs history (L3 data only)
   ├─ Availability: weekly hours, daily area check-in
   ├─ Why am I getting few jobs? (own opportunity data) (later in Phase 2+)
   └─ Help / IVR hotline number / SOS
```
**One primary action per screen.** Minimal typing (chips, steppers, voice). Offline: every action shows a save state, and the job card is cached for the L2 window, then purged. The SOS button is persistent in the top bar and the visit screens.

---

## 5. Admin IA (console)

```
Sign-in (SSO + passkey via zero-trust proxy) → Role-aware home (my queues)
   ├─ Queues: Unassigned/unfulfilled visits [S] · Diagnosis desk (basic-phone captures) [S] · Presence overrides (maker/checker) [S]
   │          · Pending approvals (maker-checker) [S] · Complaints · Disputes · Verification · Dead letters (eng)
   ├─ Job detail [S]: full timeline (jobs/visits/offers/calls/quote versions/approvals/payments), masked PII, actions by permission
   ├─ Technicians: profile (masked), skills per service type/specialization, areas, availability, metrics
   ├─ Catalog & pricing: service types per city (enable/disable), repair items, rate cards (draft → approval), simulator view
   ├─ Safety board (P1 alerts; mirrors out-of-band alerts. Not a dependency)
   ├─ Audit log (auditor/security)
   └─ Access management (security admin)
```
Patterns: **masked by default** (`MaskedField` + reason modal + audit). Destructive/irreversible actions need confirmation with the impact stated. Maker-checker panels show maker, payload diff and hash. Controls hidden or disabled by role (`RoleGate`). The server enforces regardless. Desktop-first, but works on a tablet.

---

## 6. Accessibility & localisation acceptance (Gate 8/9)
WCAG 2.2 AA · TalkBack labels in Telugu/English · 200% text scale · no colour-only meaning · focus order · read-aloud on quote/codes/status · glossary review by native speakers · pseudo-locale truncation tests.

## 7. Slice screen inventory (what Gate 8/9 build)
Customer: 17 [S] screens/states above. Technician: 7 [S] areas above. Admin: 5 [S] views above. Everything else is out of scope for Phase 2's first slice.

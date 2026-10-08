# Phase 1.1 · 08 — Technician Android Device Test Matrix

> Status: **DRAFT for founder review** · Date: 2026-10-08
> Purpose: the ADR-004 gate (React Native vs. Kotlin) and proof that the technician app **stays useful under poor connectivity and budget-device restrictions**. Testing uses a **throwaway spike app** (offer screen, push handling, offline queue, camera upload, IVR-fallback trigger). It isn't production code.

---

## 1. Device classes (buy or borrow real devices; emulators don't reproduce OEM battery behaviour)

Pick **at least one device per row**, prioritising models actually used by pilot technicians (survey during recruitment).

| Class | Android | RAM | Why included | Example families (verify availability locally) |
|---|---|---|---|---|
| D1 Android Go entry | 8.1 Go / 11 Go | 1–2 GB | Floor of support (minSdk 26) | Older Go-edition phones from Samsung/Nokia/itel |
| D2 Budget Xiaomi/Redmi | 12–14 (MIUI/HyperOS) | 2–3 GB | Very common; aggressive battery management/autostart restrictions | Redmi A-series / 9A-class |
| D3 Budget Realme/Oppo (ColorOS) | 11–14 | 2–4 GB | Common; background restrictions | Realme C-series / Oppo A-series |
| D4 Budget Vivo (Funtouch/OriginOS) | 11–14 | 3–4 GB | Known to kill background apps | Vivo Y-series |
| D5 Budget Samsung (One UI Core) | 12–14 | 3–4 GB | Common; "deep sleeping apps" | Galaxy A0x/M0x |
| D6 Transsion (itel/Tecno/Infinix, HiOS/XOS) | 11–14 | 2–4 GB | Popular at the lowest prices | itel A-series / Spark-class |
| D7 Android 14+ reference | 14/15 | 4 GB+ | Full-screen-intent policy, newest restrictions | Any mainstream device |

Device conditions: half the devices tested with **low free storage (< 1 GB)** and **typical installed apps** (WhatsApp, YouTube, a UPI app, Truecaller, the OEM's cleaner app).

---

## 2. Measurements & targets

| Area | Measurement | Target (pass) | Method |
|---|---|---|---|
| **Cold start** | Launch → interactive home/offer screen | p90 ≤ 4 s on D1–D6 | Android vitals-style trace (Perfetto/Macrobenchmark), 20 runs |
| Warm start | Background → foreground | p90 ≤ 1.5 s | Same |
| **Offer screen from push** | Push received → offer interactive | ≤ 1 s (app alive), ≤ 4 s (app killed) | Instrumented timestamps |
| **Memory** | PSS during offer + job flow | ≤ 150 MB. No OOM kills during a 2 h shift simulation | `dumpsys meminfo`, profiler |
| **Battery impact** | Drain attributable to the app over an 8 h "online" shift (idle + 4 job flows) | ≤ 5% of battery per shift attributable. No wakelock abuse | Battery Historian / OEM stats |
| APK/AAB size | Download size | ≤ 30 MB | Play bundle explorer |
| **Push delivery** | % offers delivered (high-priority FCM) within 30 s with the screen off ≥ 30 min, app not opened for 6 h | ≥ 95% per OEM **after** the onboarding whitelist steps. Record the without-whitelist baseline | 50 test pushes per device per condition |
| **IVR fallback** | Push not acknowledged in 45 s → IVR call placed | 100% of non-acknowledged offers trigger a call within 60 s | Spike backend + telephony sandbox |
| **Offline behaviour** | Accept → depart → arrive → complete with network toggled off at each step | 100% of actions queued, replayed in order on reconnect, server-rejected actions explained clearly. No data loss after app kill/reboot | Scripted test (Maestro) + manual |
| Offline usefulness | With no network: current job details (L2 within window), customer code entry queued, IVR hotline number shown, SOS `tel:` links work | All available | Manual |
| **Photo upload** | 3 photos (compressed ≤ 200 KB each) on 2G-throttled (250 kbps/800 ms RTT) | Complete ≤ 2 min, resumable after a network drop, completion not blocked by uploads | Network conditioner |
| **App crash rate** | Crash-free sessions in a 2-week closed test | ≥ 99.5% crash-free. User-perceived crash rate < 1.09% and ANR rate < 0.47% (Play "bad behaviour" thresholds) | Crash reporting (scrubbed) + Play vitals |
| **Background restrictions** | Doze, App Standby buckets ("rare"/"restricted"), OEM autostart off, battery saver on | Documented behaviour per OEM. Offer reliability measured in each state. Onboarding checklist covers required settings per OEM | Manual matrix |
| **Network recovery** | Switch 4G → 2G → offline → Wi-Fi mid-flow. Captive portal | No stuck states. Retry with backoff. User sees "Saved, will send" | Manual + scripted |
| Accessibility on device | 200% font scale, TalkBack basic navigation in Telugu | Offer and job screens usable | Manual |
| Sunlight readability | High-contrast mode outdoors | Readable (qualitative, 3 testers) | Field check |
| Local data purge | L2 data removed at window close and on logout | 100% | Inspect app storage (debug build) |

---

## 3. Matrix (execute every test on every device class)

| Test ↓ / Device → | D1 | D2 | D3 | D4 | D5 | D6 | D7 |
|---|---|---|---|---|---|---|---|
| Cold/warm start | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ |
| Push → offer (alive/killed) | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ |
| Push delivery (whitelisted / not) | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ |
| IVR fallback | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ |
| Memory / OOM over a 2 h shift | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ |
| Battery over an 8 h shift | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ |
| Offline queue & replay | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ |
| Photo upload 2G + resume | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ |
| Background restriction states | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ |
| Network transitions | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ |
| Telugu rendering, 200% font | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ |
| Crash/ANR (2-week closed test) | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ |

---

## 4. Decision rule (ADR-004 gate)
- **Pass:** all targets met on D1–D6 (D1 may miss cold start by ≤ 1 s if every other metric passes) → React Native confirmed.
- **Conditional:** push reliability below target only on some OEMs even after whitelisting → keep RN, make `PUSH_THEN_IVR` the default for those OEMs, and add device-specific onboarding.
- **Fail:** cold start, memory or crash targets missed on ≥ 2 classes → build the same spike in Kotlin/Compose (1 week) and compare. Choose by data.

## 5. Outputs
Per-device results, per-OEM onboarding checklist (battery/autostart settings with screenshots in Telugu), a list of OEMs needing IVR-first offers, and the ADR-004 decision record.

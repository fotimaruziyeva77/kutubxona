# Feature Landscape -- SIFAT Library (Subsequent Milestone)

**Domain:** National library management and reading index platform
**Researched:** 2026-06-06
**Focus:** Remaining features to complete after existing Sprint 4-level scaffold

---

## Table Stakes

Features users/stakeholders expect. Missing = PQ-9 non-compliance or broken core flow.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Reading Index batch recalculation | Core value prop -- every user needs daily RI score | Med | Formula done, serial loop must become BullMQ batch |
| Top-100 monthly workflow | PQ-9 Band 10 -- national recognition + 25x BHM prize | Med | UI exists, backend workflow orchestration missing |
| Fraud Detection hardening | Top-100 integrity; prize incentive creates cheating motive | Low | 6 rules implemented, needs edge case coverage |
| Payme/Click payment processing | Revenue for maktab/OTM/idora subscriptions | Low | Webhook handlers exist, needs timeout/retry/reconciliation |
| Invoice PDF generation | Buxgalter needs professional invoices with bank details | Low | PdfService exists, needs invoice template |
| Monthly PDF analytics reports | Tuman/viloyat admins expect automated reports | Med | PdfService exists, needs templates per scope level |
| Smart Alert triggers | Admin monitoring -- react to inactive libraries, RI drops | Med | UI exists, backend trigger cron logic needed |
| Real-time dashboard (multi-instance WS) | Live stats for national/viloyat/tuman admins | Med | StatsGateway exists, needs Redis adapter for 3 replicas |
| Offline PWA (12-hour, 2G) | Qishloq kutubxonachi needs to work without internet | High | manifest.json exists, no Service Worker yet |
| Comprehension test system | Fraud prevention -- verify readers actually read books | Med | DB model exists, question bank + test logic needed |
| Push notifications (Firebase FCM) | Bron confirmation, deadline reminders, alert delivery | Med | Stub exists in notification processor |
| SMS OTP via Eskiz.uz | User registration -- foundational auth flow | Low | Stub exists, needs real API integration |
| Kutubxona Roaming | Users travel between viloyats, must return books anywhere | Med | API designed, bilateral confirmation flow needed |
| Excel import for book funds | Kutubxonachi bulk-loads 500+ books | Low | xlsx in deps, needs validation + progress tracking |

## Differentiators

Features that create distinctive value. Not strictly required but high-impact.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| AI NLP chat (Uzbek) | Admins ask questions in natural language -- unique in UZ govt | Med | Rule-based + GPT enrichment scaffolded |
| Interactive reading index map | Visual choropleth monitoring for hokims | Med | Leaflet.js in deps, needs GeoJSON data |
| Oila (Family) reading module | Family competition encourages household reading culture | Med | UI exists, backend matching + aggregation needed |
| Root Cause Analysis | AI explains WHY tuman index dropped -- actionable insights | Low | 5-factor analysis already implemented |
| Predictive Analytics | "Will we reach 10 books/year?" -- decision support | Low | Linear regression + national forecast done |
| Book recommendations | Personalized by age, genre, region, reading history | Med | Collaborative + content-based filtering needed |
| Gamification badges | "First 10 books", "30-day streak" -- engagement hooks | Low | Simple CRUD + trigger logic |
| Donat module (transparent) | Public donation tracking with transparent allocation | Low | UI exists, reuses payment integration |
| Jadidlar izidan clubs | PQ-9 compliance + community building + debate tracking | Med | UI exists, photo/video upload verification needed |
| Location-based book search | "Alpomish is 1.2km away at Karmana library" | Med | Elasticsearch exists, needs geo queries |
| ID.UZ SSO | Auto-verify government employees, reduce admin work | Med | Controller exists, needs real PKCE flow testing |

## Anti-Features

Features to explicitly NOT build in this milestone.

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| Native mobile app | PWA covers 95% of use cases; native adds 6+ months | Serwist PWA, installable via browser |
| Audiokitob integration | Scope creep, streaming infrastructure needed | Defer to V2.0+ |
| Real-time user chat | Not a social platform, moderation burden | Push notifications |
| Blockchain reading verification | Unnecessary complexity, no user value | Trust Score + Fraud rules |
| Video streaming for debates | Bandwidth prohibitive in 2G areas | Photo upload + text summary |
| Custom ML training UI | Data scientists use notebooks offline | Pre-trained models via ONNX |
| Automated book purchasing | SIFAT is monitoring, not procurement | Link to partner do'konlar |
| Multi-language AI fine-tuning | GPT-4.1 mini handles Uzbek adequately for V1.0 | System prompt engineering |

## Feature Dependencies

```
SMS OTP (Eskiz.uz) --> User Registration --> All features
                                          --> Library assignment
                                          --> Reading Index calculation

Payme/Click webhooks --> Subscription activation --> Library access
                      --> Invoice generation --> Buxgalter panel

BullMQ batch RI calculation --> Top-100 ranking
                             --> Leaderboard displays
                             --> Smart Alert triggers
                             --> Predictive Analytics input

Service Worker (Serwist) --> Offline catalog browsing
                          --> Offline QR scanning
                          --> Background sync on reconnect

Redis adapter for Socket.IO --> Multi-instance WebSocket
                             --> Production deployment (3 replicas)

Comprehension tests --> Fraud Detection accuracy
                    --> ISBN scan validation
                    --> Top-100 integrity

Firebase FCM --> Push notifications --> Bron reminders
                                    --> Alert delivery
                                    --> Top-100 announcements
```

## MVP Recommendation (This Milestone Priority)

Prioritize in order:

1. **Reading Index batch processing** -- Core value, everything depends on it
2. **Smart Alert backend triggers** -- Admins need actionable monitoring
3. **WebSocket Redis adapter** -- Required for production (3 replicas)
4. **Payme/Click hardening** -- Revenue stream depends on this
5. **SMS OTP (Eskiz.uz)** -- Registration is broken without real SMS
6. **PWA Service Worker (Serwist)** -- Qishloq kutubxonachi access
7. **Monthly PDF reports** -- Tuman admin deliverable
8. **Comprehension test** -- Fraud prevention for Top-100 integrity
9. **Push notifications (FCM)** -- User engagement and reminders

Defer to later milestone:
- **Full RAG NLP** (V2.0): GPT-4.1 mini enrichment is sufficient for V1.0
- **ML Fraud Detection** (V2.0): Rule-based is adequate until training data exists
- **Prophet forecasting** (V2.0): Exponential smoothing is sufficient
- **Interactive Leaflet map**: Important but not blocking

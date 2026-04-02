# Badminton Queue Manager — Improvement Roadmap

## Current Features (v1.0)
- Player registration with skill levels (Beginner → Expert)
- ELO-based dynamic rating system
- Smart matchmaking: balanced games with controlled challenge factor
- Multiple court management
- Singles & Doubles modes
- Match history with score tracking
- Win/loss stats, streaks, win rate
- Queue management with manual reordering
- Auto-assign matches to available courts
- Auto re-queue after match finishes
- localStorage persistence with JSON export/import
- Dark-themed responsive UI

---

## Phase 2 — Short-term Improvements

### 🔄 Auto Re-queue Toggle
- After a match ends, automatically put players back in queue
- Add a per-player preference: "auto re-queue me after each game"

### ⏱ Rest Timer
- Enforce a minimum rest period between consecutive games for the same player
- Configurable rest time (e.g., 1 game gap minimum)

### 📊 Leaderboard View
- Sortable ranking table by rating, win rate, matches played
- Weekly/monthly reset option for seasonal leagues

### 🎯 Match Quality Score
- Show predicted match quality before assigning (closeness, variety score)
- Let the admin confirm or shuffle suggested pairings

### 👥 Partner Preferences
- Players can prefer/avoid specific partners in doubles
- "Lock team" option: keep two players always on the same team

---

## Phase 3 — Medium-term Enhancements

### 🌐 Backend + Real-time Sync
- Add a lightweight backend (Node.js + SQLite or Supabase)
- Real-time updates via WebSockets so multiple devices see live court status
- QR code check-in: players scan a QR to join the queue from their phone

### 📱 PWA (Progressive Web App)
- Add service worker for offline capability
- Install as a home screen app on phones
- Push notifications: "Your match is ready on Court 3!"

### 🏆 Tournament Mode
- Round-robin or single-elimination bracket generator
- Group stages with automatic seeding based on ratings
- Print/export bracket

### 📈 Advanced Analytics
- Per-player performance graphs (rating over time)
- Head-to-head records
- Best/worst matchups
- Court utilization heat map (which courts are busiest)
- Average wait time tracking

---

## Phase 4 — Long-term Vision

### 🤖 ML-based Matchmaking
- Train a simple model on match outcomes to predict better pairings
- Factor in time-of-day performance, fatigue estimation, preferred partners

### 💰 Payment Integration
- Court booking fees / session passes
- Track who has paid for the session
- Stripe/PayPal integration

### 🏢 Multi-venue Support
- Manage multiple badminton halls from one dashboard
- Shared player profiles across venues

### 📅 Session Scheduling
- Calendar view for booking future sessions
- Recurring weekly games with pre-registered player lists
- Waitlist for full sessions

### 🎮 Gamification
- Achievement badges (10 wins, 5-game streak, play 50 matches)
- XP system alongside ELO
- Daily/weekly challenges ("Win a game against someone 100+ rating above you")

---

## Technical Improvements

| Area | Improvement |
|------|-------------|
| **Database** | Migrate from localStorage to IndexedDB for larger data, then optionally to Supabase/Firebase for cloud sync |
| **State Management** | Move to a reactive pattern (signals/observables) for smoother UI updates |
| **Testing** | Add unit tests for the matchmaker algorithm |
| **Accessibility** | ARIA labels, keyboard navigation, screen reader support |
| **i18n** | Multi-language support for different badminton communities |
| **Performance** | Virtual scrolling for large player lists, Web Workers for matchmaking computation |

---

## Quick Wins (can do today)
1. ✅ Add "Queue All" button
2. ✅ Match preview before assigning
3. ✅ Export/import data backup
4. Add sound notification when match is assigned
5. Add player search/filter on the Players tab
6. Show estimated wait time in queue
7. Add "Shuffle Queue" button for randomizing

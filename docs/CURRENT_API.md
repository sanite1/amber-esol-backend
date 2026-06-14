# amber-esol-backend — Current API reference

Generated 2026-05-14 from the actual source. One-time snapshot; not auto-updated.

## Conventions

- Base path: `/api`
- All authenticated requests use header `Authorization: Bearer <jwt>` unless the route is marked public.
- Routers registered in `src/index.ts`:
  - `/api/users` → `user.routes.ts`
  - `/api/availability` → `availability.routes.ts`
  - `/api/bookings` → `booking.routes.ts`
  - `/api/payments` → `payment.routes.ts`
  - `/api/reviews` → `review.routes.ts`
  - `/api/conversations` → `messaging.routes.ts`
  - `/api/notifications` → `notification.routes.ts`
  - `/api/my-tutors` → `myTutors.routes.ts`
  - `/api/my-students` → `myStudents.routes.ts`
  - `/api/tutor-dashboard` → `tutorDashboard.routes.ts`
  - `/api/student-dashboard` → `studentDashboard.routes.ts`
  - `/api/admin-dashboard` → `adminDashboard.routes.ts`
  - `/api/cron` → `cron.routes.ts`
  - `/api/webhooks/stripe` → `stripeWebhook` controller (mounted directly, raw body)
  - `/api/esol/organisations` → `esolOrg.routes.ts`
  - `/api/esol/referrals` → `esolReferral.routes.ts`
  - `/api/esol/onboarding` → `esolOnboarding.routes.ts`
  - `/api/esol/learners` → `esolLearner.routes.ts`
  - `/api/esol/teachers` → `esolTeacher.routes.ts`
  - `/api/esol/sessions` → `esolAISession.routes.ts`
  - `/api/esol/safeguarding` → `esolSafeguarding.routes.ts`
  - `/api/esol/invoices` → `esolInvoice.routes.ts`
  - `/api/esol/reports` → `esolReport.routes.ts`
  - `/api/esol/level-changes` → `esolLevelChange.routes.ts`
  - `/api/esol/session-feedback` → `esolSessionFeedback.routes.ts`
  - `/api/esol/vocab` → `esolVocab.routes.ts`
- **NOT mounted in `src/index.ts`** (route files exist but unreachable): `adminStudents.routes.ts`, `adminTutors.routes.ts`, `ticket.routes.ts`. Documented for completeness.
- **Standard success envelope** (defined in `src/errors/apiResponse.ts`, class `ApiResponse`): controllers respond with the bare instance, so the JSON body is `{ statusCode: number, message: string, data?: any }`. A handful of controllers (admin dashboard, admin students, admin tutors, student dashboard, tickets) re-shape this to `{ message, data }` (dropping `statusCode` from the body but using it as the HTTP status).
- **Standard error envelope** (`src/middlewares/globalErrorHandler.ts`): `{ error: string, status: number, message: string, fields?: [{ message, path }] }`. `ApiError` (`src/errors/apiError.ts`) carries `statusCode` and `message`; `express-validation` Joi errors become 400s with the `fields` array.
- Rate limiters live in `src/config/rateLimiter.ts`: `authLimiter`, `passwordResetLimiter`, `webhookLimiter`, `generalLimiter` (applied to all `/api` requests).
- Multipart uploads use `multer` memory storage; profile-picture uploads stream to Cloudinary (`cloudinary.service.ts`).
- `req.user` is hydrated by `isAuthenticated` from JWT + fresh DB fields: `{ id, firstname, lastname, email, role, profilePicture, orgId, esolLevel, esolTeacherApproved, iat, exp }`.

The `Response` column below documents only the value inside the envelope's `data` field (or notes when it is a raw stream/buffer).

---

## Marketplace + shared routes

### `user.routes.ts` — mounted at `/api/users`

#### `POST /register/student`

- **Auth**: `authLimiter`, public; accepts multipart with optional `profilePicture` field.
- **Body** (after `parseJsonFields` parses JSON-stringified fields from multipart):
  - `firstname` (string, required, min 2)
  - `lastname` (string, required, min 2)
  - `email` (string, required, email)
  - `phoneNumber` (string, required)
  - `password` (string, required, min 8)
  - `profilePicture` (string URL, optional — overwritten by Cloudinary upload if file present)
  - `dateOfBirth` (string, optional)
  - `gender` (enum `male|female|other|prefer-not-to-say`, optional)
  - `address` (object: `street, city, state, postcode, country`; country required if present)
  - `timezone` (string, optional)
  - `nativeLanguage` (string, optional)
  - `learningPreferences` (object: currentLevel, targetLevel, goals[], preferredSchedule[], lessonTypePreference; all optional)
- **Response**: created student user (`user.toJSON()`).
- **Description**: registers a B2C student and sends a verification email.

#### `POST /register/tutor`

- **Auth**: `authLimiter`, public; multipart with optional `profilePicture`.
- **Body**: as student plus required `bio`, `languages[]` (min 1; each `{ name, fluency }`), required `nativeLanguage`, required `hourlyRate` (number ≥ 0), required `yearsOfExperience` (number ≥ 0), required `certifications[]` (min 1; `{ name, issuedBy, year, documentUrl? }`), optional `education[]` (`{ degree, institution, year }`), optional `specializations[]`, optional `teachingPreferences`, optional `trialLessonOffered` (bool), `trialLessonPrice` (number ≥ 0), `introVideoUrl` (URL).
- **Response**: created tutor user.
- **Description**: registers a tutor and sends a verification email.

#### `POST /register/admin`

- **Auth**: `authLimiter`, public (caller protected at deploy-time).
- **Body**: `firstname, lastname, email, phoneNumber, password` (all required), `profilePicture` (optional URL).
- **Response**: created admin user.
- **Description**: registers a platform admin and sends a verification email.

#### `POST /login`

- **Auth**: public.
- **Body**: `email` (required), `password` (required).
- **Response**: `{ accessToken, refreshToken, user }`.
- **Description**: validates credentials, updates `lastLogin`, returns JWTs.

#### `POST /refresh`

- **Auth**: `authLimiter`, public.
- **Body**: `token` (string, required).
- **Response**: `{ accessToken }`.
- **Description**: issues a new access token from a refresh token.

#### `POST /forgot-password`

- **Auth**: `passwordResetLimiter`, public.
- **Body**: `email` (string, required, email).
- **Response**: no `data`; generic message regardless of whether the email exists.
- **Description**: emails a reset link if the account exists and is verified.

#### `GET /verify/:id/:token`

- **Auth**: `authLimiter`, public.
- **Params**: `id` (ObjectId, required), `token` (string, required).
- **Response**: no `data`.
- **Description**: confirms email and sends welcome mail.

#### `PATCH /reset-password/:id/:token`

- **Auth**: `passwordResetLimiter`, public.
- **Params**: `id` (ObjectId), `token` (string).
- **Body**: `password` (string, required, min 8), `confirmPassword` (string, required, must equal password).
- **Response**: no `data`.
- **Description**: completes a password reset.

#### `PATCH /update-password`

- **Auth**: `isAuthenticated`.
- **Body**: `oldPassword`, `newPassword` (min 8), `confirmNewPassword` (must match `newPassword`).
- **Response**: no `data`.
- **Description**: change password for current user.

#### `GET /tutors`

- **Auth**: public.
- **Query**: `page, limit, search, sort (rating|price_low|price_high|experience|newest), language, specialization, minPrice, maxPrice, level (beginner|elementary|intermediate|upper-intermediate|advanced)` — all optional strings.
- **Response**: `{ tutors: [...], pagination: { page, limit, total, totalPages } }`.
- **Description**: public tutor listing with filters and pagination.

#### `GET /:id`

- **Auth**: public (no `isAuthenticated` in router).
- **Params**: `id` (ObjectId, required).
- **Response**: full user (`user.toJSON()`).
- **Description**: fetch a single user by ID.

#### `PATCH /:id`

- **Auth**: `isAuthenticated`; multipart with optional `profilePicture`.
- **Params**: `id` (ObjectId).
- **Body**: any subset of the registration fields (`firstname, lastname, phoneNumber, profilePicture, dateOfBirth, gender, address, timezone, bio, languages, nativeLanguage, hourlyRate, yearsOfExperience, certifications, education, specializations, teachingPreferences, learningPreferences, notificationPreferences, trialLessonOffered, trialLessonPrice, introVideoUrl`) — all optional.
- **Response**: `{ accessToken, refreshToken, user }` (new tokens minted on update).
- **Description**: update profile; returns rotated tokens since claims may have changed.

#### `DELETE /:id`

- **Auth**: `isAuthenticated`.
- **Params**: `id` (ObjectId).
- **Body**: passed through to service as `{ reason: string, feedback?: string }` (no Joi schema on body).
- **Response**: no `data`.
- **Description**: soft-deletes account (status → `terminated`) and emails confirmation.

---

### `availability.routes.ts` — mounted at `/api/availability`

#### `GET /:tutorId`

- **Auth**: public.
- **Params**: `tutorId` (ObjectId).
- **Response**: `{ weeklySchedule, timezone, ... }` (availability doc).
- **Description**: fetch a tutor's weekly availability.

#### `GET /:tutorId/slots`

- **Auth**: public.
- **Params**: `tutorId` (ObjectId).
- **Query**: `date` (YYYY-MM-DD, required), `duration` (string, optional).
- **Response**: shape varies — `{ slots, ... }` on the happy path; `{ slots: [], reason }`-style payloads when the date is past/unavailable. See `src/services/availability.service.ts`.
- **Description**: computes bookable slots for a given date.

#### `PUT /`

- **Auth**: `isAuthenticated, isTutor`.
- **Body**: `weeklySchedule` (array of exactly 7 day objects `{ day, enabled, blocks: [{ startTime: HH:mm, endTime: HH:mm }] }`, required), `timezone` (string, optional).
- **Response**: updated availability doc.
- **Description**: replaces the tutor's weekly schedule.

#### `PATCH /settings`

- **Auth**: `isAuthenticated, isTutor`.
- **Body**: `timezone, bufferMinutes (0–60), minBookingNotice (≥0), maxBookingAdvance (≥1)` — all optional.
- **Response**: updated availability doc.
- **Description**: updates booking-window settings.

#### `POST /overrides`

- **Auth**: `isAuthenticated, isTutor`.
- **Body**: `date` (YYYY-MM-DD), `type` (`unavailable|extra`), `reason` (string ≤ 200), `blocks[]` (required when `type === extra`).
- **Response**: created override.
- **Description**: blocks or adds time on a specific date.

#### `DELETE /overrides/:id`

- **Auth**: `isAuthenticated, isTutor`.
- **Params**: `id` (ObjectId).
- **Response**: no `data`.
- **Description**: removes a date override.

---

### `booking.routes.ts` — mounted at `/api/bookings`

#### `POST /`

- **Auth**: `isAuthenticated, isStudent`.
- **Body**: `tutorId` (ObjectId, required), `type` (`trial|regular`, required), `slots[]` (each `{ date, startTime, endTime }`; trial must have exactly 1), `specialty` (≤200), `notes` (≤500), `message` (≤500), `successUrl` (URL), `cancelUrl` (URL).
- **Response**: `{ bookings: [...], bookingGroupId, checkoutUrl, totalPrice, paymentRequired }`.
- **Description**: creates booking(s) and a Stripe checkout session when payment is required.

#### `GET /`

- **Auth**: `isAuthenticated`.
- **Query**: `page, limit, status (pending|confirmed|completed|cancelled_student|cancelled_tutor|cancelled_admin|no_show), type, dateFrom, dateTo, search, sort (newest|oldest|price_high|price_low)`.
- **Response**: `{ bookings, pagination }`.
- **Description**: role-aware list (student sees own, tutor sees students', admin sees all).

#### `GET /upcoming`

- **Auth**: `isAuthenticated`.
- **Query**: `limit` (string, optional).
- **Response**: upcoming bookings list (see `src/services/booking.service.ts:1003`).
- **Description**: dashboard widget for next sessions.

#### `GET /stats`

- **Auth**: `isAuthenticated`.
- **Response**: counts/totals shaped per role.
- **Description**: booking aggregate stats for the caller.

#### `GET /:id`

- **Auth**: `isAuthenticated`.
- **Params**: `id` (ObjectId).
- **Response**: single booking (`booking.toJSON()`).
- **Description**: fetch a single booking detail.

#### `PATCH /:id/confirm`

- **Auth**: `isAuthenticated, isTutor`.
- **Params**: `id` (ObjectId).
- **Response**: updated booking.
- **Description**: tutor accepts a pending booking.

#### `PATCH /:id/decline`

- **Auth**: `isAuthenticated, isTutor`.
- **Params**: `id`. **Body**: `reason` (string ≤ 500, optional).
- **Response**: updated booking.
- **Description**: tutor declines a pending booking and refunds.

#### `PATCH /:id/cancel`

- **Auth**: `isAuthenticated`.
- **Params**: `id`. **Body**: `reason` (string ≤ 500, optional).
- **Response**: updated booking.
- **Description**: cancels a booking (any participant or admin).

#### `PATCH /:id/complete`

- **Auth**: `isAuthenticated`.
- **Params**: `id`.
- **Response**: updated booking.
- **Description**: marks the lesson complete (tutor/admin).

#### `PATCH /:id/no-show`

- **Auth**: `isAuthenticated`.
- **Params**: `id`.
- **Response**: updated booking.
- **Description**: marks no-show (tutor/admin).

#### `GET /admin/stats`

- **Auth**: `isAuthenticated, isAdmin`.
- **Response**: admin-only enriched lesson stats.
- **Description**: aggregate booking analytics for admin dashboards.

#### `PATCH /:id/flag`

- **Auth**: `isAuthenticated, isAdmin`.
- **Params**: `id`. **Body**: `flagged` (bool, required), `flagReason` (string ≤ 500, optional).
- **Response**: updated booking.
- **Description**: admin flags or unflags a booking.

#### `PATCH /:id/meeting-url`

- **Auth**: `isAuthenticated, isTutor`.
- **Params**: `id` (string, required).
- **Body**: `meetingUrl` (valid URI, required), `reason` (string, optional).
- **Response**: updated booking.
- **Description**: tutor overrides the auto-generated meeting URL.

---

### `payment.routes.ts` — mounted at `/api/payments`

> NOTE: the Stripe webhook is mounted directly in `src/index.ts` at `POST /api/webhooks/stripe`, not on this router. Handler `stripeWebhook` (`src/controllers/webhook.controller.ts`) expects raw body and Stripe signature header; on success returns `{ data }` from `webhookService` (envelope `{ statusCode: 200, message: "Webhook processed successfully" }`).

#### `POST /create-intent`

- **Auth**: `isAuthenticated`.
- **Body**: `bookingId` (ObjectId, required).
- **Response**: `{ clientSecret, paymentIntentId, ... }` (see `src/services/payment.service.ts:126`).
- **Description**: creates or retrieves a Stripe PaymentIntent for a booking.

#### `GET /transactions`

- **Auth**: `isAuthenticated`.
- **Query**: `page, limit, status (pending|paid|refunded|failed), type (lesson|trial|package), dateFrom, dateTo, search, sort (newest|oldest|amount_high|amount_low)`.
- **Response**: `{ transactions, pagination }`.
- **Description**: caller's transaction history.

#### `GET /summary`

- **Auth**: `isAuthenticated`.
- **Response**: aggregated totals per role.
- **Description**: top-level payment KPIs.

#### `GET /chart/monthly`

- **Auth**: `isAuthenticated`.
- **Query**: `year, months` (optional strings).
- **Response**: monthly chart series.
- **Description**: revenue/spending chart data.

#### `GET /wallet`

- **Auth**: `isAuthenticated, isTutor`.
- **Response**: wallet doc.
- **Description**: tutor wallet (balance, pending, etc.).

#### `GET /methods`

- **Auth**: `isAuthenticated`.
- **Response**: array of saved payment methods.
- **Description**: list caller's payment methods.

#### `POST /methods`

- **Auth**: `isAuthenticated`.
- **Body**: `type (card|paypal|bank, required), stripePaymentMethodId, last4 (4 digits, required), brand, isDefault, bankName, accountHolderName, paypalEmail (email)` — only `type` and `last4` required.
- **Response**: created method.
- **Description**: attach a payment method to the caller.

#### `DELETE /methods/:id`

- **Auth**: `isAuthenticated`. **Params**: `id` (ObjectId).
- **Response**: no `data`.
- **Description**: remove a payment method.

#### `PATCH /methods/:id/default`

- **Auth**: `isAuthenticated`. **Params**: `id`.
- **Response**: updated method.
- **Description**: set a method as default.

#### `POST /payouts`

- **Auth**: `isAuthenticated, isTutor`.
- **Body**: `amount` (positive number, required), `method` (`bank_transfer|paypal`, required), `notes` (≤500).
- **Response**: created payout request.
- **Description**: tutor requests a payout.

#### `GET /payouts`

- **Auth**: `isAuthenticated`.
- **Query**: `page, limit, status (pending|processing|completed|failed|flagged), sort (newest|oldest|amount_high|amount_low)`.
- **Response**: `{ payouts, pagination }`.
- **Description**: list payouts (caller-scoped or admin-wide).

#### `PATCH /payouts/:id/approve`

- **Auth**: `isAuthenticated, isAdmin`. **Body**: `notes` (≤500, optional).
- **Response**: updated payout.
- **Description**: admin approves a payout.

#### `PATCH /payouts/:id/reject`

- **Auth**: `isAuthenticated, isAdmin`. **Body**: `reason` (required, ≤500).
- **Response**: updated payout.
- **Description**: admin rejects a payout.

#### `PATCH /payouts/:id/complete`

- **Auth**: `isAuthenticated, isAdmin`. **Body**: `reference` (≤200), `notes` (≤500).
- **Response**: completed payout.
- **Description**: admin marks payout as paid out.

#### `POST /refund/:transactionId`

- **Auth**: `isAuthenticated`. **Body**: `reason` (≤500, optional).
- **Response**: updated transaction.
- **Description**: refund a transaction.

#### `PATCH /transactions/:id/flag`

- **Auth**: `isAuthenticated, isAdmin`. **Body**: `flagged` (bool, required), `flagReason` (≤500).
- **Response**: updated transaction.
- **Description**: admin flags/unflags a transaction.

#### `GET /transactions/:id`

- **Auth**: `isAuthenticated`. **Params**: `id` (ObjectId).
- **Response**: transaction detail.
- **Description**: fetch a single transaction.

---

### `review.routes.ts` — mounted at `/api/reviews`

#### `POST /`

- **Auth**: `isAuthenticated, isStudent`.
- **Body**: `bookingId` (ObjectId), `rating` (1–5 int), `comment` (string 10–1000).
- **Response**: created review.
- **Description**: student posts a review for a completed booking.

#### `GET /me`

- **Auth**: `isAuthenticated`.
- **Query**: `page, limit, sort (newest|oldest|rating_high|rating_low)`.
- **Response**: `{ reviews, pagination }`.
- **Description**: caller's own reviews.

#### `GET /tutor/:tutorId`

- **Auth**: public.
- **Params**: `tutorId` (ObjectId). **Query**: `page, limit, rating (1–5 as string), sort (newest|oldest|rating_high|rating_low|most_helpful)`.
- **Response**: `{ reviews, pagination }`.
- **Description**: public reviews for a tutor.

#### `GET /stats/:tutorId`

- **Auth**: public.
- **Params**: `tutorId`.
- **Response**: rating distribution + averages.
- **Description**: public rating stats for a tutor.

#### `PATCH /:id`

- **Auth**: `isAuthenticated, isStudent`.
- **Params**: `id` (ObjectId). **Body**: any of `rating, comment` (≥1 must be present).
- **Response**: updated review.
- **Description**: update own review.

#### `DELETE /:id`

- **Auth**: `isAuthenticated, isStudent`.
- **Params**: `id`.
- **Response**: no `data`.
- **Description**: delete own review.

#### `POST /:id/reply`

- **Auth**: `isAuthenticated, isTutor`. **Body**: `text` (string 5–1000).
- **Response**: updated review.
- **Description**: tutor adds a reply.

#### `PATCH /:id/reply`

- **Auth**: `isAuthenticated, isTutor`. **Body**: `text` (5–1000).
- **Response**: updated review.
- **Description**: tutor edits their reply.

#### `DELETE /:id/reply`

- **Auth**: `isAuthenticated, isTutor`. **Params**: `id`.
- **Response**: updated review.
- **Description**: tutor deletes their reply.

#### `POST /:id/report`

- **Auth**: `isAuthenticated`. **Body**: `reason` (10–500).
- **Response**: no `data`.
- **Description**: report a review for moderation.

#### `POST /:id/helpful`

- **Auth**: `isAuthenticated`.
- **Response**: `{ helpful, helpfulCount }`.
- **Description**: toggle helpful vote.

#### `GET /admin`

- **Auth**: `isAuthenticated, isAdmin`.
- **Query**: `page, limit, status (published|hidden|removed), reported (true|false), sort, search`.
- **Response**: `{ reviews, pagination }`.
- **Description**: admin review queue.

#### `PATCH /:id/hide` | `PATCH /:id/unhide` | `PATCH /:id/remove` | `PATCH /:id/restore`

- **Auth**: `isAuthenticated, isAdmin`. **Body**: `reason` (≤500, optional).
- **Response**: updated review.
- **Description**: admin moderation actions on a review.

#### `PATCH /:id/reports/:reportId`

- **Auth**: `isAuthenticated, isAdmin`. **Body**: `status` (`reviewed|dismissed`, required).
- **Response**: updated review.
- **Description**: resolve an individual report on a review.

#### `GET /admin/stats`

- **Auth**: `isAuthenticated, isAdmin`.
- **Response**: aggregate moderation stats.
- **Description**: admin review analytics.

---

### `messaging.routes.ts` — mounted at `/api/conversations`

#### `GET /`

- **Auth**: `isAuthenticated`.
- **Query**: `page, limit, search, archived (true|false)`.
- **Response**: `{ conversations, pagination }`.
- **Description**: caller's conversations.

#### `POST /`

- **Auth**: `isAuthenticated`.
- **Body**: `participantId` (ObjectId, required).
- **Response**: conversation doc (existing or newly created).
- **Description**: start or fetch a 1:1 conversation.

#### `GET /:id/messages`

- **Auth**: `isAuthenticated`.
- **Params**: `id` (ObjectId). **Query**: `page, limit, before` (ISO date).
- **Response**: `{ messages, pagination }`.
- **Description**: paginated messages for a conversation.

#### `POST /:id/messages`

- **Auth**: `isAuthenticated`.
- **Params**: `id`. **Body**: `content` (1–5000, required), `type` (`text`, default `text`).
- **Response**: created message (`message.toJSON()`).
- **Description**: send a text message.

#### `POST /:id/messages/file`

- **Auth**: `isAuthenticated`; multipart `file` (10 MB limit, allowed images/PDF/doc/audio).
- **Params**: `id` (ObjectId; no body validator beyond `params`).
- **Response**: created message.
- **Description**: upload a file message via Cloudinary.

#### `PATCH /:id/read` | `PATCH /:id/pin` | `PATCH /:id/mute` | `PATCH /:id/archive`

- **Auth**: `isAuthenticated`.
- **Params**: `id` (ObjectId).
- **Response**: updated conversation (for pin/mute/archive) or counters (for read).
- **Description**: mark-all-read / toggle pin / toggle mute / toggle archive.

---

### `notification.routes.ts` — mounted at `/api/notifications`

All routes require `isAuthenticated` (applied via `router.use`).

#### `GET /`

- **Query**: `page, limit` (numeric strings), `read (true|false), type, sort (newest|oldest)`.
- **Response**: `{ notifications, pagination, unreadCount }` (see `src/services/notification.service.ts:144`).
- **Description**: list notifications for the caller.

#### `GET /unread-count`

- **Response**: `{ count }`.
- **Description**: unread notification count.

#### `PATCH /read-all`

- **Body**: empty (validator enforces `{}`).
- **Response**: `{ modifiedCount }` (see `src/services/notification.service.ts:191`).
- **Description**: mark all caller's notifications read.

#### `PATCH /:id/read`

- **Params**: `id` (ObjectId).
- **Response**: `{ notification }`.
- **Description**: mark a single notification read.

#### `DELETE /:id`

- **Params**: `id` (ObjectId).
- **Response**: `null`.
- **Description**: delete a notification.

---

### `myTutors.routes.ts` — mounted at `/api/my-tutors`

All routes require `isAuthenticated`.

#### `GET /`

- **Query**: `page, limit (numeric strings), search (≤100), filter (all|active|past|favourites), sort (recent|name|lessons|rating)`.
- **Response**: `{ tutors, pagination }`.
- **Description**: tutors the caller has booked.

#### `GET /:tutorId`

- **Params**: `tutorId` (ObjectId).
- **Response**: tutor detail enriched with the caller's relationship.
- **Description**: single tutor detail (history with caller).

#### `POST /:tutorId/favourite`

- **Params**: `tutorId`.
- **Response**: `{ favourited }` (see `src/services/myTutors.service.ts:503`).
- **Description**: toggle favourite status.

---

### `myStudents.routes.ts` — mounted at `/api/my-students`

All routes require `isAuthenticated, isTutor` (applied via `router.use`).

#### `GET /`

- **Query**: `page, limit, filter (all|active|trial|inactive), sort (recent|name|lessons|joined), search`.
- **Response**: `{ students, pagination, ... }`.
- **Description**: tutor's roster of students.

#### `GET /:studentId`

- **Params**: `studentId` (ObjectId).
- **Response**: `{ student, lessons, notes, ... }`.
- **Description**: single student detail for the tutor.

#### `PATCH /:studentId/notes`

- **Params**: `studentId`. **Body**: `notes` (string ≤ 1000, required; empty allowed).
- **Response**: `{ notes }`.
- **Description**: update private notes about a student.

---

### `tutorDashboard.routes.ts` — mounted at `/api/tutor-dashboard`

#### `GET /`

- **Auth**: `isAuthenticated, isTutor`.
- **Query**: `upcomingLimit, messagesLimit` (optional strings).
- **Response**: NOT wrapped in `ApiResponse` — service returns `{ message, data: { welcome, stats, upcomingLessons, pendingBookings, earnings, availability, performance, recentMessages } }` directly (see `src/services/tutorDashboard.service.ts:430`).
- **Description**: aggregated tutor dashboard data.

---

### `studentDashboard.routes.ts` — mounted at `/api/student-dashboard`

#### `GET /`

- **Auth**: `isAuthenticated, isStudent`.
- **Query**: `upcomingLimit, messagesLimit, recommendedLimit` (optional strings).
- **Response** (controller re-shapes envelope to `{ message, data }`): `data` is `{ welcome, stats, ... }` (see `src/services/studentDashboard.service.ts:300`).
- **Description**: aggregated student dashboard data.

---

### `adminDashboard.routes.ts` — mounted at `/api/admin-dashboard`

#### `GET /`

- **Auth**: `isAuthenticated, isAdmin`.
- **Query**: `signupsLimit, lessonsLimit, transactionsLimit, chartMonths` (optional strings).
- **Response** (envelope re-shaped to `{ message, data }`): `data` is `{ stats, monthlyRevenue, recentSignups, recentLessons, recentTransactions, flaggedItems }`.
- **Description**: aggregated admin dashboard data.

---

### `cron.routes.ts` — mounted at `/api/cron`

All routes require `isCronAuthorized` (header `Authorization: Bearer <CRON_SECRET>`), not user JWT.

#### `GET /complete-lessons`

- **Response**: `{ message, processed, completed, errors }` (raw JSON, not the standard envelope).
- **Description**: auto-completes finished lessons (Vercel Cron).

#### `GET /generate-invoices`

- **Response**: raw JSON status (see `src/controllers/cron.controller.ts:66`).
- **Description**: monthly ESOL invoice generation.

#### `GET /check-progression`

- **Response**: raw JSON status (see `src/controllers/cron.controller.ts:100`).
- **Description**: daily ESOL learner progression check.

---

### `adminStudents.routes.ts` — NOT mounted (router file exists, no entry in `src/index.ts`)

Prefix would be `/api/admin-students` if registered.

#### `GET /`

- **Auth**: `isAuthenticated, isAdmin`.
- **Query**: `page, limit, search, status (all|active|inactive|banned), sort (newest|name|spent|lessons|recent)`.
- **Response** (controller emits `{ message, data }`): `data` is `{ students, pagination, summary, ... }` (see `src/services/adminStudents.service.ts:249`).
- **Description**: admin-side student management list.

#### `PATCH /:id/status`

- **Auth**: `isAuthenticated, isAdmin`.
- **Params**: `id` (string). **Body**: `status` (`active|inactive|banned`, required), `reason` (optional).
- **Response** (`{ message, data }`): `data` is the updated student.
- **Description**: admin updates student status.

---

### `adminTutors.routes.ts` — NOT mounted (router file exists, no entry in `src/index.ts`)

Prefix would be `/api/admin-tutors` if registered.

#### `GET /`

- **Auth**: `isAuthenticated, isAdmin`.
- **Query**: `page, limit, search, status (all|active|inactive|pending_approval|rejected|banned), sort (newest|name|earned|rating|lessons|students)`.
- **Response** (`{ message, data }`): `{ tutors, pagination, summary }` (see `src/services/adminTutors.service.ts:174`).
- **Description**: admin-side tutor management list.

#### `PATCH /:id/status`

- **Auth**: `isAuthenticated, isAdmin`.
- **Params**: `id`. **Body**: `status` (`active|inactive|pending_approval|rejected|banned`, required), `reason` (optional).
- **Response** (`{ message, data }`): updated tutor.
- **Description**: admin updates tutor status.

---

### `ticket.routes.ts` — NOT mounted (router file exists, no entry in `src/index.ts`)

Prefix would be `/api/tickets` if registered. All controllers emit `{ message, data }` (envelope re-shaped).

#### `POST /`

- **Auth**: `isAuthenticated`.
- **Body**: `subject` (≤200, required), `category` (`billing|technical|lesson_issue|account|report|other`, required), `priority` (`low|medium|high|urgent`, optional), `message` (≤5000, required), `relatedLessonId, relatedTutorId, relatedStudentId` (optional strings).
- **Response**: created ticket.
- **Description**: user creates a support ticket.

#### `GET /my`

- **Auth**: `isAuthenticated`.
- **Query**: `page, limit, status`.
- **Response**: `{ tickets, pagination }`.
- **Description**: caller's tickets.

#### `POST /:id/reply`

- **Auth**: `isAuthenticated`. **Params**: `id`. **Body**: `message` (≤5000, required).
- **Response**: updated ticket.
- **Description**: user replies on own ticket.

#### `GET /admin`

- **Auth**: `isAuthenticated, isAdmin`.
- **Query**: `page, limit, search, status, category, priority, submitterType, sort` (all optional enums).
- **Response**: `{ tickets, pagination, summary }`.
- **Description**: admin ticket queue.

#### `POST /admin/:id/reply`

- **Auth**: `isAuthenticated, isAdmin`. **Body**: `message` (≤5000, required).
- **Response**: updated ticket.
- **Description**: admin replies to a ticket.

#### `PATCH /admin/:id/status`

- **Auth**: `isAuthenticated, isAdmin`. **Body**: `status` (`open|in_progress|awaiting_user|resolved|closed`, required).
- **Response**: `{ ticket }`.
- **Description**: admin changes ticket status.

#### `PATCH /admin/:id/priority`

- **Auth**: `isAuthenticated, isAdmin`. **Body**: `priority` (`low|medium|high|urgent`, required).
- **Response**: `{ ticket }`.
- **Description**: admin changes ticket priority.

---

## ESOL / Project Silk routes

### `esolOrg.routes.ts` — mounted at `/api/esol/organisations`

All routes require `isAuthenticated`.

#### `POST /`

- **Auth**: `isAdmin`.
- **Body**: `name` (2–120, required), `contactEmail` (email, required), `contactName` (2–100, required), `phoneNumber`, `address` (object), `contractStart, contractEnd` (ISO date, optional), `paymentModel` (`invoiced|stripe`, required), `invoiceCycle` (`monthly|quarterly|annual`, required), `maxLearners` (≥1, optional), `ilrProviderRef`, `adminFirstname`, `adminLastname` (1–50, required), `adminEmail` (email, required), `adminPhoneNumber` (required), `adminPassword` (min 8, required).
- **Response**: `{ org, admin }` (see `src/services/esolOrganisation.service.ts:79`).
- **Description**: provisions a new organisation and seeds its org admin.

#### `GET /`

- **Auth**: `isAdmin`.
- **Query**: `page, limit (≤100), search, isActive` (bool).
- **Response**: `{ orgs, pagination }`.
- **Description**: lists all organisations.

#### `GET /:orgId`

- **Auth**: `isOrgAdmin, requireOrgMatch`. **Params**: `orgId` (ObjectId).
- **Response**: org doc.
- **Description**: fetch one organisation (own org for org_admin, any for admin).

#### `PATCH /:orgId`

- **Auth**: `isAdmin`. **Params**: `orgId`.
- **Body**: any subset of provisioning fields except admin-credential fields (≥1 required).
- **Response**: updated org.
- **Description**: update org settings.

#### `PATCH /:orgId/status`

- **Auth**: `isAdmin`. **Body**: `isActive` (bool, required).
- **Response**: updated org.
- **Description**: activate/deactivate org.

---

### `esolReferral.routes.ts` — mounted at `/api/esol/referrals`

#### `GET /validate/:token`

- **Auth**: `authLimiter`, public.
- **Params**: `token` (string, required).
- **Response**: `{ orgName, orgLogoUrl, esolLevel, email }` (see `src/services/esolReferralToken.service.ts:170`).
- **Description**: preview a referral token before registration.

#### `POST /register`

- **Auth**: `authLimiter`, public.
- **Body**: `token` (required), `firstname, lastname` (1–50, required), `email` (email, required), `phoneNumber` (required), `password` (min 8, required), `l1Language` (optional), `uln` (optional).
- **Response**: `{ user }`.
- **Description**: register a learner via referral token.

#### `POST /`

- **Auth**: `isAuthenticated, isOrgAdmin`.
- **Body**: `orgId` (ObjectId, optional — defaults to caller's), `email` (optional), `esolLevel`, `expiresInDays` (1–365).
- **Response**: `{ referralToken, inviteUrl }`.
- **Description**: create a referral token and optionally email it.

#### `GET /`

- **Auth**: `isAuthenticated, isOrgAdmin`.
- **Query**: `page, limit, isActive, orgId`.
- **Response**: `{ tokens, pagination }`.
- **Description**: list referral tokens (own org for org_admin, any for admin).

---

### `esolOnboarding.routes.ts` — mounted at `/api/esol/onboarding`

#### `GET /placement-questions`

- **Auth**: `authLimiter`, public.
- **Response**: `{ questions }` (placement assessment items).
- **Description**: returns the D1 wizard's placement questions.

#### `POST /complete`

- **Auth**: `authLimiter`, public; multipart with optional `file` (residency document jpg/png/pdf).
- **Body**: free-form (no Joi schema) — controller expects either JSON or multipart field `data` containing a JSON-stringified payload (token, learner details, answers).
- **Response**: `{ user, ... }` (see `src/services/esolOnboarding.service.ts:217`).
- **Description**: completes the learner onboarding wizard and creates the account.

---

### `esolLearner.routes.ts` — mounted at `/api/esol/learners`

All routes require `isAuthenticated, isOrgAdmin`.

#### `GET /`

- **Query**: `page, limit (≤100), search, esolLevel, fundingStatus (esfa_funded|self_funded|employer_funded), orgId` (ObjectId).
- **Response**: `{ learners, pagination }`.
- **Description**: list learners in caller's org (or any org for admin).

#### `GET /:learnerId`

- **Params**: `learnerId` (ObjectId).
- **Response**: learner doc.
- **Description**: fetch one learner.

#### `PATCH /:learnerId`

- **Body**: any subset of `esolLevel, l1Language, uln, ulnStatus (pending|verified|not_required), fundingStatus` (≥1 required).
- **Response**: updated learner.
- **Description**: update learner ESOL fields.

---

### `esolTeacher.routes.ts` — mounted at `/api/esol/teachers`

All routes require `isAuthenticated`.

#### `GET /`

- **Auth**: `isOrgAdmin`. **Query**: `page, limit (≤100), search, approvedOnly` (bool).
- **Response**: `{ teachers, pagination }`.
- **Description**: list ESOL-approved teachers (admin sees all, org_admin sees their org's).

#### `POST /:tutorId/approve`

- **Auth**: `isAdmin`. **Body**: `esolQualificationType` (`CELTA|DELTA|CertTESOL|DipTESOL|PGCE|other`, required), `esolQualificationUrl` (URL, optional), `dbsCheckStatus` (`pending|clear|flagged|expired`), `esolTeacherNotes`.
- **Response**: updated tutor doc.
- **Description**: admin approves a tutor for ESOL.

#### `PATCH /:tutorId/qualifications`

- **Auth**: `isAdminOrgAdminOrSelf` (inline middleware in route file).
- **Body**: same fields as approval, all optional (≥1 required).
- **Response**: updated tutor.
- **Description**: tutor/admin updates ESOL qualifications.

#### `DELETE /:tutorId/approve`

- **Auth**: `isAdmin`. **Params**: `tutorId` (ObjectId).
- **Response**: updated tutor.
- **Description**: admin revokes ESOL approval.

---

### `esolAISession.routes.ts` — mounted at `/api/esol/sessions`

All routes require `isAuthenticated`.

#### `POST /`

- **Auth**: `isSessionManager` (inline: tutor | org_admin | admin).
- **Body**: `learnerId` (ObjectId, required), `teacherId` (ObjectId, required), `bookingId` (ObjectId, optional), `sessionMode` (`BRIDGE|ANCHOR|IMMERSION`, optional), `topic` (≤200).
- **Response**: created session doc.
- **Description**: create an AI tutoring session record.

#### `GET /`

- **Query**: `page, limit, learnerId, teacherId` (ObjectIds).
- **Response**: `{ sessions, pagination }`.
- **Description**: list AI sessions.

#### `GET /:sessionId`

- **Params**: `sessionId` (ObjectId).
- **Response**: session doc.
- **Description**: fetch a single session.

#### `POST /:sessionId/turns`

- **Auth**: `requireEsolLearner` (student with `orgId`).
- **Body**: `input` (1–2000, required).
- **Response**: `{ turn, sessionState, ... }` (see `src/services/esolAISession.service.ts:340`).
- **Description**: learner submits a turn; backend runs the AI tutor pipeline.

#### `PATCH /:sessionId/complete`

- **Auth**: `isSessionManager`.
- **Response**: updated session.
- **Description**: mark session complete.

#### `GET /:sessionId/prep`

- **Auth**: `isSessionManager`.
- **Response**: prep note doc (existing or newly generated).
- **Description**: returns or generates the teacher prep note for a session.

---

### `esolSafeguarding.routes.ts` — mounted at `/api/esol/safeguarding`

All routes require `isAuthenticated`.

#### `GET /`

- **Auth**: `isOrgAdmin`. **Query**: `page, limit, status (open|reviewed|escalated|resolved|dismissed), alertLevel (low|medium|high|critical), orgId`.
- **Response**: `{ alerts, pagination }`.
- **Description**: list safeguarding alerts.

#### `GET /:alertId`

- **Auth**: `isOrgAdmin`. **Params**: `alertId` (ObjectId).
- **Response**: alert doc.
- **Description**: fetch a single alert.

#### `PATCH /:alertId/review`

- **Auth**: `isAdmin`. **Body**: `status` (`reviewed|escalated|resolved|dismissed`, required), `resolution` (≤2000).
- **Response**: updated alert.
- **Description**: admin reviews/resolves an alert.

---

### `esolInvoice.routes.ts` — mounted at `/api/esol/invoices`

All routes require `isAuthenticated`.

#### `POST /generate`

- **Auth**: `isAdmin`. **Body**: `orgId` (ObjectId, required), `periodStart` (ISO date, required), `periodEnd` (ISO date, required), `notes` (≤1000).
- **Response**: created invoice.
- **Description**: manually generate an invoice for an org/period.

#### `GET /`

- **Auth**: `isOrgAdmin`. **Query**: `page, limit, status (draft|issued|paid|overdue|cancelled), orgId`.
- **Response**: `{ invoices, pagination }`.
- **Description**: list invoices (own org for org_admin).

#### `GET /:invoiceId`

- **Auth**: `isOrgAdmin`. **Params**: `invoiceId` (ObjectId).
- **Response**: invoice doc.
- **Description**: single invoice.

#### `GET /:invoiceId/pdf`

- **Auth**: `isOrgAdmin`. **Params**: `invoiceId`.
- **Response**: raw PDF buffer (`Content-Type: application/pdf`, NOT the standard envelope).
- **Description**: streams the invoice PDF.

#### `PATCH /:invoiceId/mark-paid`

- **Auth**: `isAdmin`. **Body**: `paidAt` (ISO date, optional), `notes` (≤1000).
- **Response**: updated invoice.
- **Description**: admin marks an invoice paid.

---

### `esolReport.routes.ts` — mounted at `/api/esol/reports`

All routes require `isAuthenticated`.

#### `GET /ilr`

- **Auth**: `isAdmin`.
- **Query**: `orgId` (ObjectId, required), `periodStart` (ISO date, required), `periodEnd` (ISO date, required).
- **Response**: raw CSV (`Content-Type: text/csv`, downloads as attachment). NOT the standard envelope.
- **Description**: ILR-format CSV export of learner outcomes.

#### `GET /integration-readiness`

- **Auth**: `isOrgAdmin`. **Query**: no Joi schema — accepts `orgId, periodStart, periodEnd` (defaults `orgId` to caller's for org_admin).
- **Response**: raw PDF buffer.
- **Description**: PDF readiness report for the org.

---

### `esolLevelChange.routes.ts` — mounted at `/api/esol/level-changes`

All routes require `isAuthenticated, isOrgAdmin`.

#### `POST /`

- **Body**: `learnerId` (ObjectId, required), `toLevel` (string, required), `reason` (5–1000, required), `evidenceSummary` (≤2000), `sessionId` (ObjectId, optional), `effectiveDate` (ISO date, optional).
- **Response**: created level-change record.
- **Description**: record a learner's level transition.

#### `GET /`

- **Query**: `page, limit, learnerId, orgId`.
- **Response**: `{ changes, pagination }`.
- **Description**: list level changes.

---

### `esolSessionFeedback.routes.ts` — mounted at `/api/esol/session-feedback`

All routes require `isAuthenticated`.

#### `GET /:sessionId`

- **Params**: `sessionId` (ObjectId).
- **Response**: `{ learnerFeedback, teacherFeedback }` (see `src/services/esolSessionFeedback.service.ts:140`).
- **Description**: fetch both halves of session feedback.

#### `POST /:sessionId/learner`

- **Auth**: `requireEsolLearner`.
- **Body**: `emojiRating` (`struggling|okay|confident`) **or** `rating` (1–5 int) — at least one required; `comment` (≤200), `topicsWorkedOn[]`.
- **Response**: created feedback doc.
- **Description**: learner submits post-session feedback.

#### `POST /:sessionId/teacher`

- **Auth**: inline `isTutor` (tutor role).
- **Body**: any of `rating` (1–5), `comment` (≤2000), `progressNotes` (≤4000), `topicsWorkedOn[]` (≥1 required).
- **Response**: created feedback doc.
- **Description**: teacher submits post-session feedback.

---

### `esolVocab.routes.ts` — mounted at `/api/esol/vocab`

All routes require `isAuthenticated`.

#### `GET /`

- **Query**: `page, limit (≤200), learnerId (ObjectId), esolLevel, topic, search`.
- **Response**: `{ vocab, pagination }`.
- **Description**: list vocabulary items.

#### `PATCH /:vocabId/mastery`

- **Params**: `vocabId` (ObjectId). **Body**: `masteryScore` (number 0–1, required).
- **Response**: updated vocab item.
- **Description**: update learner mastery for a vocab item.

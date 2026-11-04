# Daily class and subject lesson attendance

Recurring weekday Internship Visit automation and the `InternshipVisit` (IV) status are documented in [INTERNSHIP_API.md](INTERNSHIP_API.md). IV is counted separately and excluded, along with Free, from classroom attendance percentages.

The Attendance page and student Attendance history have separate daily and lesson views, monthly filters, recorded details, Excel export and Print / Save PDF through the browser dialog. Administrators manage direct class assignments in Attendance. Teachers default to lesson entry.

## Deployment and historical records

Run `npm run migrate:attendance` in `backend` against the intended database before deployment. Normal server startup uses the same additive upgrade path. Back up the database before deployment. Destructive test fixtures were confined to an isolated temporary MySQL database. Final read-only inspection found the local application database already had the new schema, with 190 historical lesson records, zero duplicate lesson contexts and zero daily records. Direct assignments, audits, schedules and coverage tables were empty.

- `attendances` remains the lesson table. Existing rows/IDs are preserved; new columns are `lessonId` (historical default `legacy`), nullable `teacherAssignmentId` and unique `contextKey`.
- Unknown historical teacher assignments/periods remain unknown. Administrative reports without a teacher filter retain historical lessons, including inactive assignments and unclassified records. Teacher-filtered reports include attributed records; a teacher's own legacy submissions can also be identified by `takenBy`.
- `dailyattendances` starts empty. No historical daily records are inferred, including from subjectless old records.
- New tables: `attendanceclassassignments`, `attendanceaudits`, `attendanceschedules`, `attendancecoverages`.
- Unique keys include kind, student, year, term (a sentinel for historical null terms), class, canonical date and session; lesson keys add subject and period. This avoids MySQL nullable unique-key loopholes. The old index that prevented multiple periods in one session is removed after the new unique key is installed.
- Duplicate historical contexts stop migration for explicit reconciliation. The migration does not delete, merge or reclassify them. Preserve the originals and document the reconciliation decision before retrying.
- `Teacher` is an explicit role requiring a teacher profile. Existing linked AttendanceTaker users retain assigned-subject lesson access for compatibility. Daily access uses the taker's assigned departments and shift. No automatic role conversions occur.
- The old `sync:attendance-indexes` command now follows the additive migration instead of unrestricted Sequelize schema alteration.

## Permissions

All endpoints are under `/api/attendance` and require an active user's Bearer token. Authorization uses database assignments; submitted teacher, department and student claims cannot widen access.

| Account | Daily entry | Lesson entry | Manage assignments/schedules |
| --- | --- | --- | --- |
| AttendanceTaker | Active classes in assigned departments and permitted shift; matching year/term; no teacher profile needed | Only if linked to the teacher owning the subject/class assignment | No |
| Teacher | No | Own active subject/class assignments | No |
| SuperAdmin, Director, DeputyDirector, StudentAffairs | Selected class/year/term | Selected active teacher assignment | Yes |
| HeadDepartment | Review only in assigned departments | Review only in assigned departments | No |
| Other roles | No | No | No |

Generic department, student and class lookups restrict attendance takers to assigned departments and permitted shifts. Teacher accounts retain subject lookups. Use monthly reports to distinguish multiple lesson periods, rather than the older mobile two-session summary.

## Mobile attendance taker flow

Assign one or more departments through the administrator user create/update API using `departmentIds`, for example `[5, 6]`. The legacy `departmentId` is also included in access; keep it consistent when changing assignments. No database migration is needed for this change. Individual class assignments no longer grant or restrict daily access; their legacy management endpoints remain for compatibility.

All requests require `Authorization: Bearer <token>`:

1. `GET /api/mobile/attendance/departments` returns `{count, departments: [{id, name, ...}]}` for the user's assigned departments. No assignments returns an empty list.
2. `GET /api/mobile/attendance/classes?departmentId=5` returns the existing `{summary, departments, classes}` response, filtered to the selected assigned department and permitted shift. An unassigned department returns 403; an invalid ID returns 400. Omitting the filter lists all accessible classes.
3. `GET /api/mobile/attendance/classes/:classId/students` returns the class and student roster only when the class belongs to an assigned department and permitted shift.
4. `GET /api/attendance/daily/scopes?departmentId=5` supplies valid class/year/term contexts. Select the matching context before requesting `/api/attendance/daily/roster` or submitting `/api/attendance/daily/mark` as documented below.

Department and shift restrictions apply to daily roster, submission, corrections, reports, audit access and generic directory endpoints. A stale class assignment cannot bypass them. Generic `GET /api/classes?departmentId=5` also supports department filtering. The client should display “No department assigned. Please contact your administrator.” when the assigned-department list is empty.

### Sections in the mobile roster

The student roster response also contains `sections: [{id, name}]` (active sections belonging to that class), `selectedSectionId` (null for all sections), and `classSectionId` on every student (null when unassigned).

Load `/api/mobile/attendance/classes/10/students` when class 10 is selected. If `sections` is empty, display its students directly. Otherwise show an “All Sections” option plus the returned sections. Selecting section 1 loads `/api/mobile/attendance/classes/10/students?classSectionId=1`. Omit the parameter for All Sections, including students without a section. The selected section filters students only; the response still includes all active section choices. Invalid section IDs return 400; inactive sections or sections belonging to another class return 404. Class department and shift authorization is checked before section lookup.

## Assignments and scopes

- `GET /class-assignees`: administrators list eligible users' IDs/names, without passwords or other account details.
- `GET /class-assignments?academicYearId=…`: administrators list all direct assignments; takers see their own.
- `POST /class-assignments`: `{userId, classId, academicYearId, termId}`. Validates an active AttendanceTaker and matching class/year/term. Repeated assignment reactivates the existing context.
- `DELETE /class-assignments/:id`: audited revocation, not physical deletion.
- `GET /daily/scopes?academicYearId=…` and `/lesson/scopes?academicYearId=…`: permitted contexts and display names. `history=1` includes inactive teaching assignments in administrative report filters; recording still requires an active assignment.

## Entry and corrections

### Yesterday, past dates and offline synchronization

Use a real `YYYY-MM-DD` date in Africa/Nairobi. Yesterday and older dates are permitted within the selected term; future dates and dates outside that term are rejected on both the dated roster and marking endpoints. Current department, shift, active class/student and assignment restrictions still apply when syncing later. There is no additional fixed backdating limit.

The mobile app can request `GET /api/mobile/attendance/classes?date=2026-11-03` and `GET /api/mobile/attendance/classes/10/students?date=2026-11-03`, optionally including the existing department or section filters. Both responses include top-level `attendanceDate`. Omitting `date` defaults to today in Africa/Nairobi. For compatibility, fields named `attendanceToday` and `doneToday` describe the requested date when `date` is supplied. Daily records from all takers in the permitted class are included, so another taker's submission is visible. Student session records include `revision`, `updatedAt` and `termId` for review. Use `/daily/roster` with the selected term/date/session for the exact marking context.

Load `GET /api/attendance/daily/roster?classId=10&academicYearId=2026&termId=1&date=2026-11-03&session=BeforeBreak` before marking online. Each student's `attendance` contains the saved mark and revision, or null when unrecorded. Display saved marks rather than creating another submission. Submit to `/daily/mark` with that same date and session; BeforeBreak and AfterBreak are independent.

Offline storage is owned by the mobile app. Cache a previously authorized roster and retain the complete selected context and draft marks locally. The backend cannot know about an unsynced draft. When connected, submit each queued batch through `/daily/mark` (or `/lesson/mark`) with `"offline": true`:

```json
{
  "classId": 10, "academicYearId": 2026, "termId": 1,
  "date": "2026-11-03", "session": "BeforeBreak",
  "offline": true,
  "records": [{"studentId": 100, "status": "Present", "remarks": ""}]
}
```

New marks are saved atomically. Identical retries succeed without creating duplicates or extra audits. A different existing mark returns HTTP 409 with `code: "ATTENDANCE_CONFLICT"`, `reviewRequired: true`, and `conflict: {studentId, date, session, existing, submitted}`. No marks in that batch are saved. This remains true even if the offline request supplies a correction reason and matching versions. A concurrent unique-key collision also returns 409 with the code/review flag; reload the roster for current details.

On 409, keep the local draft flagged for review and reload the exact dated roster; do not automatically overwrite or discard it. A reviewer can keep the server record or explicitly correct it online using `/mark` without `offline: true`, supplying a correction reason and the newly loaded revisions as described below. Remove a queued draft only after confirmed success or an explicit review decision. Authentication, permission and validation failures also leave the draft pending for resolution.

`GET /daily/roster`: `classId, academicYearId, termId, date, session`.

`GET /lesson/roster`: `assignmentId, date, session, lessonId`.

Each roster student has current `attendance`, including `id`/`updatedAt`/`revision`, or null. Dates must be real `YYYY-MM-DD` school dates and cannot be future dates in Africa/Nairobi. Sessions are `BeforeBreak` or `AfterBreak`.

`POST /daily/mark`:

```json
{
  "classId": 10, "academicYearId": 2026, "termId": 1,
  "date": "2026-10-28", "session": "BeforeBreak",
  "records": [{"studentId": 100, "status": "Present", "remarks": ""}]
}
```

`POST /lesson/mark` uses `assignmentId` instead of submitted class/year/term and also accepts `lessonId`, such as `P1` or `P2`. Use the stable timetable period ID (1–64 letters, digits, hyphens or underscores). Multiple lessons within the same break session must have separate IDs. Omission defaults to `legacy` for older clients. New lesson records always identify their teacher assignment.

Both workflows accept Present, Absent, Late, Permission and optional remarks up to 2,000 characters. Daily attendance additionally supports Free (F), as described below. Duplicate students, invalid dates/statuses/sessions, out-of-term dates and students outside the active class/year or selected section are rejected. Batches are atomic; lesson writes never touch daily records.

### Free (F): authorized release after an exam

The API value is `"Free"`; display it as **Free (F)**. AttendanceTaker accounts within assigned departments/shifts and administrators (including StudentAffairs) may record it through `POST /api/attendance/daily/mark`. Free is for daily releases, not lesson marks. Every Free record requires nonblank `remarks` explaining the release (maximum 2,000 characters).

```json
{
  "classId": 10,
  "academicYearId": 2026,
  "termId": 1,
  "classSectionId": 2,
  "date": "2026-11-01",
  "session": "AfterBreak",
  "records": [
    { "studentId": 100, "status": "Free", "remarks": "Released after final exam" }
  ]
}
```

For Mark all Free, load the selected roster and send one record per displayed student. Include `classSectionId` for a specific section; omit it for All Sections. The server validates class/year/section membership, rather than trusting submitted student IDs. Before Break and After Break are independent, so a full day requires explicitly saving both sessions. The bulk action must not silently convert the other session.

Existing records still require a `correctionReason` and current `versions` when changed. Unchanged retries are idempotent. Initial Free audit entries retain the release reason; corrections retain the previous status and reason through the existing audit trail.

Free is counted in `recorded` and the new `Free` summary/export column. `eligible = recorded - Free`; attendance percentage excludes Free and Not Taken. A roster containing only Free marks has a null attendance percentage, not 0%. Free is neither an absence nor an unrecorded expected session, and it does not trigger daily-present/lesson-absent alerts.

Deployment: back up the database, then run `npm run migrate:attendance` before using Free. Startup also runs this repeatable migration. It extends existing attendance status enums without changing historical marks. Deploy the UI after the API/schema update. No mobile app source is included here; mobile clients must send `"Free"`, require the reason and show F using this contract.

Unchanged retries are idempotent. To change an existing record, add:

```json
{
  "correctionReason": "Corrected after checking the class register",
  "versions": {"100": 0}
}
```

Use the exact integer roster `revision` for each changed student. Each correction increments it, including changes within the same timestamp resolution. Missing/stale versions or correction reasons return 409; reload before correcting. Record and audit persistence share one transaction. `GET /audit/daily/:id` or `/audit/lesson/:id` returns timestamp, actor, reason and before/after values with the same access restrictions. Attendance deletion is disabled.

Legacy `/assignments`, `/roster`, `/mark`, `POST /`, `POST /bulk`, `PUT /:id` and lesson read URLs remain compatibility adapters. All writes use the validated/audited lesson service; bulk groups contexts within one transaction. Corrections require the same reason/version fields. Subjectless historical records require explicit reconciliation and cannot be silently edited into daily records.

## Monthly reports

`GET /daily/monthly` and `/lesson/monthly` require `academicYearId` and `month=YYYY-MM`. Common optional filters: `termId, departmentId, classId, studentId`. Lesson filters additionally accept `subjectId, teacherId`.

Responses include:

- `data`: per-student/class/term daily summaries, or per-student/subject/class/term lesson summaries. Includes five status counts (including `Free`), `recorded`, `eligible`, `notTaken`, `percentage`, coverage and display names. Daily summaries include unique absent dates.
- `details`: recorded sessions or lessons with period IDs, status and remarks.
- `review`: lesson Absent records matching daily Present for the same student/year/term/class/date/session.
- `followUp`: student/subject patterns with at least two such recorded differences in the month. Messages request review without assuming motives.
- `formula`: **Present / (Present + Absent + Late + Permission) × 100**. Late and Permission remain in the denominator; Free and Not taken are excluded. Empty denominators return null, displayed as a dash.

Add `format=xlsx` for an actual Excel workbook containing summary, details, differences, follow-up and formula/filter metadata. The portal prints either selected view or saves it as PDF using the browser dialog.

Daily follow-up and the dashboard's highest-absence list use daily attendance only. A date with one or more daily Absent sessions counts once. Missed subject lessons remain a separate measure. Missing records are never confirmed absences.

## Calendar and timetable coverage

The repository previously had no persisted school calendar/timetable. Administrators now import a complete dated snapshot from the school's calendar, class schedule and timetable through the portal or `POST /planning`. Weekdays and subject assignments alone never imply an expected session.

Payload: `{kind, academicYearId, termId, classId, month, source, calendar, entries}`.

- `kind` is daily or lesson; `month` is YYYY-MM. `source` identifies the approved calendar/schedule and revision.
- `calendar` must enumerate **every date in the month exactly once**, each as `{date, isSchoolDay}`. Explicitly mark weekends/holidays/closures false according to the school calendar. No Monday–Friday assumption is made.
- `entries` is the complete dated set of expected sessions/lessons for that class/term/month, including future dates. Each has `{date, session, endsAt}`. `endsAt` must include a timezone and fall on the school date in Africa/Nairobi.
- Lesson entries additionally require `{assignmentId, lessonId}` matching class/year/term and the stable period used when recording attendance.
- Entries on closed dates or outside the term are rejected. Unscheduled subjects/periods must not have entries. A known empty timetable is a complete calendar with empty entries.
- Import replaces only that kind/class/term/month snapshot atomically, with a planning audit. Other months and recorded attendance remain unchanged.
- Importing asserts a complete snapshot; do not certify partial schedules as complete.

Example individual calendar rows and timetable entries (place them in a payload with every date for the month):

```json
{
  "calendar": [
    {"date": "2026-10-01", "isSchoolDay": true},
    {"date": "2026-10-02", "isSchoolDay": false}
  ],
  "entries": [
    {"date": "2026-10-01", "session": "BeforeBreak", "endsAt": "2026-10-01T09:00:00+03:00", "assignmentId": 1, "lessonId": "P1"},
    {"date": "2026-10-01", "session": "BeforeBreak", "endsAt": "2026-10-01T10:00:00+03:00", "assignmentId": 1, "lessonId": "P2"}
  ]
}
```

Expected counts include only school-day entries whose end timestamp has elapsed. A missing context counts once. Future sessions, calendar closures and unscheduled lessons are excluded. Without a complete imported snapshot, `notTaken` is null and coverage displays **Unavailable**; recorded counts and percentages remain usable.

## Verification

- `npm test`: service regression suite including the exact Abdisamad example, scope/teacher-filter tampering, corrections and audits, separate writes, unique absent dates, expected coverage, distinct periods and denominator rules.
- `npm run test:attendance:mysql`: isolated real MySQL test. Creates a uniquely named temporary database and removes only that database in `finally`. Exercises repeatable legacy migration, real unique indexes, concurrent submissions, audit rollback, JWT-protected routes, unauthorized classes/assignment writes, repeated schedule replacement and Excel workbook parsing. Uses backend `.env` credentials and needs create/drop-database privileges. It does not modify the application database.
- `npm run build` in `frontend`: production client/server build. Repository-wide `tsc --noEmit` reports existing errors outside the new attendance workspace; the new component has no reported TypeScript errors.

## Admin read-only section filtering

- GET /daily/sections and /lesson/sections require classId and accept academicYearId/departmentId. They return active sections only after checking the user's permitted attendance class scopes.
- GET /daily, /daily/roster, /lesson/roster, /daily/monthly and /lesson/monthly accept optional classSectionId. A section requires classId; invalid IDs return 400, out-of-scope classes 403, and inactive or wrong-class sections 404. Omitting classSectionId includes all sections and unassigned students.
- Monthly reads accept attendanceDate (YYYY-MM-DD, within month) and attendanceSession (BeforeBreak or AfterBreak). These filters also constrain recorded details, expected scheduled sessions, differences, follow-up and format=xlsx exports.
- Monthly results include backend-calculated totals: students, Present, Absent, Late, Permission, Free and notTaken (null when coverage is unavailable). Selected section metadata is included in context and summary/export rows.
- Existing attendance rows do not store a historical section snapshot. Section-filtered history uses current student section membership and does not invent historical section assignments.
- Mark endpoints and attendance-writing authorization are unchanged. These additions are for viewing only and do not assert section enforcement on writes.

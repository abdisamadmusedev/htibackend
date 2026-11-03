# Automatic recurring Internship Visit (IV)

Student Affairs and SuperAdmin configure rules in the portal's Attendance page, under **Automatic Internship Visit (IV)**. There are no date inputs: select the academic year, class, optional section, weekdays and sessions, and provide a placement/location reason. The rule is effective from the day it is created, in Africa/Nairobi. It repeats until paused or its academic year ends. Only an active academic year and active class/section are processed. Marks are only created within exactly one matching term's existing start/end dates. No marks are made outside terms or after the selected year ends.

Examples:

- Energy Class Four: Tuesday (`2`), both sessions.
- Mechanic Class Four: Saturday and Sunday (`[6,0]`), both sessions.

IV means **scheduled for an authorized internship visit**, not confirmation of actual placement attendance.

## API

All requests require the normal Bearer token. Only SuperAdmin and StudentAffairs may access rule management; other roles receive 403.

- `GET /api/internship-rules?academicYearId=2026` returns `{data: rules}`.
- `POST /api/internship-rules` creates an active rule, returning HTTP 201 and `{data: rule}`.
- `PATCH /api/internship-rules/:id` with `{ "isActive": false }` pauses it; use `true` to resume from today. Existing marks are retained. Paused days are never backfilled on resume. Repeating the same state change is a no-op.

```json
{
  "academicYearId": 2026,
  "classId": 10,
  "classSectionId": null,
  "weekdays": [6, 0],
  "sessions": ["BeforeBreak", "AfterBreak"],
  "remarks": "Mechanic company internship visit"
}
```

`weekdays`: integers Sunday=0, Monday=1, Tuesday=2, Wednesday=3, Thursday=4, Friday=5, Saturday=6. `classSectionId` null/omitted means all sections, including students without a section. `remarks` is required and limited to 1000 characters. The server validates the active class belongs to the year and the active section belongs to the class. Invalid configuration returns 400. A missing rule returns 404.

Rule responses include `id`, the configuration above, `isActive`, `createdBy`, system-generated `effectiveFrom`, `processedThrough`, and timestamps. JSON weekday/session arrays may be returned by the database as serialized JSON strings; clients should normalize either representation. `processedThrough` is a worker cursor, not proof every date had matching weekdays, a term or eligible students.

Rules are intentionally immutable except for pause/resume. To change weekdays or class, pause the old rule and create its replacement. Pause and resume are audited; resuming also assigns ownership to the manager who resumes the rule. If the manager account is disabled, removed or loses its manager role, the worker stops processing its rules; an authorized manager can resume ownership by pausing and resuming.

## Automatic processing

`server.js` starts the worker after the database migration/connection succeeds. It runs immediately and every 60 seconds without any app/portal request. An always-running Node.js backend is required. Redeploy/restart reactivates the worker automatically; running only a frontend does not.

- Each rule is locked in a database transaction, so two worker instances cannot simultaneously apply the same rule.
- The worker uses the saved academic year, current active class/section roster and valid term for each school date. It never guesses a term when term dates overlap; processing fails for that rule, logs its ID, and retries later until the calendar is corrected. Other rules continue.
- Each matching session is marked `status: "InternshipVisit"` only when that student/year/date/session has no saved daily attendance. Existing Present, Absent, Late, Permission, Free and IV marks are retained. Attendance keys and transactional audit entries prevent duplicate marks and orphaned audits.
- BeforeBreak and AfterBreak are independent. Selecting both creates both at the first check on the matching day; these are schedule labels, not verification that the activity occurred.
- Remarks identify the rule: `Automatically marked from internship schedule #...`. Audit reasons identify the automatic action and rule ID, attributed to the rule owner. Rule changes also have before/after audit entries.
- After downtime, the cursor catches up from the last processed day, at most seven dates per rule per tick. Today is rechecked so students added later today can receive missing IV marks. There is no backfill before initial creation or through deliberately paused periods.
- Catch-up uses **current** enrollment/section membership because the system has no historical enrollment snapshots. It skips dates before a student's account was created. Review old catch-up records if students changed classes/sections during the outage.
- Authorized staff may correct individual IV marks using the existing daily correction flow, with a correction reason and current revision. The worker never overwrites these exceptions. It does not delete saved marks when a rule is paused or the calendar changes.

## Reports, dashboard and mobile clients

Display `InternshipVisit` as **Internship Visit (IV)**. Daily roster/mobile responses return the stored status and explanatory remarks. No mobile action is required for automatic marking, but mobile interfaces must recognize the new status.

Monthly reports, totals and Excel exports include `InternshipVisit` separately. `recorded` includes IV; `eligible = recorded - Free - InternshipVisit`. Classroom attendance percentage is `Present / (Present + Absent + Late + Permission) * 100`. An IV-only or Free/IV-only set has a null rate, not 0%. Saved IV counts as recorded for expected-session coverage and is not an absence or daily-Present/lesson-Absent alert.

Dashboard status `counts`/`percentages` include IV. Status percentages describe all saved marks; use `presentPercentage`, which excludes Free and IV, for the attendance rate. All-IV days have `hasData=true`, `eligible=0`, and `presentPercentage=null`.

Manual correction to IV is allowed only in daily attendance by existing authorized administrators/attendance takers, requires a reason in `remarks`, and retains class/year/section scope checks. IV is not an exam-mark or lesson-attendance status.

## Deploy and verify

Back up the live database. Deploy the backend and run `npm run migrate:attendance` (normal startup also migrates). The additive schema update extends the attendance enums and `sequelize.sync()` creates `internshiprules`; it does not replace existing data. Configure production environment variables outside Git. Deploy the portal update after the backend/schema update.

Create one rule for an active year/class with correctly configured term dates and today's weekday, then wait for the worker and check daily roster/audit records. Pause the rule to stop future automatic entries; saved marks remain. `npm test` covers validation and counting. `npm run test:attendance:mysql` checks actual migrations, authenticated management, weekday processing, existing-mark preservation, retries and pause/resume against an isolated temporary database.

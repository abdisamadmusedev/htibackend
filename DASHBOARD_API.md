# Dashboard API

Internship Visit: `counts` and `percentages` now also include `InternshipVisit` (display **IV**). `eligible = recorded - Free - InternshipVisit`; `presentPercentage` excludes both. An IV-only day has recorded data but a null classroom attendance rate. See [INTERNSHIP_API.md](INTERNSHIP_API.md) for recurring weekday automation.

`GET /api/dashboard` returns the admin dashboard in one request. Authenticate with `Authorization: Bearer <token>`. No database migration is required. This adds the API; the existing frontend still needs to consume it.

SuperAdmin, Director, DeputyDirector and StudentAffairs can view all departments. HeadDepartment can view only assigned departments. Other roles receive 403, and missing/invalid/inactive sessions receive 401. Department scope is enforced before counting, including nested class breakdowns and attendance totals.

## Query parameters

| Parameter | Meaning | Default |
| --- | --- | --- |
| `academicYearId` | Positive integer ID | Omit for all academic years |
| `departmentId` | Positive integer ID; applies to all dashboard widgets | All permitted departments |
| `date` | Valid `YYYY-MM-DD` attendance date | Today in Africa/Nairobi |
| `session` | `BeforeBreak` or `AfterBreak` for the daily chart | `BeforeBreak` |
| `weekStart` | Valid `YYYY-MM-DD`, must be Saturday | Saturday of the week containing `date` |
| `trendSession` | Session for weekly chart, independently selectable | Same as `session` |

Example: `/api/dashboard?academicYearId=2026&departmentId=5&date=2026-10-31&session=BeforeBreak&weekStart=2026-10-31&trendSession=AfterBreak`.

Malformed filters return 400 with `{ "message": "..." }`. A department head requesting an unassigned department receives 403. Valid filters with no data return 200 with zero counts and null attendance percentages.

## Response

The response is `{ "data": { ... } }`. Example values below are illustrative. The real weekly array always contains five entries, Saturday through Wednesday.

```json
{
  "data": {
    "filters": {
      "academicYearId": 2026,
      "departmentIds": [5],
      "date": "2026-10-31",
      "session": "BeforeBreak",
      "trendSession": "BeforeBreak",
      "weekStart": "2026-10-31",
      "weekEnd": "2026-11-04",
      "timezone": "Africa/Nairobi"
    },
    "students": {
      "total": 30,
      "male": 18,
      "female": 12,
      "vocational": { "total": 20, "male": 12, "female": 8 },
      "secondary": { "total": 10, "male": 6, "female": 4 },
      "other": { "total": 0, "male": 0, "female": 0 }
    },
    "departments": [
      {
        "id": 5,
        "name": "Information Technology",
        "code": "ICT",
        "total": 30,
        "vocational": 20,
        "secondary": 10,
        "other": 0,
        "classes": [
          {
            "id": 10,
            "name": "Form Two",
            "departmentId": 5,
            "academicYearId": 2026,
            "programId": 1,
            "shift": "Morning",
            "total": 20,
            "vocational": 20,
            "secondary": 0,
            "other": 0
          },
          {
            "id": 11,
            "name": "Form Three",
            "departmentId": 5,
            "academicYearId": 2026,
            "programId": 2,
            "shift": "Morning",
            "total": 10,
            "vocational": 0,
            "secondary": 10,
            "other": 0
          }
        ]
      }
    ],
    "todayAttendance": {
      "date": "2026-10-31",
      "session": "BeforeBreak",
      "counts": { "Present": 24, "Absent": 3, "Late": 2, "Permission": 1, "Free": 0 },
      "recorded": 30, "eligible": 30,
      "percentages": { "Present": 80, "Absent": 10, "Late": 6.7, "Permission": 3.3, "Free": 0 },
      "presentPercentage": 80,
      "hasData": true
    },
    "weeklyAttendance": [
      {
        "date": "2026-10-31",
        "session": "BeforeBreak",
        "counts": { "Present": 24, "Absent": 3, "Late": 2, "Permission": 1, "Free": 0 },
        "recorded": 30, "eligible": 30,
        "percentages": { "Present": 80, "Absent": 10, "Late": 6.7, "Permission": 3.3, "Free": 0 },
        "presentPercentage": 80,
        "hasData": true,
        "dayName": "Sabti"
      }
    ],
    "upcomingActivities": [],
    "upcomingActivitiesAvailable": false,
    "definitions": {
      "students": "Active student accounts with status Active; grouped by current enrollment.",
      "attendance": "Daily attendance only; each student counted once per date/session. Latest updated context wins, then highest ID. Missing records are not absences.",
      "presentPercentage": "Present / eligible (Present + Absent + Late + Permission) * 100; Free excluded; null when no eligible records. Status percentages use all recorded marks.",
      "upcomingActivities": "No activity source is configured."
    }
  }
}
```

## Widget mapping and counting rules

- Total Students: `data.students.total`; program subtitles use `vocational.total` and `secondary.total`.
- Program cards: `data.students.vocational` and `.secondary`, including male/female counts.
- Department table: `data.departments`; expand `classes` for the View classes action. IDs distinguish classes with identical names. Department/class rows with zero active students remain visible.
- Department table overall totals: sum the department rows or use `data.students` under the same filters.
- Daily doughnut and legend: `data.todayAttendance`; display all five statuses, including Permission and Free (F). Roundings may sum to slightly above or below 100%.
- Weekly bars: `data.weeklyAttendance`, labels Sabti, Axad, Isniin, Talaado, Arbaco. Plot `counts.Present` and `counts.Absent` as shown in the design. Each day also includes Late, Permission and Free (F) for a complete tooltip.
- Empty attendance: `hasData: false`, recorded/status counts zero, percentages null. Show “No attendance recorded”; do not show a fabricated 0% attendance rate or count missing students as absent. Future dates likewise have no records rather than forecast data.
- Student cards count current active enrollments (`isActive=true`, `status=Active`). Attendance counts saved daily marks in the requested year/department, including historical marks for students whose current enrollment has changed. Thus recorded counts and current student totals need not match.
- Lesson attendance is never mixed into these charts. Attendance for every taker is included, not only the logged-in user's marks. Overlapping term/class records for the same student/date/session are deduplicated after applying the year/department filters; latest updated context wins, then highest ID.
- “All academic years” means omitting `academicYearId`, not sending `all` or `0`. Student totals still describe current enrollments; the database does not provide historical enrollment snapshots.
- Upcoming activities has no configured data source. The empty array and availability flag explicitly represent this; no sample events are invented.

## Frontend integration

Replace the dashboard's many student/class/attendance requests with this single authenticated summary request. Read `body.data`, check HTTP errors, and retain loading/retry states. On year, department, date or session changes, refetch with the selected parameters and cancel stale requests. Do not recompute counts from paginated student lists or lesson records.

Quick links remain frontend navigation actions. Changing the department table's filter can either refetch the dashboard with `departmentId` (updates all widgets) or filter the returned department rows locally if that control is intended to affect only the table. The API's `departmentId` always applies consistently to all returned metrics.

Validation: `npm test` includes dashboard filter/aggregation tests. `npm run test:attendance:mysql` uses an isolated temporary database and checks authenticated dashboard requests, year/session/department isolation, department-head permissions, no-data handling and duplicate attendance contexts.

Free (F) marks are recorded but excluded from the attendance-rate denominator. Use `presentPercentage` for the attendance rate; do not use `percentages.Present` for this because status percentages describe all recorded marks, including Free. When every mark is Free, `hasData` is true, `eligible` is zero, and `presentPercentage` is null: display 'Free / no eligible attendance', not 0%.

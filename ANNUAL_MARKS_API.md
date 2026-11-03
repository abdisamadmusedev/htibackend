# Both-term exam marks Excel API

All routes require the existing bearer authentication.

## Download

`GET /api/exam-marks/annual-template?academicYearId=7&classId=2&classSectionId=8`

Roles: SuperAdmin, ExamManager, HeadDepartment (own department only).
`sectionId` is accepted as an alias for `classSectionId`. This is a ClassSection ID; department/technical section is derived from the class.

Returns an `.xlsx` workbook with **Term 1** and **Term 2** worksheets, student IDs, admission numbers, names, configured subject components and calculated subject totals. Only active students in the selected class, section and academic year are included.

Configure subjects and an Open, unpublished exam in each term first. If several eligible exams exist, supply `term1ExamId` and `term2ExamId` to select them explicitly. Both term sheets are required for upload. This endpoint does not create exams or subject allocations.

## Preview

`POST /api/exam-marks/annual-import/preview`

Roles: SuperAdmin, ExamManager. Send multipart form data with the workbook in `file`.
Returns `{ valid, terms }`; each term contains its exam, class, subjects, summary, parsed rows and validation errors. No marks are written.

## Import both terms once

`POST /api/exam-marks/annual-import` (alias: `/annual-import/confirm`)

Same roles and multipart `file` field as preview. Preview is optional; this endpoint always revalidates the uploaded file. Success: HTTP 201 with `{ message, summary: { terms } }`.

Both terms save in one transaction. Any validation or persistence failure prevents partial imports. Re-uploading unchanged marks leaves them unchanged; corrections update marks and write edit history. Both exams must remain Open and unpublished.

Enter every enabled component as a number within its configured maximum, or `NG` (case insensitive). **NG means missing and contributes zero to totals and percentage calculations.** Numeric zero is stored in the component; `NG: theoryMark`, `NG: practicalMark`, or `NG: monthlyAssessmentMark` is preserved in remarks. Blank cells remain invalid. Other codes, including NE, are not assigned an assumed meaning and are rejected.

No database schema migration is required. Workbook totals are for convenience; the server calculates marks from component cells. Imported data uses the normal exam marks and results workflow.

const test = require("node:test");
const assert = require("node:assert/strict");
const service = require("../src/modules/attendance/internshipService");
const domain = require("../src/modules/attendance/attendanceDomain");
const dashboard = require("../src/modules/dashboard/dashboardService");
const input = { classId: 10, academicYearId: 1, weekdays: [6, 0], sessions: ["BeforeBreak", "AfterBreak"], remarks: "Company placement" };
test("internship weekdays require a valid class/year, weekdays, sessions and reason", () => {
  assert.deepEqual(service.configuration(input).weekdays, [0, 6]);
  assert.equal(service.configuration({ ...input, classSectionId: "2" }).classSectionId, 2);
  for (const values of [{ weekdays: [] }, { weekdays: [7] }, { weekdays: ["2"] }, { sessions: [] }, { sessions: ["Both"] }, { remarks: " " }, { academicYearId: 0 }, { classSectionId: -1 }]) assert.throws(() => service.configuration({ ...input, ...values }), { status: 400 });
  for (const role of ["Teacher", "AttendanceTaker", "HeadDepartment", "Director"]) assert.throws(() => service.requireManager({ role }), { status: 403 });
  service.requireManager({ role: "StudentAffairs" });
  service.requireManager({ role: "SuperAdmin" });
});
test("IV is counted separately and excluded from classroom percentages and absence alerts", () => {
  const records = ["Present", "Absent", "Free", "InternshipVisit"].map(status => ({ status, attendanceDate: "2026-11-02" }));
  const result = domain.summarize(records);
  assert.equal(result.recorded, 4);
  assert.equal(result.eligible, 2);
  assert.equal(result.InternshipVisit, 1);
  assert.equal(result.percentage, 50);
  assert.equal(domain.summarize([records[3]]).percentage, null);
  const chart = dashboard.attendanceSummary([{ date: "2026-11-02", session: "BeforeBreak", status: "InternshipVisit", count: 30 }], "2026-11-02", "BeforeBreak");
  assert.equal(chart.counts.InternshipVisit, 30);
  assert.equal(chart.recorded, 30);
  assert.equal(chart.eligible, 0);
  assert.equal(chart.presentPercentage, null);
  assert.equal(domain.differences([{ studentId: 1, status: "InternshipVisit", attendanceDate: "2026-11-02" }], [{ studentId: 1, status: "Absent", attendanceDate: "2026-11-02" }]).length, 0);
});

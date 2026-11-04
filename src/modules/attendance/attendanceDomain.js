const STATUSES = ["Present", "Absent", "Late", "Permission", "Free", "InternshipVisit"];
const SESSIONS = ["BeforeBreak", "AfterBreak"];
const ADMINS = ["SuperAdmin", "Director", "DeputyDirector", "StudentAffairs"];
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const id = value => { const n = Number(value); if (!["number", "string"].includes(typeof value) || !/^\d+$/.test(String(value)) || !Number.isSafeInteger(n) || n <= 0) fail("A positive integer ID is required"); return n; };
const dateOnly = value => {
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "") || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail("Invalid date (YYYY-MM-DD required)");
  return value;
};
const day = value => new Date(value).toISOString().slice(0, 10);
const schoolToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Nairobi", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const attendanceDate = value => {
  const date = dateOnly(value);
  if (date > schoolToday()) fail("Future attendance cannot be recorded");
  return date;
};
const contextKey = (kind, scope, studentId, date, session, lessonId = "legacy") =>
  [kind, studentId, scope.academicYearId, scope.termId || 0, scope.classId, date, session, ...(kind === "lesson" ? [scope.subjectId, lessonId] : [])].join(":");
const sessionKey = row => [row.studentId, row.academicYearId, row.termId || 0, row.classId, day(row.attendanceDate), row.attendanceSession].join(":");
function summarize(records, expected = null) {
  const counts = Object.fromEntries(STATUSES.map(status => [status, records.filter(r => r.status === status).length]));
  const eligible = records.length - counts.Free - counts.InternshipVisit;
  return { ...counts, recorded: records.length, eligible, notTaken: expected === null ? null : Math.max(0, expected), percentage: eligible ? Number((counts.Present / eligible * 100).toFixed(1)) : null,
    uniqueAbsentDates: [...new Set(records.filter(r => r.status === "Absent").map(r => day(r.attendanceDate)))].sort() };
}
function differences(daily, lessons) {
  const present = new Set(daily.filter(r => r.status === "Present").map(sessionKey));
  return lessons.filter(r => r.status === "Absent" && present.has(sessionKey(r)));
}
function departmentIds(user) {
  let values = user.departmentIds || [];
  if (typeof values === "string") { try { values = JSON.parse(values); } catch { values = []; } }
  return [...new Set([user.departmentId, ...(Array.isArray(values) ? values : [])].map(v => Number(v?.id || v?._id || v)).filter(v => Number.isSafeInteger(v) && v > 0))];
}
function attendanceClassAllowed(user, classroom) {
  if (!departmentIds(user).includes(Number(classroom.departmentId))) return false;
  const shift = String(user.attendanceShift || "all").trim().toLowerCase();
  return !shift || shift === "all" || String(classroom.shift).toLowerCase() === shift;
}
module.exports = { STATUSES, SESSIONS, ADMINS, fail, id, dateOnly, day, schoolToday, attendanceDate, contextKey, sessionKey, summarize, differences, departmentIds, attendanceClassAllowed };

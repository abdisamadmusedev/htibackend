const { Op, fn, col, QueryTypes } = require("sequelize");
const { initializeModels, sequelize } = require("../../config/mysql");
const { ADMINS, departmentIds, id, dateOnly, fail, SESSIONS } = require("../attendance/attendanceDomain");

const schoolDate = () => new Intl.DateTimeFormat("en-CA", {
  timeZone: "Africa/Nairobi", year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date());
const addDays = (date, days) => {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};
function filtersFor(user, query) {
  if (![...ADMINS, "HeadDepartment"].includes(user.role)) fail("Dashboard access required", 403);
  const filters = {};
  for (const key of ["academicYearId", "departmentId"]) if (query[key] !== undefined) filters[key] = id(query[key]);
  if (user.role === "HeadDepartment") {
    const allowed = departmentIds(user);
    if (!allowed.length || filters.departmentId && !allowed.includes(filters.departmentId)) fail("Department is outside your assignments", 403);
    if (!filters.departmentId) filters.departmentId = { [Op.in]: allowed };
  }
  const date = query.date === undefined ? schoolDate() : dateOnly(query.date);
  const session = query.session === undefined ? "BeforeBreak" : query.session;
  const trendSession = query.trendSession === undefined ? session : query.trendSession;
  if (!SESSIONS.includes(session) || !SESSIONS.includes(trendSession)) fail("Invalid attendance session");
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  const weekStart = query.weekStart === undefined ? addDays(date, -((weekday + 1) % 7)) : dateOnly(query.weekStart);
  if (new Date(`${weekStart}T00:00:00Z`).getUTCDay() !== 6) fail("weekStart must be a Saturday");
  return { filters, date, session, trendSession, weekStart };
}
const emptyCounts = () => ({ total: 0, male: 0, female: 0 });
const emptyPrograms = () => ({ total: 0, vocational: 0, secondary: 0, other: 0 });
function studentSummary(groups, programs, departments, classes) {
  const byProgram = new Map(programs.map(p => [Number(p.id), p.name]));
  const totals = { ...emptyCounts(), vocational: emptyCounts(), secondary: emptyCounts(), other: emptyCounts() };
  const rows = new Map(departments.map(d => [Number(d.id), { id: Number(d.id), name: d.name, code: d.code, ...emptyPrograms(), classes: [] }]));
  const classRows = new Map(classes.map(c => [Number(c.id), { id: Number(c.id), name: c.name, departmentId: Number(c.departmentId), academicYearId: Number(c.academicYearId), programId: Number(c.programId), shift: c.shift, ...emptyPrograms() }]));
  const increment = (row, type, count) => { row.total += count; row[type] += count; };
  for (const group of groups) {
    const count = Number(group.count);
    const type = ({ Vocational: "vocational", Secondary: "secondary" })[byProgram.get(Number(group.programId))] || "other";
    totals.total += count;
    totals[type].total += count;
    const gender = ({ Male: "male", Female: "female" })[group.gender];
    if (gender) { totals[gender] += count; totals[type][gender] += count; }
    const department = rows.get(Number(group.departmentId));
    const classroom = classRows.get(Number(group.classId));
    if (department) increment(department, type, count);
    if (classroom) increment(classroom, type, count);
  }
  for (const classroom of classRows.values()) rows.get(classroom.departmentId)?.classes.push(classroom);
  return { students: totals, departments: [...rows.values()] };
}
function attendanceSummary(rows, date, session) {
  const counts = { Present: 0, Absent: 0, Late: 0, Permission: 0, Free: 0, InternshipVisit: 0 };
  for (const row of rows) if (row.date === date && row.session === session && row.status in counts) counts[row.status] += Number(row.count);
  const recorded = Object.values(counts).reduce((sum, n) => sum + n, 0);
  const percentages = Object.fromEntries(Object.entries(counts).map(([key, count]) => [key, recorded ? Number((count * 100 / recorded).toFixed(1)) : null]));
  const eligible = recorded - counts.Free - counts.InternshipVisit;
  return { date, session, counts, recorded, eligible, percentages, presentPercentage: eligible ? Number((counts.Present * 100 / eligible).toFixed(1)) : null, hasData: recorded > 0 };
}
async function summary(user, query = {}) {
  const context = filtersFor(user, query);
  const { filters, date, session, trendSession, weekStart } = context;
  const M = initializeModels();
  const departmentWhere = filters.departmentId ? { id: filters.departmentId } : {};
  const [groups, programs, departments, classes] = await Promise.all([
    M.Student.findAll({ where: { ...filters, isActive: true, status: "Active" }, attributes: ["programId", "departmentId", "classId", "gender", [fn("COUNT", col("id")), "count"]], group: ["programId", "departmentId", "classId", "gender"], raw: true }),
    M.Program.findAll({ attributes: ["id", "name"], raw: true }),
    M.Department.findAll({ where: departmentWhere, attributes: ["id", "name", "code"], order: [["name", "ASC"]], raw: true }),
    M.Class.findAll({ where: filters, attributes: ["id", "name", "departmentId", "academicYearId", "programId", "shift"], order: [["name", "ASC"]], raw: true }),
  ]);
  const dates = [...new Set([date, ...Array.from({ length: 5 }, (_, i) => addDays(weekStart, i))])];
  const replacements = { dates, sessions: [...new Set([session, trendSession])] };
  const clauses = ["DATE(attendanceDate) IN (:dates)", "attendanceSession IN (:sessions)"];
  if (filters.academicYearId) { clauses.push("academicYearId = :academicYearId"); replacements.academicYearId = filters.academicYearId; }
  if (filters.departmentId) {
    clauses.push("departmentId IN (:departmentIds)");
    replacements.departmentIds = typeof filters.departmentId === "number" ? [filters.departmentId] : filters.departmentId[Op.in];
  }
  // A student is counted once per date/session, even if overlapping term or
  // class contexts exist. Select the most recently updated context, then ID.
  const rows = await sequelize.query(`
    SELECT DATE_FORMAT(d.attendanceDate, '%Y-%m-%d') AS date,
      d.attendanceSession AS session, d.status, COUNT(*) AS count
    FROM dailyattendances d
    JOIN (
      SELECT studentId, DATE(attendanceDate) AS schoolDate, attendanceSession,
        MAX(CONCAT(DATE_FORMAT(updatedAt, '%Y%m%d%H%i%s%f'), LPAD(id, 20, '0'))) AS latest
      FROM dailyattendances WHERE ${clauses.join(" AND ")}
      GROUP BY studentId, DATE(attendanceDate), attendanceSession
    ) chosen ON chosen.studentId = d.studentId
      AND chosen.schoolDate = DATE(d.attendanceDate)
      AND chosen.attendanceSession = d.attendanceSession
      AND chosen.latest = CONCAT(DATE_FORMAT(d.updatedAt, '%Y%m%d%H%i%s%f'), LPAD(d.id, 20, '0'))
    GROUP BY DATE_FORMAT(d.attendanceDate, '%Y-%m-%d'), d.attendanceSession, d.status
  `, { replacements, type: QueryTypes.SELECT });
  const result = studentSummary(groups, programs, departments, classes);
  return {
    filters: { academicYearId: filters.academicYearId || null, departmentIds: departments.map(d => Number(d.id)), date, session, trendSession, weekStart, weekEnd: addDays(weekStart, 4), timezone: "Africa/Nairobi" },
    ...result,
    todayAttendance: attendanceSummary(rows, date, session),
    weeklyAttendance: Array.from({ length: 5 }, (_, i) => {
      const day = addDays(weekStart, i);
      return { ...attendanceSummary(rows, day, trendSession), dayName: ["Sabti", "Axad", "Isniin", "Talaado", "Arbaco"][i] };
    }),
    upcomingActivities: [],
    upcomingActivitiesAvailable: false,
    definitions: { students: "Active student accounts with status Active; grouped by current enrollment.", attendance: "Daily attendance only; each student counted once per date/session. Latest updated context wins, then highest ID. Missing records are not absences.", presentPercentage: "Present / eligible (Present + Absent + Late + Permission) * 100; Free and Internship Visit excluded; null when no eligible records. Status percentages use all recorded marks.", upcomingActivities: "No activity source is configured." },
  };
}
module.exports = { summary, filtersFor, studentSummary, attendanceSummary, addDays };

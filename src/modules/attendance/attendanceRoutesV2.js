const express = require("express");
const { Op } = require("sequelize");
const { sequelize } = require("../../config/mysql");
const service = require("./attendanceService");
const { id, dateOnly, day, SESSIONS, fail } = require("./attendanceDomain");
const router = express.Router();
const action = fn => async (req, res) => {
  try { await fn(req, res); }
  catch (error) {
    const duplicate = error.name === "SequelizeUniqueConstraintError";
    const status = duplicate ? 409 : error.status || 500;
    res.status(status).json({
      message: duplicate ? "Attendance context already exists. Reload before correcting." : error.message,
      ...(status === 409 ? { code: "ATTENDANCE_CONFLICT", reviewRequired: true } : {}),
      ...(error.conflict ? { conflict: error.conflict } : {}),
    });
  }
};
router.use((req, res, next) => {
  if (!["SuperAdmin", "Director", "DeputyDirector", "StudentAffairs", "HeadDepartment", "AttendanceTaker", "Teacher"].includes(req.user.role)) return res.status(403).json({ message: "Attendance access required" });
  next();
});
router.get("/class-assignees", action(async (req, res) => {
  service.requireAdmin(req.user);
  res.json({ data: await service.models().User.findAll({ where: { role: "AttendanceTaker", isActive: true }, attributes: ["id", "fullName"] }) });
}));
router.get("/daily", action(async (req, res) => {
  const allowed = await service.scopes(req.user, "daily", req.query);
  const section = await service.sectionSelection(req.user, "daily", req.query, allowed);
  if (!allowed.length) return res.json({ data: [] });
  const M = service.models();
  const where = { [Op.or]: allowed.map(a => ({ classId: a.classId, academicYearId: a.academicYearId, termId: a.termId })) };
  if (req.query.attendanceDate) where.attendanceDate = new Date(`${dateOnly(req.query.attendanceDate)}T00:00:00Z`);
  if (section) where.studentId = { [Op.in]: section.studentIds };
  if (req.query.attendanceSession) { if (!SESSIONS.includes(req.query.attendanceSession)) fail("Invalid attendance session"); where.attendanceSession = req.query.attendanceSession; }
  const records = await M.DailyAttendance.findAll({ where });
  const students = await M.Student.findAll({ where: { id: { [Op.in]: [...new Set(records.map(r => r.studentId))] } } });
  const classes = await M.Class.findAll({ where: { id: { [Op.in]: [...new Set(records.map(r => r.classId))] } } });
  res.json({ data: records.map(r => ({ ...service.plain(r), studentId: students.filter(s => s.id === r.studentId).map(s => ({ id: s.id, fullName: s.fullName, admissionNo: s.admissionNo }))[0] || r.studentId, classId: classes.filter(c => c.id === r.classId).map(c => ({ id: c.id, name: c.name }))[0] || r.classId })) });
}));
router.get("/class-assignments", action(async (req, res) => {
  const M = service.models();
  const where = { isActive: true };
  if (!["SuperAdmin", "Director", "DeputyDirector", "StudentAffairs"].includes(req.user.role)) where.userId = req.user.id;
  if (req.query.academicYearId) where.academicYearId = id(req.query.academicYearId);
  const assignments = await M.AttendanceClassAssignment.findAll({ where });
  const classes = await M.Class.findAll();
  res.json({ data: assignments.map(a => ({ ...service.plain(a), className: classes.find(c => c.id === a.classId)?.name })) });
}));
router.post("/class-assignments", action(async (req, res) => {
  service.requireAdmin(req.user);
  const M = service.models();
  const values = Object.fromEntries(["userId", "classId", "academicYearId", "termId"].map(key => [key, id(req.body[key])]));
  const [user, classroom, term] = await Promise.all([M.User.findByPk(values.userId), M.Class.findByPk(values.classId), M.Term.findByPk(values.termId)]);
  if (user?.role !== "AttendanceTaker" || !user.isActive) fail("Select an active AttendanceTaker user");
  if (!classroom?.isActive || classroom.academicYearId !== values.academicYearId || term?.academicYearId !== values.academicYearId) fail("Class and term must belong to the selected academic year");
  const row = await sequelize.transaction(async transaction => {
    const [assignment] = await M.AttendanceClassAssignment.findOrCreate({ where: values, defaults: { isActive: true }, transaction });
    const before = service.plain(assignment);
    await assignment.update({ isActive: true }, { transaction });
    await M.AttendanceAudit.create({ kind: "class-assignment", recordId: assignment.id, actorId: req.user.id, reason: "Class assigned", before, after: service.plain(assignment) }, { transaction });
    return assignment;
  });
  res.status(201).json({ data: row });
}));
router.delete("/class-assignments/:id", action(async (req, res) => {
  service.requireAdmin(req.user);
  const M = service.models();
  await sequelize.transaction(async transaction => {
    const row = await M.AttendanceClassAssignment.findByPk(id(req.params.id), { transaction, lock: transaction.LOCK.UPDATE });
    if (!row) fail("Assignment not found", 404);
    const before = service.plain(row);
    await row.update({ isActive: false }, { transaction });
    await M.AttendanceAudit.create({ kind: "class-assignment", recordId: row.id, actorId: req.user.id, reason: "Class assignment revoked", before, after: service.plain(row) }, { transaction });
  });
  res.json({ message: "Assignment revoked" });
}));
for (const kind of ["daily", "lesson"]) {
  router.get(`/${kind}/sections`, action(async (req, res) => res.json({ data: await service.sections(req.user, kind, req.query) })));
  router.get(`/${kind}/scopes`, action(async (req, res) => {
    const rows = await service.scopes(req.user, kind, req.query, req.query.history === "1");
    const M = service.models();
    const [classes, subjects, teachers, terms, departments] = await Promise.all([M.Class.findAll(), M.Subject.findAll(), M.Teacher.findAll(), M.Term.findAll(), M.Department.findAll()]);
    res.json({ data: rows.map(r => ({ ...r, className: classes.find(c => c.id === r.classId)?.name, subjectName: subjects.find(s => s.id === r.subjectId)?.name, teacherName: teachers.find(t => t.id === r.teacherId)?.fullName, termName: terms.find(t => t.id === r.termId)?.name, departmentName: departments.find(d => d.id === r.departmentId)?.name })) });
  }));
  router.get(`/${kind}/roster`, action(async (req, res) => res.json({ data: await service.roster(req.user, kind, req.query) })));
  router.post(`/${kind}/mark`, action(async (req, res) => { const data = await service.mark(req.user, kind, req.body); res.json({ count: data.length, data }); }));
  router.get(`/${kind}/monthly`, action(async (req, res) => {
    const result = await service.report(req.user, kind, req.query);
    if (req.query.format === "xlsx") {
      const workbook = new (require("exceljs").Workbook)();
      const sheet = workbook.addWorksheet(kind === "daily" ? "Daily attendance" : "Subject lessons");
      sheet.addRow([result.formula]);
      sheet.addRow(["Academic year", req.query.academicYearId, "Month", req.query.month, "Filters", JSON.stringify(Object.fromEntries(Object.entries(req.query).filter(([k]) => k !== "format")))]);
      const keys = ["studentId", "fullName", "admissionNo", "classId", "className", "classSectionId", "sectionName", "termId", "termName", "subjectId", "subjectName", "recorded", "Present", "Absent", "Late", "Permission", "Free", "InternshipVisit", "eligible", "notTaken", "percentage", ...(kind === "daily" ? ["uniqueAbsentDates"] : []), "coverage"];
      sheet.addRow(keys);
      for (const row of result.data) sheet.addRow(keys.map(k => Array.isArray(row[k]) ? row[k].join(", ") : row[k] ?? "Unavailable"));
      for (const [name, rows] of [["Recorded details", result.details], ["Review differences", result.review], ["Monthly follow-up", result.followUp]]) {
        const tab = workbook.addWorksheet(name);
        const headings = [...new Set(rows.flatMap(r => Object.keys(r)))];
        tab.addRow(headings); rows.forEach(r => tab.addRow(headings.map(k => r[k] instanceof Date ? r[k].toISOString() : r[k] ?? "")));
      }
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename=${kind}-attendance-${req.query.month}.xlsx`);
      await workbook.xlsx.write(res); res.end(); return;
    }
    res.json(result);
  }));
}
router.get("/audit/:kind/:id", action(async (req, res) => {
  const { kind } = req.params;
  if (!["daily", "lesson"].includes(kind)) fail("Invalid kind");
  const recordId = id(req.params.id), M = service.models();
  const record = await (kind === "daily" ? M.DailyAttendance : M.Attendance).findByPk(recordId);
  if (!record) fail("Record not found", 404);
  const allowed = await service.scopes(req.user, kind, record);
  if (!allowed.some(a => a.classId === record.classId && (a.termId || null) === record.termId && (kind === "daily" || a.subjectId === record.subjectId))) fail("Attendance is outside your assignments", 403);
  res.json({ data: await M.AttendanceAudit.findAll({ where: { kind, recordId }, order: [["createdAt", "ASC"]] }) });
}));
// Import a complete, dated calendar and timetable snapshot for one class/month.
// Coverage is only declared after all calendar dates are explicitly accounted for.
router.post("/planning", action(async (req, res) => {
  service.requireAdmin(req.user);
  const { kind, month, source, calendar, entries } = req.body;
  if (!["daily", "lesson"].includes(kind) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month || "") || typeof source !== "string" || !source.trim()) fail("kind, month and calendar/timetable source are required");
  const academicYearId = id(req.body.academicYearId), termId = id(req.body.termId), classId = id(req.body.classId);
  const M = service.models();
  const [term, classroom] = await Promise.all([M.Term.findByPk(termId), M.Class.findByPk(classId)]);
  if (!term || term.academicYearId !== academicYearId || classroom?.academicYearId !== academicYearId) fail("Class and term must belong to the selected year");
  const days = new Date(Number(month.slice(0, 4)), Number(month.slice(5)), 0).getDate();
  if (!Array.isArray(calendar) || calendar.length !== days || new Set(calendar.map(c => c.date)).size !== days || !Array.isArray(entries)) fail("Provide every date in the month's school calendar and an entries array");
  for (const c of calendar) if (!dateOnly(c.date).startsWith(month) || typeof c.isSchoolDay !== "boolean") fail("Calendar must explicitly mark each date as a school day or closure");
  const assignments = await M.TeacherAssignment.findAll({ where: { academicYearId, termId, classId, isActive: true } });
  const rows = entries.map(e => {
    const date = dateOnly(e.date);
    if (!calendar.some(c => c.date === date && c.isSchoolDay) || date < day(term.startDate) || date > day(term.endDate)) fail("Expected sessions must be school days within the term");
    if (!SESSIONS.includes(e.session) || !e.endsAt || Number.isNaN(Date.parse(e.endsAt)) || !/(Z|[+-]\d\d:\d\d)$/.test(e.endsAt)) fail("A valid session and timezone-qualified endsAt are required");
    const localEndDate = new Date(Date.parse(e.endsAt) + 3 * 3600000).toISOString().slice(0, 10);
    if (localEndDate !== date) fail("Session end must fall on its school date in Africa/Nairobi");
    const lessonId = kind === "daily" ? "daily" : String(e.lessonId || "");
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(lessonId)) fail("Each lesson requires a distinct lessonId/period");
    const assignment = kind === "lesson" ? assignments.find(a => a.id === id(e.assignmentId)) : null;
    if (kind === "lesson" && !assignment) fail("Lesson assignment must match class, term and year");
    return { kind, academicYearId, termId, classId, date, session: e.session, lessonId, teacherAssignmentId: assignment?.id || null, endsAt: new Date(e.endsAt), isSchoolDay: true, source, contextKey: [kind, academicYearId, termId, classId, date, e.session, kind === "lesson" ? assignment.subjectId : "daily", lessonId].join(":") };
  });
  if (new Set(rows.map(r => r.contextKey)).size !== rows.length) fail("Duplicate expected contexts");
  const scope = { kind, academicYearId, termId, classId };
  const nextMonth = new Date(`${month}-01T00:00:00Z`); nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
  const dateRange = { [Op.gte]: `${month}-01`, [Op.lt]: day(nextMonth) };
  await sequelize.transaction(async transaction => {
    const before = (await M.AttendanceSchedule.findAll({ where: { ...scope, date: dateRange }, transaction })).map(service.plain);
    await M.AttendanceSchedule.destroy({ where: { ...scope, date: dateRange }, transaction });
    await M.AttendanceSchedule.bulkCreate(rows, { transaction });
    await M.AttendanceCoverage.upsert({ ...scope, month, source, contextKey: [kind, academicYearId, termId, classId, month].join(":") }, { transaction });
    await M.AttendanceAudit.create({ kind: "planning", recordId: classId, actorId: req.user.id, reason: source, before, after: { calendar, entries } }, { transaction });
  });
  res.json({ message: "Calendar and timetable coverage saved", count: rows.length });
}));
module.exports = router;

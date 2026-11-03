const Attendance = require("../models/Attendance");
const TeacherAssignment = require("../../teacherAssignments/models/TeacherAssignment");
const service = require("../attendanceService");
const { ADMINS, fail, dateOnly, id } = require("../attendanceDomain");
const { sequelize } = require("../../../config/mysql");
const populate = q => q.populate("studentId").populate("academicYearId").populate("termId").populate("classId").populate("departmentId").populate("subjectId").populate({ path: "takenBy", select: "-password" });
const action = fn => async (req, res) => {
  try { await fn(req, res); } catch (e) { res.status(e.name === "SequelizeUniqueConstraintError" ? 409 : e.status || 500).json({ message: e.name === "SequelizeUniqueConstraintError" ? "Attendance already exists. Reload before correcting." : e.message }); }
};
async function readFilters(req) {
  const filters = {};
  for (const k of ["studentId", "academicYearId", "termId", "classId", "departmentId", "subjectId"]) if (req.query[k]) filters[k] = id(req.query[k]);
  for (const k of ["status", "attendanceSession"]) if (req.query[k]) filters[k] = req.query[k];
  if (req.query.attendanceDate) {
    const start = new Date(`${dateOnly(req.query.attendanceDate)}T00:00:00Z`), end = new Date(start); end.setUTCDate(end.getUTCDate() + 1);
    filters.attendanceDate = { $gte: start, $lt: end };
  }
  if (["Teacher", "AttendanceTaker"].includes(req.user.role)) {
    const allowed = await service.scopes(req.user, "lesson", req.query);
    if (!allowed.length) filters.id = 0;
    else filters.$or = allowed.map(a => ({ classId: a.classId, academicYearId: a.academicYearId, termId: a.termId || null, subjectId: a.subjectId }));
  } else if (req.user.role === "HeadDepartment") {
    const departments = [req.user.departmentId, ...(Array.isArray(req.user.departmentIds) ? req.user.departmentIds : [])].map(Number).filter(Boolean);
    if (filters.departmentId && !departments.includes(filters.departmentId)) filters.id = 0;
    else filters.departmentId = { $in: departments };
  }
  return filters;
}
async function assignmentForInput(input, user) {
  if (input.assignmentId || input.teacherAssignmentId) return service.resolveScope(user, "lesson", { assignmentId: input.assignmentId || input.teacherAssignmentId });
  const filters = { classId: id(input.classId), subjectId: id(input.subjectId), academicYearId: id(input.academicYearId), isActive: true, termId: input.termId ? id(input.termId) : null };
  if (!ADMINS.includes(user.role)) {
    if (!["Teacher", "AttendanceTaker"].includes(user.role) || !user.teacherId) fail("Teacher assignment required", 403);
    filters.teacherId = user.teacherId;
  }
  const assignment = await TeacherAssignment.findOne(filters);
  if (!assignment) fail("No active teacher assignment matches this attendance context", 403);
  return assignment;
}
exports.getAttendanceAssignments = action(async (req, res) => {
  const where = { isActive: true };
  for (const k of ["academicYearId", "termId"]) if (req.query[k]) where[k] = id(req.query[k]);
  if (["Teacher", "AttendanceTaker"].includes(req.user.role)) {
    if (!req.user.teacherId) return res.json({ count: 0, data: [] });
    where.teacherId = req.user.teacherId;
  } else if (req.query.teacherId) where.teacherId = id(req.query.teacherId);
  if (req.user.role === "HeadDepartment") where.departmentId = { $in: [req.user.departmentId, ...(req.user.departmentIds || [])].map(Number).filter(Boolean) };
  const data = await TeacherAssignment.find(where).populate("teacherId").populate("subjectId").populate("classId").populate("departmentId").populate("academicYearId").populate("termId");
  res.json({ count: data.length, data });
});
exports.getAttendanceRoster = action(async (req, res) => res.json({ data: await service.roster(req.user, "lesson", req.query) }));
exports.markSubjectAttendance = action(async (req, res) => { const data = await service.mark(req.user, "lesson", req.body); res.json({ count: data.length, data }); });
exports.createAttendance = action(async (req, res) => {
  const assignment = await assignmentForInput(req.body, req.user);
  const data = await service.mark(req.user, "lesson", { ...req.body, assignmentId: assignment.id, date: String(req.body.attendanceDate || "").slice(0,10), session: req.body.attendanceSession, records: [req.body] });
  res.status(201).json({ data: data[0] });
});
exports.bulkAttendance = action(async (req, res) => {
  if (!Array.isArray(req.body.attendances) || !req.body.attendances.length || req.body.attendances.length > 2000) fail("A non-empty attendances array (maximum 2000) is required");
  const groups = new Map();
  for (const entry of req.body.attendances) {
    const assignment = await assignmentForInput(entry, req.user);
    const context = { assignmentId: assignment.id, date: String(entry.attendanceDate || "").slice(0,10), session: entry.attendanceSession || "BeforeBreak", lessonId: entry.lessonId || "legacy" };
    const groupKey = JSON.stringify(context);
    if (!groups.has(groupKey)) groups.set(groupKey, { ...context, records: [], correctionReason: req.body.correctionReason, versions: req.body.versions });
    groups.get(groupKey).records.push(entry);
  }
  const data = await sequelize.transaction(async transaction => {
    const result = [];
    for (const input of groups.values()) result.push(...await service.mark(req.user, "lesson", input, transaction));
    return result;
  });
  res.status(201).json({ count: data.length, data });
});
const read = field => action(async (req, res) => {
  const filters = await readFilters(req);
  if (field) filters[field] = id(req.params[field] || req.params.id);
  const data = await populate(Attendance.find(filters).sort({ attendanceDate: -1, createdAt: -1 }));
  res.json({ count: data.length, data });
});
exports.getAttendance = read();
exports.getAttendanceByClass = read("classId");
exports.getAttendanceByStudent = read("studentId");
exports.updateAttendance = action(async (req, res) => {
  const row = await Attendance.findById(id(req.params.id));
  if (!row) fail("Attendance not found", 404);
  if (!row.subjectId) fail("Unclassified historical records require administrator reconciliation", 409);
  const assignment = await assignmentForInput(row, req.user);
  const data = await service.mark(req.user, "lesson", { assignmentId: assignment.id, date: new Date(row.attendanceDate).toISOString().slice(0,10), session: row.attendanceSession, lessonId: row.lessonId, correctionReason: req.body.correctionReason, versions: req.body.versions, records: [{ studentId: row.studentId, status: req.body.status ?? row.status, remarks: req.body.remarks ?? row.remarks }] });
  res.json({ data: data[0] });
});
exports.deleteAttendance = (req, res) => res.status(405).json({ message: "Attendance cannot be deleted. Submit an audited correction." });
